/**
 * @file Routes one LSP client across a primary language server and any
 * number of diagnostics sidecars. The primary owns language features;
 * `initialize`/`shutdown` fan out to every backend and their replies are
 * merged; diagnostics from all backends are combined per URI so one
 * backend cannot erase another's findings.
 *
 * Crash isolation: a sidecar exit is survivable — its diagnostics are
 * cleared and it is dropped while the proxy keeps serving. A primary exit
 * ends the proxy with the primary's exit code. Any error attributed to a
 * sidecar (framing, routing, spawn, write) is likewise contained by
 * dropping that sidecar; the same error on the primary is fatal.
 */

import { Writable } from "node:stream";
import type { Readable } from "node:stream";
import { Backend, type BackendHandlers } from "./backend.js";
import type { BackendSpec } from "./config.js";
import { FrameDecoder, ProtocolError, encodePacket, type Message } from "./framing.js";
import { log } from "./log.js";

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

const SIDECAR_NOTIFICATIONS = new Set([
  "initialized",
  "$/setTrace",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didSave",
  "textDocument/didClose",
  "workspace/didChangeConfiguration",
  "workspace/didChangeWorkspaceFolders",
]);
const FANOUT_REQUESTS = new Set(["initialize", "shutdown"]);

type RpcId = string | number | null;

interface Fanout {
  readonly method: string;
  readonly identifier: RpcId;
  readonly responses: Map<number, Message>;
}

interface RoutedRequest {
  readonly backendIndex: number;
  readonly originalId: RpcId;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageId(message: Message): RpcId {
  const identifier = message.id;
  if (identifier === null) return null;
  if (typeof identifier === "boolean" || (typeof identifier !== "number" && typeof identifier !== "string")) {
    throw new ProtocolError("JSON-RPC id must be a string, number, or null");
  }
  return identifier;
}

function idKey(identifier: RpcId): string {
  if (identifier === null) return "null";
  return typeof identifier === "number" ? `n:${identifier}` : `s:${identifier}`;
}

function errorResponse(identifier: RpcId, code: number, message: string): Message {
  return { jsonrpc: "2.0", id: identifier, error: { code, message } };
}

function workspaceFolderCapability(response: Message): Record<string, unknown> | null {
  const result = response.result;
  if (!isObject(result)) return null;
  const capabilities = result.capabilities;
  if (!isObject(capabilities)) return null;
  const workspace = capabilities.workspace;
  if (!isObject(workspace)) return null;
  const folders = workspace.workspaceFolders;
  return isObject(folders) ? { ...folders } : null;
}

export class Multiplexer {
  private readonly backends: Backend[];
  private clientOut: Writable = new Writable();
  private readonly fanouts = new Map<string, Fanout>();
  private readonly clientRequests = new Map<string, RoutedRequest>();
  private readonly backendRequestIds = new Map<string, string>();
  private requestSequence = 0;
  private clientExited = false;
  private finished = false;
  private clientTail: Promise<void> = Promise.resolve();
  private resolveExit: (code: number) => void = () => undefined;

  constructor(
    specs: readonly BackendSpec[],
    private readonly serverInfo: ServerInfo,
  ) {
    this.backends = specs.map((spec, index) => new Backend(index, spec));
  }

  run(clientIn: Readable, clientOut: Writable): Promise<number> {
    this.clientOut = clientOut;
    return new Promise<number>((resolve) => {
      this.resolveExit = resolve;
      const handlers: BackendHandlers = {
        onMessage: (index, message) => this.handleBackend(index, message),
        onClosed: (index) => this.onBackendClosed(index),
        onError: (index, detail) => this.onBackendError(index, detail),
      };
      for (const backend of this.backends) backend.start(handlers);

      const decoder = new FrameDecoder("client");
      clientIn.on("data", (chunk: Buffer) => {
        if (this.finished) return;
        decoder.push(chunk);
        try {
          for (const message of decoder.drain()) this.enqueueClient(message);
        } catch (error) {
          this.onClientFatal(error);
        }
      });
      clientIn.on("end", () => this.onClientEnd());
      clientIn.on("error", (error) => this.onClientFatal(error));
    });
  }

  /** Signal-driven graceful stop; exits clean once backends are down. */
  requestStop(): void {
    this.finish(0);
  }

  private enqueueClient(message: Message): void {
    this.clientTail = this.clientTail
      .then(() => (this.finished ? undefined : this.handleClient(message)))
      .catch((error) => this.onClientFatal(error));
  }

  private activeBackends(): Backend[] {
    return this.backends.filter((backend) => !backend.dropped);
  }

  private sendClient(message: Message): void {
    this.clientOut.write(encodePacket(message));
  }

  private async broadcast(message: Message): Promise<void> {
    for (const backend of this.activeBackends()) await backend.send(message);
  }

  private async handleClient(message: Message): Promise<void> {
    if (!("method" in message)) {
      await this.routeClientResponse(message);
      return;
    }
    const method = message.method;
    if (typeof method !== "string") throw new ProtocolError("JSON-RPC method must be a string");

    if (method === "exit") {
      await this.broadcast(message);
      this.clientExited = true;
      this.finish(0);
      return;
    }

    if (FANOUT_REQUESTS.has(method)) {
      if (!("id" in message)) {
        await this.broadcast(message);
        return;
      }
      const identifier = messageId(message);
      const key = idKey(identifier);
      if (this.fanouts.has(key)) {
        this.sendClient(errorResponse(identifier, -32600, "duplicate request id"));
        return;
      }
      this.fanouts.set(key, { method, identifier, responses: new Map() });
      await this.broadcast(message);
      log(`client -> all: ${method}`);
      return;
    }

    if (SIDECAR_NOTIFICATIONS.has(method)) {
      await this.broadcast(message);
      log(`client -> all: ${method}`);
    } else {
      await this.backends[0].send(message);
      log(`client -> primary: ${method}`);
    }
  }

  private async routeClientResponse(message: Message): Promise<void> {
    if (!("id" in message)) throw new ProtocolError("JSON-RPC response is missing id");
    const exposedId = messageId(message);
    const key = typeof exposedId === "string" ? exposedId : idKey(exposedId);
    const route = this.clientRequests.get(key);
    this.clientRequests.delete(key);
    if (route === undefined) {
      log(`dropping response for unknown server request ${JSON.stringify(exposedId)}`);
      return;
    }
    this.backendRequestIds.delete(`${route.backendIndex}:${idKey(route.originalId)}`);
    const backend = this.backends[route.backendIndex];
    if (backend.dropped) {
      log(`dropping response for dropped backend ${backend.label}`);
      return;
    }
    await backend.send({ ...message, id: route.originalId });
    log(`client -> ${backend.label}: response`);
  }

  private handleBackend(index: number, message: Message): void {
    const backend = this.backends[index];
    if (backend.dropped) return;
    if (!("method" in message)) {
      this.handleBackendResponse(backend, message);
      return;
    }
    const method = message.method;
    if (typeof method !== "string") {
      throw new ProtocolError(`${backend.label}: JSON-RPC method must be a string`);
    }
    if (method === "textDocument/publishDiagnostics") {
      this.publishMergedDiagnostics(backend, message);
      return;
    }
    if (method === "$/cancelRequest") {
      this.forwardBackendCancellation(backend, message);
      return;
    }
    if ("id" in message) {
      this.forwardBackendRequest(backend, message);
      return;
    }
    this.sendClient(message);
    log(`${backend.label} -> client: ${method}`);
  }

  private handleBackendResponse(backend: Backend, message: Message): void {
    if (!("id" in message)) throw new ProtocolError(`${backend.label}: JSON-RPC response is missing id`);
    const identifier = messageId(message);
    const key = idKey(identifier);
    const fanout = this.fanouts.get(key);
    if (fanout !== undefined) {
      if (fanout.responses.has(backend.index)) {
        throw new ProtocolError(`${backend.label}: duplicate response for ${JSON.stringify(identifier)}`);
      }
      fanout.responses.set(backend.index, message);
      this.maybeCompleteFanout(key, fanout);
      return;
    }
    if (backend.index === 0) {
      this.sendClient(message);
      log(`primary -> client: response ${JSON.stringify(identifier)}`);
    } else {
      log(`dropping unexpected response from ${backend.label}`);
    }
  }

  private maybeCompleteFanout(key: string, fanout: Fanout): void {
    const active = this.activeBackends();
    if (!active.every((backend) => fanout.responses.has(backend.index))) return;
    this.fanouts.delete(key);
    this.sendClient(this.completeFanout(fanout));
    log(`all -> client: ${fanout.method} response`);
  }

  private completeFanout(fanout: Fanout): Message {
    const ordered = this.activeBackends().map(
      (backend) => fanout.responses.get(backend.index) as Message,
    );
    const failure = ordered.find((response) => "error" in response);
    if (failure !== undefined) return { ...failure, id: fanout.identifier };

    const primary: Message = { ...ordered[0], id: fanout.identifier };
    if (fanout.method !== "initialize") return primary;

    const result = primary.result;
    if (!isObject(result)) {
      return errorResponse(fanout.identifier, -32603, "primary initialize result is invalid");
    }
    const capabilitiesValue = result.capabilities ?? {};
    if (!isObject(capabilitiesValue)) {
      return errorResponse(fanout.identifier, -32603, "primary capabilities are invalid");
    }
    const capabilities: Record<string, unknown> = { ...capabilitiesValue };

    // The primary owns feature routing. Workspace-folder support is the
    // one sidecar capability the client must also see, so it emits folder
    // lifecycle notifications the sidecars depend on.
    let folders = workspaceFolderCapability(primary);
    for (const response of ordered.slice(1)) {
      const sidecarFolders = workspaceFolderCapability(response);
      if (sidecarFolders !== null) {
        folders = folders === null ? sidecarFolders : { ...folders, ...sidecarFolders };
      }
    }
    if (folders !== null) {
      const workspaceValue = capabilities.workspace;
      const workspace = isObject(workspaceValue) ? { ...workspaceValue } : {};
      workspace.workspaceFolders = folders;
      capabilities.workspace = workspace;
    }

    primary.result = { ...result, capabilities, serverInfo: { ...this.serverInfo } };
    return primary;
  }

  private publishMergedDiagnostics(backend: Backend, message: Message): void {
    const params = message.params;
    if (!isObject(params)) throw new ProtocolError(`${backend.label}: diagnostics params must be an object`);
    const uri = params.uri;
    const diagnostics = params.diagnostics;
    if (typeof uri !== "string" || !Array.isArray(diagnostics)) {
      throw new ProtocolError(`${backend.label}: invalid publishDiagnostics params`);
    }
    backend.diagnostics.set(uri, diagnostics);
    this.sendClient(this.mergedDiagnostics(uri, message));
    log(`${backend.label} -> client: merged diagnostics`);
  }

  private mergedDiagnostics(uri: string, base: Message): Message {
    const combined: unknown[] = [];
    for (const backend of this.activeBackends()) {
      const diagnostics = backend.diagnostics.get(uri);
      if (diagnostics) combined.push(...diagnostics);
    }
    const baseParams = isObject(base.params) ? base.params : {};
    return { ...base, params: { ...baseParams, uri, diagnostics: combined } };
  }

  private forwardBackendRequest(backend: Backend, message: Message): void {
    const originalId = messageId(message);
    const key = `${backend.index}:${idKey(originalId)}`;
    if (this.backendRequestIds.has(key)) {
      throw new ProtocolError(`${backend.label}: duplicate outgoing request id`);
    }
    this.requestSequence += 1;
    const exposedId = `safer-lsp:${backend.index}:${this.requestSequence}`;
    this.clientRequests.set(exposedId, { backendIndex: backend.index, originalId });
    this.backendRequestIds.set(key, exposedId);
    this.sendClient({ ...message, id: exposedId });
    log(`${backend.label} -> client: ${String(message.method)}`);
  }

  private forwardBackendCancellation(backend: Backend, message: Message): void {
    const params = message.params;
    if (!isObject(params) || !("id" in params)) {
      throw new ProtocolError(`${backend.label}: cancellation is missing a request id`);
    }
    const originalId = messageId(params as Message);
    const exposedId = this.backendRequestIds.get(`${backend.index}:${idKey(originalId)}`);
    if (exposedId === undefined) {
      log(`dropping cancellation for unknown request from ${backend.label}`);
      return;
    }
    this.sendClient({ ...message, params: { ...params, id: exposedId } });
  }

  private onBackendClosed(index: number): void {
    if (this.finished) return;
    const backend = this.backends[index];
    if (backend.dropped) return;
    if (backend.isPrimary) {
      if (!this.clientExited) log(`primary exited unexpectedly: ${backend.label}`);
      this.finish(backend.exitCode);
      return;
    }
    log(`sidecar exited: ${backend.label}`);
    this.dropBackend(backend);
  }

  private onBackendError(index: number, detail: string): void {
    if (this.finished) return;
    log(detail);
    const backend = this.backends[index];
    if (backend.dropped) return;
    if (backend.isPrimary) {
      this.finish(backend.exited ? backend.exitCode : 1);
      return;
    }
    this.dropBackend(backend);
  }

  private dropBackend(backend: Backend): void {
    if (backend.dropped) return;
    backend.dropped = true;
    backend.closeStdin();
    backend.terminate();
    const uris = [...backend.diagnostics.keys()];
    backend.diagnostics.clear();
    for (const uri of uris) {
      this.sendClient(
        this.mergedDiagnostics(uri, { jsonrpc: "2.0", method: "textDocument/publishDiagnostics" }),
      );
    }
    for (const [key, fanout] of [...this.fanouts]) this.maybeCompleteFanout(key, fanout);
  }

  private onClientEnd(): void {
    if (this.finished) return;
    void this.clientTail.then(() => this.finish(0));
  }

  private onClientFatal(error: unknown): void {
    if (this.finished) return;
    log(error instanceof Error ? error.message : String(error));
    this.finish(1);
  }

  private finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    void this.stopBackends().then(() => this.resolveExit(code));
  }

  private async stopBackends(): Promise<void> {
    for (const backend of this.backends) backend.closeStdin();
    const pending = this.backends.filter((backend) => !backend.exited);
    await this.waitFor(pending, 750);

    const afterClose = pending.filter((backend) => !backend.exited);
    for (const backend of afterClose) backend.terminate();
    await this.waitFor(afterClose, 750);

    const afterTerm = afterClose.filter((backend) => !backend.exited);
    for (const backend of afterTerm) backend.kill();
    await Promise.all(afterTerm.map((backend) => backend.waitExit()));
  }

  private waitFor(backends: Backend[], ms: number): Promise<void> {
    if (backends.length === 0) return Promise.resolve();
    const settled = Promise.all(backends.map((backend) => backend.waitExit())).then(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });
    return Promise.race([settled, timeout]);
  }
}
