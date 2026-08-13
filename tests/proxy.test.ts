/**
 * @file Protocol tests for the stdio LSP multiplexer. Framing and config
 * parsing are unit-tested against the built modules — by example and by
 * property — while routing, capability merge, fanout, crash isolation, and
 * sidecar backpressure are tested by spawning the real `safer-lsp-proxy` bin
 * with tiny `node -e` fake backends — the same integration shape the Python
 * suite used.
 */

import { Data, Effect, FastCheck as fc } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { parseBackendSpecs } from "../src/proxy/config.js";
import { encodePacket, FrameDecoder, type Message } from "../src/proxy/framing.js";
import { makeTempFile } from "./support/fixtures.js";

const PACKAGE_VERSION: string = (
  // package.json is the package's own manifest, so its `version` field is
  // guaranteed present whenever this test file resolves.
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/** Exit code the fake primary uses when it crashes, and the proxy must mirror. */
const PRIMARY_CRASH_EXIT_CODE = 17;

/** Exit code a proxy that saw `exit` after a clean run must report. */
const CLEAN_EXIT_CODE = 0;

const DEFAULT_MESSAGE_TIMEOUT_MS = 4000;
const COLLECT_LIMIT = 40;
const INTEGRATION_TIMEOUT_MS = 20_000;

/** Both backends answer, so a merged publish carries one diagnostic each. */
const MERGED_DIAGNOSTIC_COUNT = 2;
const SURVIVING_DIAGNOSTIC_COUNT = 1;
const BACKEND_COUNT = 2;

/** Volume that must overrun the sidecar's write buffer without stalling. */
const FLOOD_CHUNK_BYTES = 256 * 1024;
const FLOOD_MESSAGE_COUNT = 48;

// A fake language server driven entirely off stdin frames. Role "primary"
// answers hover and advertises hoverProvider; "sidecar" publishes
// diagnostics and workspace-folder support; "slowreader" answers
// initialize then stops reading so its stdin backs up. A didOpen for a
// `crash-<role>` URI makes that role exit (PRIMARY_CRASH_EXIT_CODE for
// primary, 0 otherwise).
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
    if (uri.indexOf("crash-" + role) !== -1) { process.exit(role === "primary" ? ${PRIMARY_CRASH_EXIT_CODE} : 0); }
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

/** No message arrived from the proxy before the wait window elapsed. */
class MessageTimeout extends Data.TaggedError("MessageTimeout")<{
  readonly timeoutMs: number;
  readonly framingError: string | null;
}> {}

/** The awaited message never appeared within the collection limit. */
class CollectExhausted extends Data.TaggedError("CollectExhausted")<{
  readonly limit: number;
}> {}

/** The proxy spoke during a window the protocol requires to stay silent. */
class UnexpectedMessage extends Data.TaggedError("UnexpectedMessage")<{
  readonly payload: Message;
}> {}

function backendSpec(role: string): { cmd: string; args: string[] } {
  return { cmd: process.execPath, args: ["-e", FAKE_BACKEND, role] };
}

class ProxyClient {
  readonly child: ChildProcess;
  stderr = "";
  /** Last stdout framing failure, reported with any timeout it caused. */
  framingError: string | null = null;
  private readonly decoder = new FrameDecoder("proxy-stdout");
  private readonly pending: Message[] = [];
  private readonly waiters: Array<{ resolve: (m: Message) => void; timer: NodeJS.Timeout }> = [];

  constructor(specs: Array<{ cmd: string; args: string[] }>) {
    const configPath = makeTempFile("lsp-proxy-", "backends.json", JSON.stringify(specs));
    this.child = spawn(process.execPath, ["dist/proxy/index.js", configPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk);
      try {
        for (const message of this.decoder.drain()) {this.deliver(message);}
      } catch (error) {
        // A framing failure starves every waiter, so keep it and hand it to
        // the timeout that it causes rather than losing the real reason.
        this.framingError = error instanceof Error ? error.message : String(error);
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  send(message: Message): void {
    this.child.stdin?.write(encodePacket(message));
  }

  /**
   * Collect until `count` messages satisfying `matches` have arrived.
   * @param matches Predicate identifying the messages being counted.
   * @param count How many matching messages end the collection.
   * @returns Every message seen, ending with the `count`-th match.
   */
  collectMatching(
    matches: (message: Message) => boolean,
    count: number,
  ): Effect.Effect<Message[], MessageTimeout | CollectExhausted> {
    return this.collectUntil(
      (message, all) => matches(message) && all.filter(matches).length === count,
    );
  }

  collectUntil(
    predicate: (message: Message, all: Message[]) => boolean,
    limit = COLLECT_LIMIT,
  ): Effect.Effect<Message[], MessageTimeout | CollectExhausted> {
    const nextMessage = (): Effect.Effect<Message, MessageTimeout> => this.next();
    return Effect.gen(function* () {
      const all: Message[] = [];
      for (let index = 0; index < limit; index += 1) {
        const message = yield* nextMessage();
        all.push(message);
        if (predicate(message, all)) {return all;}
      }
      return yield* new CollectExhausted({ limit });
    });
  }

  expectSilence(ms: number): Effect.Effect<void, UnexpectedMessage> {
    return Effect.matchEffect(this.next(ms), {
      onFailure: () => Effect.void,
      onSuccess: (payload) => Effect.fail(new UnexpectedMessage({ payload })),
    });
  }

  next(timeout = DEFAULT_MESSAGE_TIMEOUT_MS): Effect.Effect<Message, MessageTimeout> {
    return Effect.async<Message, MessageTimeout>((resume) => {
      const buffered = this.pending.shift();
      if (buffered !== undefined) {
        resume(Effect.succeed(buffered));
        return;
      }
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) {this.waiters.splice(index, 1);}
        resume(Effect.fail(
          new MessageTimeout({ timeoutMs: timeout, framingError: this.framingError }),
        ));
      }, timeout);
      this.waiters.push({ resolve: (message) => { resume(Effect.succeed(message)); }, timer });
    });
  }

  waitExit(): Effect.Effect<number> {
    return Effect.async<number>((resume) => {
      if (this.child.exitCode !== null) {
        resume(Effect.succeed(this.child.exitCode));
        return;
      }
      this.child.on("exit", (code) => { resume(Effect.succeed(code ?? -1)); });
    });
  }

  dispose(): void {
    if (this.child.exitCode === null) {this.child.kill("SIGKILL");}
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
}

let active: ProxyClient | undefined;
afterEach(() => {
  active?.dispose();
  active = undefined;
});

function frame(message: Message): Buffer {
  return encodePacket(message);
}

function isConfigurationRequest(message: Message): boolean {
  return message.method === "workspace/configuration";
}

function isLogMessage(message: Message): boolean {
  return message.method === "window/logMessage";
}

/**
 * Read the human-readable text of a `window/logMessage` notification.
 * @param message A notification already known to be `window/logMessage`.
 * @returns The `params.message` string the backend sent.
 */
function logText(message: Message): string {
  return (
    // `window/logMessage` params carry a string `message` field, and the fake
    // backends in this file are its only senders, so the shape is known.
    message.params as { message: string }
  ).message;
}

/**
 * Read the single configuration section a `workspace/configuration` asks for.
 * @param message A request already known to be `workspace/configuration`.
 * @returns The requested section name.
 */
function configurationSection(message: Message): string {
  return (
    // The fake backends' configuration request is generated with exactly one
    // item, so index 0 is known to exist.
    message.params as { items: Array<{ section: string }> }
  ).items[0].section;
}

/**
 * Read the URI a `textDocument/publishDiagnostics` notification is about.
 * @param message A notification already known to be publishDiagnostics.
 * @returns The document URI.
 */
function publishUri(message: Message): string {
  return (
    // publishDiagnostics names the URI whose diagnostics it replaces, so a
    // `uri` field is guaranteed on every such notification.
    message.params as { uri: string }
  ).uri;
}

/**
 * Read the diagnostics list of a publishDiagnostics notification.
 * @param message A notification already known to be publishDiagnostics.
 * @returns The diagnostics, each carrying the originating backend's name.
 */
function publishedDiagnostics(message: Message): Array<{ message: string }> {
  return (
    // The fake backends put their role in each entry's message, and a
    // diagnostics array is guaranteed on every publishDiagnostics.
    message.params as { diagnostics: Array<{ message: string }> }
  ).diagnostics;
}

/**
 * The message a `collectUntil` stopped on.
 * @param messages A non-empty collection ending on the awaited message.
 * @returns Its last element.
 */
function lastOf(messages: Message[]): Message {
  return messages[messages.length - 1];
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

  it("reassembles any frame cut at any byte, including non-ASCII bodies", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 20 }),
        fc.nat(),
        (text, splitSeed) => {
          const message: Message = { jsonrpc: "2.0", id: 3, method: "textDocument/didOpen", text };
          const packet = frame(message);
          const decoder = new FrameDecoder("test");
          const split = splitSeed % (packet.length + 1);
          decoder.push(packet.subarray(0, split));
          decoder.push(packet.subarray(split));
          // Content-Length counts UTF-8 bytes rather than characters, so the
          // decoder must rebuild the same object from any chunk boundary.
          expect([...decoder.drain()]).toEqual([message]);
        },
      ),
    );
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

  it("maps every accepted entry to argv with cmd first, in config order", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cmd: fc.string({ minLength: 1 }),
            args: fc.array(fc.string(), { maxLength: 4 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (entries) => {
          // argv is exactly [cmd, ...args] for every entry and config order is
          // preserved, which is what keeps index 0 the primary backend.
          expect(parseBackendSpecs(entries).map(({ argv }) => argv)).toEqual(
            entries.map(({ cmd, args }) => [cmd, ...args]),
          );
        },
      ),
    );
  });
});

describe("multiplexing primary and diagnostics sidecar", () => {
  it("merges capabilities, routes requests, fans out notifications, sequences shutdown", () =>
    Effect.runPromise(Effect.gen(function* () {
      active = new ProxyClient([backendSpec("primary"), backendSpec("sidecar")]);
      const client = active;

      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {}, workspaceFolders: [] } });
      const initialize = yield* client.next();
      expect(initialize.id).toBe(1);
      const result = (
        // The proxy assembles one merged envelope from its backends, so a
        // reply to `initialize` is guaranteed to carry `result`.
        initialize.result as { serverInfo: unknown; capabilities: Record<string, unknown> }
      );
      // The proxy presents itself, not a backend: clients must never see
      // through to the multiplexed servers.
      expect(result.serverInfo).toEqual({ name: "safer-lsp-proxy", version: PACKAGE_VERSION });
      // hoverProvider comes from the primary and workspaceFolders from the
      // sidecar, so a merged capability set carries both.
      expect(result.capabilities.hoverProvider).toBe(true);
      const workspace = (
        // The sidecar advertised workspace-folder support, so the merged
        // capabilities are guaranteed to carry the nested object.
        result.capabilities.workspace as { workspaceFolders: { supported: boolean } }
      );
      expect(workspace.workspaceFolders.supported).toBe(true);

      client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
      const configRequests = yield* client.collectMatching(isConfigurationRequest, BACKEND_COUNT);
      const routed = configRequests.filter(isConfigurationRequest);
      // Each backend's request reaches the client under its own id, so the
      // client's reply can be routed back to the backend that asked.
      expect(new Set(routed.map((item) => item.id)).size).toBe(BACKEND_COUNT);
      for (const request of routed) {
        client.send({ jsonrpc: "2.0", id: request.id, result: [configurationSection(request)] });
      }
      const routedLogs = yield* client.collectMatching(
        (message) => isLogMessage(message) && logText(message).includes("response routed: true"),
        BACKEND_COUNT,
      );
      // Both backends confirm they received their own section back, which is
      // the only evidence the id remap was inverted correctly.
      expect(new Set(routedLogs.filter(isLogMessage).map(logText))).toEqual(
        new Set(["primary response routed: true", "sidecar response routed: true"]),
      );

      const uri = "file:///tmp/example.ts";
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "typescript", version: 1, text: "const value = 1;" } },
      });
      const diagnostics = yield* client.collectUntil(
        (message) =>
          message.method === "textDocument/publishDiagnostics" &&
          publishedDiagnostics(message).length === MERGED_DIAGNOSTIC_COUNT,
      );
      // Diagnostics from both backends are merged into one publish per URI,
      // in backend order, rather than the second replacing the first.
      expect(publishedDiagnostics(lastOf(diagnostics)).map((d) => d.message)).toEqual(
        ["primary", "sidecar"],
      );

      client.send({
        jsonrpc: "2.0",
        id: 0,
        method: "textDocument/hover",
        params: { textDocument: { uri }, position: { line: 0, character: 1 } },
      });
      const hover = yield* client.next();
      // Only the primary answers a request; the sidecar's reply must never
      // reach the client, so nothing follows the hover result.
      expect(hover).toEqual({ jsonrpc: "2.0", id: 0, result: { contents: "primary hover" } });
      yield* client.expectSilence(150);

      client.send({
        jsonrpc: "2.0",
        method: "workspace/didChangeWorkspaceFolders",
        params: { event: { added: [], removed: [] } },
      });
      const folderLogs = yield* client.collectMatching(
        (message) => isLogMessage(message) && logText(message).includes("received folders"),
        BACKEND_COUNT,
      );
      // Notifications fan out to every backend, unlike requests, so both
      // report having seen the folder change.
      expect(new Set(folderLogs.filter(isLogMessage).map(logText))).toEqual(
        new Set(["primary received folders", "sidecar received folders"]),
      );

      client.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
      const shutdown = yield* client.next();
      // The sidecar replies 50ms late, so a single shutdown result proves the
      // proxy waited for every backend before answering.
      expect(shutdown).toEqual({ jsonrpc: "2.0", id: 3, result: null });
      client.send({ jsonrpc: "2.0", method: "exit" });
      expect(yield* client.waitExit()).toBe(CLEAN_EXIT_CODE);
    })), INTEGRATION_TIMEOUT_MS);
});

describe("crash isolation", () => {
  it("survives a sidecar exit and clears its stale diagnostics", () =>
    Effect.runPromise(Effect.gen(function* () {
      active = new ProxyClient([backendSpec("primary"), backendSpec("sidecar")]);
      const client = active;

      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
      yield* client.next();

      const uri = "file:///tmp/live.ts";
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "typescript", version: 1, text: "x" } },
      });
      yield* client.collectUntil(
        (message) =>
          message.method === "textDocument/publishDiagnostics" &&
          publishUri(message) === uri &&
          publishedDiagnostics(message).length === MERGED_DIAGNOSTIC_COUNT,
      );

      // A didOpen for the sidecar's crash URI kills only the sidecar.
      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///crash-sidecar.ts", languageId: "typescript", version: 1, text: "x" } },
      });
      const cleared = yield* client.collectUntil(
        (message) =>
          message.method === "textDocument/publishDiagnostics" &&
          publishUri(message) === uri &&
          publishedDiagnostics(message).length === SURVIVING_DIAGNOSTIC_COUNT,
      );
      // The dead backend's diagnostics are retracted for every URI it had
      // published, leaving exactly the surviving backend's findings.
      expect(publishedDiagnostics(lastOf(cleared)).map((d) => d.message)).toEqual(["primary"]);

      // Primary still answers after the sidecar is gone.
      client.send({
        jsonrpc: "2.0",
        id: 5,
        method: "textDocument/hover",
        params: { textDocument: { uri }, position: { line: 0, character: 0 } },
      });
      const hover = yield* client.next();
      expect(hover).toEqual({ jsonrpc: "2.0", id: 5, result: { contents: "primary hover" } });
      // A sidecar crash is survivable, so the proxy itself must still be up.
      expect(client.child.exitCode).toBeNull();

      client.send({ jsonrpc: "2.0", method: "exit" });
      expect(yield* client.waitExit()).toBe(CLEAN_EXIT_CODE);
    })), INTEGRATION_TIMEOUT_MS);

  it("exits with the primary's code when the primary dies", () =>
    Effect.runPromise(Effect.gen(function* () {
      active = new ProxyClient([backendSpec("primary"), backendSpec("sidecar")]);
      const client = active;

      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
      yield* client.next();

      client.send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: { textDocument: { uri: "file:///crash-primary.ts", languageId: "typescript", version: 1, text: "x" } },
      });
      // Losing the primary is fatal, and the host learns why from the exit
      // code: the proxy mirrors the primary's rather than inventing one.
      expect(yield* client.waitExit()).toBe(PRIMARY_CRASH_EXIT_CODE);
    })), INTEGRATION_TIMEOUT_MS);
});

describe("sidecar backpressure", () => {
  it("drops sidecar writes past the buffer bound without stalling the client", () =>
    Effect.runPromise(Effect.gen(function* () {
      active = new ProxyClient([backendSpec("primary"), backendSpec("slowreader")]);
      const client = active;

      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } });
      yield* client.next();

      const text = "x".repeat(FLOOD_CHUNK_BYTES);
      for (let version = 0; version < FLOOD_MESSAGE_COUNT; version += 1) {
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
      const hover = yield* client.next();
      expect(hover).toEqual({ jsonrpc: "2.0", id: 9, result: { contents: "primary hover" } });
      // Dropping is deliberate and reported, not silent data loss.
      expect(client.stderr).toMatch(/backpressured, dropping/);

      client.send({ jsonrpc: "2.0", method: "exit" });
      expect(yield* client.waitExit()).toBe(CLEAN_EXIT_CODE);
    })), INTEGRATION_TIMEOUT_MS);
});
