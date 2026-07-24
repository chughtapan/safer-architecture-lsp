/**
 * @file Protocol tests for the stdio LSP multiplexer. Framing and config
 * parsing are unit-tested against the built modules; routing, capability
 * merge, fanout, crash isolation, and sidecar backpressure are tested by
 * spawning the real `safer-lsp-proxy` bin with tiny `node -e` fake
 * backends — the same integration shape the Python suite used.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { FrameDecoder, encodePacket, type Message } from "../dist/proxy/framing.js";
import { parseBackendSpecs } from "../dist/proxy/config.js";

const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

// A fake language server driven entirely off stdin frames. Role "primary"
// answers hover and advertises hoverProvider; "sidecar" publishes
// diagnostics and workspace-folder support; "slowreader" answers
// initialize then stops reading so its stdin backs up. A didOpen for a
// `crash-<role>` URI makes that role exit (17 for primary, 0 otherwise).
const FAKE_BACKEND = String.raw`
const role = process.argv[1] || "primary";
let buf = Buffer.alloc(0);
let expected = null;
let stopped = false;
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body]));
}
function handle(msg) {
  const method = msg.method;
  if (method === "initialize") {
    const caps = role === "primary"
      ? { hoverProvider: true, textDocumentSync: { openClose: true, change: 2, save: { includeText: false } } }
      : { textDocumentSync: { openClose: true, change: 2, save: { includeText: false } }, workspace: { workspaceFolders: { supported: true, changeNotifications: true } } };
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: caps, serverInfo: { name: role } } });
    if (role === "slowreader") { stopped = true; process.stdin.pause(); setInterval(() => {}, 1 << 30); }
  } else if (method === "initialized") {
    send({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: { items: [{ section: role }] } });
  } else if (method === "textDocument/didOpen") {
    const uri = msg.params.textDocument.uri;
    if (uri.indexOf("crash-" + role) !== -1) { process.exit(role === "primary" ? 17 : 0); }
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ message: role }] } });
  } else if (method === "textDocument/didChange") {
    // volume-only; no reply
  } else if (method === "textDocument/hover") {
    if (role === "primary") send({ jsonrpc: "2.0", id: msg.id, result: { contents: "primary hover" } });
    else send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 1, message: "sidecar received hover" } });
  } else if (method === "workspace/didChangeWorkspaceFolders") {
    send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: role + " received folders" } });
  } else if (method === "shutdown") {
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: null });
    if (role === "sidecar") setTimeout(reply, 50); else reply();
  } else if (method === "exit") {
    process.exit(0);
  } else if (method === undefined && msg.id === 7) {
    const accepted = JSON.stringify(msg.result) === JSON.stringify([role]);
    send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: role + " response routed: " + accepted } });
  }
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    if (expected === null) {
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.slice(0, i).toString("ascii"));
      expected = m ? parseInt(m[1], 10) : 0;
      buf = buf.slice(i + 4);
    }
    if (buf.length < expected) return;
    const body = buf.slice(0, expected);
    buf = buf.slice(expected);
    expected = null;
    let msg;
    try { msg = JSON.parse(body.toString("utf8")); } catch { continue; }
    handle(msg);
    if (stopped) return;
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function backendSpec(role: string): { cmd: string; args: string[] } {
  return { cmd: process.execPath, args: ["-e", FAKE_BACKEND, role] };
}

class ProxyClient {
  readonly child: ChildProcess;
  stderr = "";
  private readonly decoder = new FrameDecoder("proxy-stdout");
  private readonly pending: Message[] = [];
  private readonly waiters: Array<{ resolve: (m: Message) => void; timer: NodeJS.Timeout }> = [];

  constructor(specs: Array<{ cmd: string; args: string[] }>) {
    const dir = mkdtempSync(join(tmpdir(), "lsp-proxy-"));
    const configPath = join(dir, "backends.json");
    writeFileSync(configPath, JSON.stringify(specs), "utf8");
    this.child = spawn(process.execPath, ["dist/proxy/index.js", configPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk);
      try {
        for (const message of this.decoder.drain()) this.deliver(message);
      } catch {
        // stdout framing errors are surfaced by whatever assertion is waiting
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  private deliver(message: Message): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      this.pending.push(message);
    }
  }

  send(message: Message): void {
    this.child.stdin?.write(encodePacket(message));
  }

  next(timeout = 4000): Promise<Message> {
    const buffered = this.pending.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timeout waiting for proxy message"));
      }, timeout);
      this.waiters.push({ resolve, timer });
    });
  }

  async collectUntil(
    predicate: (message: Message, all: Message[]) => boolean,
    limit = 40,
  ): Promise<Message[]> {
    const all: Message[] = [];
    for (let i = 0; i < limit; i += 1) {
      const message = await this.next();
      all.push(message);
      if (predicate(message, all)) return all;
    }
    throw new Error("expected proxy message was not observed");
  }

  async expectSilence(ms: number): Promise<void> {
    try {
      const message = await this.next(ms);
      throw new Error(`unexpected proxy message: ${JSON.stringify(message)}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("timeout")) return;
      throw error;
    }
  }

  waitExit(): Promise<number> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    return new Promise((resolve) => this.child.on("exit", (code) => resolve(code ?? -1)));
  }

  dispose(): void {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}

let active: ProxyClient | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
});

function frame(message: Message): Buffer {
  return encodePacket(message);
}

describe("frame decoding", () => {
  it("reassembles a frame split across chunks", () => {
    const decoder = new FrameDecoder("test");
    const packet = frame({ jsonrpc: "2.0", id: 1, method: "ping" });
    decoder.push(packet.subarray(0, 12));
    expect([...decoder.drain()]).toEqual([]);
    decoder.push(packet.subarray(12));
    expect([...decoder.drain()]).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  });

  it("splits two coalesced frames in a single chunk", () => {
    const decoder = new FrameDecoder("test");
    decoder.push(Buffer.concat([frame({ id: 1 }), frame({ id: 2 })]));
    expect([...decoder.drain()]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("carries a partial body across a header boundary", () => {
    const decoder = new FrameDecoder("test");
    const packet = frame({ method: "textDocument/didOpen", value: "abc" });
    const headerEnd = packet.indexOf("\r\n\r\n") + 4;
    decoder.push(packet.subarray(0, headerEnd + 2));
    expect([...decoder.drain()]).toEqual([]);
    decoder.push(packet.subarray(headerEnd + 2));
    expect([...decoder.drain()]).toEqual([{ method: "textDocument/didOpen", value: "abc" }]);
  });

  it("rejects a non-object JSON-RPC payload", () => {
    const decoder = new FrameDecoder("test");
    const body = Buffer.from("[1,2,3]", "utf8");
    decoder.push(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    expect(() => [...decoder.drain()]).toThrow(/must be an object/);
  });
});

describe("backend configuration", () => {
  it("accepts the {cmd, args} shape and defaults args to empty", () => {
    const specs = parseBackendSpecs([{ cmd: "server-a" }, { cmd: "server-b", args: ["--stdio"] }]);
    expect(specs[0].argv).toEqual(["server-a"]);
    expect(specs[1].argv).toEqual(["server-b", "--stdio"]);
  });

  it("rejects unsupported fields", () => {
    expect(() => parseBackendSpecs([{ cmd: "server", port: 9999 }])).toThrow(/unsupported fields/);
  });

  it("rejects an empty configuration", () => {
    expect(() => parseBackendSpecs([])).toThrow(/non-empty/);
  });

  it("rejects non-string args", () => {
    expect(() => parseBackendSpecs([{ cmd: "server", args: [1] }])).toThrow(/array of strings/);
  });
});

describe("multiplexing primary and diagnostics sidecar", () => {
  it("merges capabilities, routes requests, fans out notifications, sequences shutdown", async () => {
    active = new ProxyClient([backendSpec("primary"), backendSpec("sidecar")]);
    const client = active;

    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {}, workspaceFolders: [] } });
    const initialize = await client.next();
    expect(initialize.id).toBe(1);
    const result = initialize.result as { serverInfo: unknown; capabilities: Record<string, unknown> };
    expect(result.serverInfo).toEqual({ name: "safer-lsp-proxy", version: PACKAGE_VERSION });
    expect(result.capabilities.hoverProvider).toBe(true);
    expect((result.capabilities.workspace as { workspaceFolders: { supported: boolean } }).workspaceFolders.supported).toBe(true);

    client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const configRequests = await client.collectUntil(
      (_m, all) => all.filter((item) => item.method === "workspace/configuration").length === 2,
    );
    const routed = configRequests.filter((item) => item.method === "workspace/configuration");
    expect(new Set(routed.map((item) => item.id)).size).toBe(2);
    for (const request of routed) {
      const section = (request.params as { items: Array<{ section: string }> }).items[0].section;
      client.send({ jsonrpc: "2.0", id: request.id as string, result: [section] });
    }
    const routedLogs = await client.collectUntil(
      (_m, all) =>
        all.filter(
          (item) =>
            item.method === "window/logMessage" &&
            String((item.params as { message: string }).message).includes("response routed: true"),
        ).length === 2,
    );
    expect(
      new Set(
        routedLogs
          .filter((item) => item.method === "window/logMessage")
          .map((item) => (item.params as { message: string }).message),
      ),
    ).toEqual(new Set(["primary response routed: true", "sidecar response routed: true"]));

    const uri = "file:///tmp/example.ts";
    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "typescript", version: 1, text: "const value = 1;" } },
    });
    const diagnostics = await client.collectUntil(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        (message.params as { diagnostics: unknown[] }).diagnostics.length === 2,
    );
    const merged = (diagnostics[diagnostics.length - 1].params as { diagnostics: Array<{ message: string }> }).diagnostics;
    expect(merged.map((d) => d.message)).toEqual(["primary", "sidecar"]);

    client.send({
      jsonrpc: "2.0",
      id: 0,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line: 0, character: 1 } },
    });
    const hover = await client.next();
    expect(hover).toEqual({ jsonrpc: "2.0", id: 0, result: { contents: "primary hover" } });
    await client.expectSilence(150);

    client.send({
      jsonrpc: "2.0",
      method: "workspace/didChangeWorkspaceFolders",
      params: { event: { added: [], removed: [] } },
    });
    const folderLogs = await client.collectUntil(
      (_m, all) =>
        all.filter(
          (item) =>
            item.method === "window/logMessage" &&
            String((item.params as { message: string }).message).includes("received folders"),
        ).length === 2,
    );
    expect(
      new Set(
        folderLogs
          .filter((item) => item.method === "window/logMessage")
          .map((item) => (item.params as { message: string }).message),
      ),
    ).toEqual(new Set(["primary received folders", "sidecar received folders"]));

    client.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
    const shutdown = await client.next();
    expect(shutdown).toEqual({ jsonrpc: "2.0", id: 3, result: null });
    client.send({ jsonrpc: "2.0", method: "exit" });
    expect(await client.waitExit()).toBe(0);
  }, 20_000);
});

describe("crash isolation", () => {
  it("survives a sidecar exit and clears its stale diagnostics", async () => {
    active = new ProxyClient([backendSpec("primary"), backendSpec("sidecar")]);
    const client = active;

    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await client.next();

    const uri = "file:///tmp/live.ts";
    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri, languageId: "typescript", version: 1, text: "x" } },
    });
    await client.collectUntil(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        (message.params as { uri: string; diagnostics: unknown[] }).uri === uri &&
        (message.params as { diagnostics: unknown[] }).diagnostics.length === 2,
    );

    // A didOpen for the sidecar's crash URI kills only the sidecar.
    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///crash-sidecar.ts", languageId: "typescript", version: 1, text: "x" } },
    });
    const cleared = await client.collectUntil(
      (message) =>
        message.method === "textDocument/publishDiagnostics" &&
        (message.params as { uri: string }).uri === uri &&
        (message.params as { diagnostics: unknown[] }).diagnostics.length === 1,
    );
    const remaining = (cleared[cleared.length - 1].params as { diagnostics: Array<{ message: string }> }).diagnostics;
    expect(remaining.map((d) => d.message)).toEqual(["primary"]);

    // Primary still answers after the sidecar is gone.
    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line: 0, character: 0 } },
    });
    const hover = await client.next();
    expect(hover).toEqual({ jsonrpc: "2.0", id: 5, result: { contents: "primary hover" } });
    expect(client.child.exitCode).toBeNull();

    client.send({ jsonrpc: "2.0", method: "exit" });
    expect(await client.waitExit()).toBe(0);
  }, 20_000);

  it("exits with the primary's code when the primary dies", async () => {
    active = new ProxyClient([backendSpec("primary"), backendSpec("sidecar")]);
    const client = active;

    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await client.next();

    client.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///crash-primary.ts", languageId: "typescript", version: 1, text: "x" } },
    });
    expect(await client.waitExit()).toBe(17);
  }, 20_000);
});

describe("sidecar backpressure", () => {
  it("drops sidecar writes past the buffer bound without stalling the client", async () => {
    active = new ProxyClient([backendSpec("primary"), backendSpec("slowreader")]);
    const client = active;

    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
    await client.next();

    const text = "x".repeat(256 * 1024);
    for (let version = 0; version < 48; version += 1) {
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: { textDocument: { uri: "file:///big.ts", version }, contentChanges: [{ text }] },
      });
    }

    // The client loop never stalls: the primary still answers a request
    // sent right after the flood.
    client.send({
      jsonrpc: "2.0",
      id: 9,
      method: "textDocument/hover",
      params: { textDocument: { uri: "file:///big.ts" }, position: { line: 0, character: 0 } },
    });
    const hover = await client.next();
    expect(hover).toEqual({ jsonrpc: "2.0", id: 9, result: { contents: "primary hover" } });
    expect(client.stderr).toMatch(/backpressured, dropping/);

    client.send({ jsonrpc: "2.0", method: "exit" });
    expect(await client.waitExit()).toBe(0);
  }, 20_000);
});
