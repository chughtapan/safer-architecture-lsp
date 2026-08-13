/**
 * @file Full stdio LSP session against the built bin: initialize with a
 * real workspace, receive publishDiagnostics for a genuine finding,
 * then edit safer-architecture.config.json and observe the workspace
 * hot-reload change the published result — the 2am-Friday test.
 */

import { Data, Effect } from "effect";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { type Fixture, makeFixture, writeFixtureFile } from "./support/fixtures.js";

const BIN = path.resolve("dist/server/index.js");

const DEFAULT_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 100;
const SESSION_TIMEOUT_MS = 180_000;

/** Exit code a server that saw `shutdown` then `exit` must report. */
const CLEAN_EXIT_CODE = 0;

/** Diagnostic codes the two sessions must publish. */
const INVALID_CONFIG_CODE = "invalid-config";
const PACKAGE_CYCLE_CODE = "no-workspace-package-cycle";
const SUBPATH_EXPORT_CODE = "no-internal-subpath-export";

let fixture: Fixture | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

/** A probe never produced a value before its window elapsed. */
class WaitTimeout extends Data.TaggedError("WaitTimeout")<{
  readonly label: string;
  readonly timeoutMs: number;
}> {}

afterEach(() => {
  child?.kill("SIGKILL");
  child = null;
  fixture?.cleanup();
  fixture = null;
});

function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

interface LspMessage {
  readonly method?: string;
  readonly id?: number;
  readonly params?: { uri?: string; diagnostics?: ReadonlyArray<{ code?: unknown }> };
}

/** Incremental Content-Length decoder over the child's stdout. */
class MessageCollector {
  private buffer = Buffer.alloc(0);
  readonly messages: LspMessage[] = [];

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {return;}
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {throw new Error(`bad LSP header: ${header}`);}
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) {return;}
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.messages.push(
        // The decoder only reaches here with a whole Content-Length body, and
        // the child speaks JSON-RPC, so the parsed shape is guaranteed.
        JSON.parse(body) as LspMessage,
      );
      this.buffer = this.buffer.subarray(bodyStart + length);
    }
  }
}

/**
 * Poll `probe` until it yields a value.
 * @param probe Reader over the collected messages; `undefined` means not yet.
 * @param label What is being waited for, used in the timeout error.
 * @param timeoutMs How long to keep polling before failing.
 * @returns The first defined value the probe produced.
 */
function waitFor<T>(
  probe: () => T | undefined,
  label: string,
  timeoutMs = DEFAULT_WAIT_MS,
): Effect.Effect<T, WaitTimeout> {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let value = probe();
    while (value === undefined) {
      if (Date.now() > deadline) {return yield* new WaitTimeout({ label, timeoutMs });}
      yield* Effect.sleep(POLL_INTERVAL_MS);
      value = probe();
    }
    return value;
  });
}

it("publishes real diagnostics over a full session and hot-reloads config edits", () =>
  Effect.runPromise(Effect.gen(function* () {
    fixture = makeFixture({
      "alpha/index.ts":
        'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
      "beta/index.ts":
        'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
    });
    const root = fixture.root;

    child = spawn(process.execPath, [BIN, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
    const collector = new MessageCollector();
    child.stdout.on("data", (chunk: Buffer) => { collector.push(chunk); });
    const stderrLines: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrLines.push(chunk.toString("utf8")));

    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: null,
          capabilities: {},
          workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: "fixture" }],
        },
      }),
    );
    yield* waitFor(
      () => collector.messages.find((m) => m.id === 1),
      "initialize response",
    );
    child.stdin.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));

    // The initial publish happens on registration — no didOpen required
    // (agents need findings for files nobody opened).
    const alphaUri = pathToFileURL(path.join(root, "alpha", "index.ts")).toString();
    const cyclePublish = yield* waitFor(
      () =>
        collector.messages.find(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.uri === alphaUri &&
            (m.params.diagnostics ?? []).length > 0,
        ),
      "diagnostics for alpha/index.ts",
    );
    // alpha and beta import each other, so the module cycle must reach the
    // client without any file being opened.
    expect(cyclePublish.params?.diagnostics?.length).toBeGreaterThan(0);

    // Hot reload: an (invalid) config edit must surface a diagnostic on
    // the config file itself — proving the watcher rebuilt the workspace.
    const configPath = writeFixtureFile(
      root,
      "safer-architecture.config.json",
      "{ definitely not json",
    );
    const configUri = pathToFileURL(configPath).toString();
    const configPublish = yield* waitFor(
      () =>
        collector.messages.find(
          (m) =>
            m.method === "textDocument/publishDiagnostics" &&
            m.params?.uri === configUri &&
            (m.params.diagnostics ?? []).some((d) => d.code === INVALID_CONFIG_CODE),
        ),
      "invalid-config diagnostic after hot reload",
    );
    // The diagnostic lands on the config file rather than on a source file,
    // which is what tells the editor where the broken input actually is.
    expect(configPublish).toBeDefined();

    // Protocol teardown: shutdown then exit ends the process with code 0.
    child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }));
    yield* waitFor(() => collector.messages.find((m) => m.id === 2), "shutdown response");
    let exitCode: number | null | undefined;
    child.on("exit", (code) => { exitCode = code; });
    child.stdin.write(frame({ jsonrpc: "2.0", method: "exit", params: null }));
    const code = yield* waitFor(() => exitCode, "child exit");
    // A clean `shutdown` then `exit` is a normal termination; any other code
    // would mean the server treated teardown as a failure.
    expect(code).toBe(CLEAN_EXIT_CODE);
  })), SESSION_TIMEOUT_MS);

it("expands an explicit workspace and publishes package-cycle diagnostics", () =>
  Effect.runPromise(Effect.gen(function* () {
    const packageTsconfig = JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    });
    fixture = makeFixture({
      "packages/a/tsconfig.json": packageTsconfig,
      "packages/a/package.json": JSON.stringify({
        name: "@fixture/a",
        dependencies: { "@fixture/b": "workspace:*" },
        exports: { "./*": "./src/*.ts" },
      }),
      "packages/b/src/index.ts": "export const b = 1;\n",
      "packages/b/tsconfig.json": packageTsconfig,
      "packages/b/package.json": JSON.stringify({
        name: "@fixture/b",
        dependencies: { "@fixture/a": "workspace:*" },
      }),
      "safer-architecture.workspace.json": JSON.stringify({
        packages: ["packages/b", "packages/a"],
      }),
    });
    const root = fixture.root;

    child = spawn(process.execPath, [BIN, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
    const collector = new MessageCollector();
    child.stdout.on("data", (chunk: Buffer) => { collector.push(chunk); });
    child.stdin.write(frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: "workspace" }],
      },
    }));
    yield* waitFor(() => collector.messages.find((message) => message.id === 1), "initialize response");
    child.stdin.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));

    const packageJsonUri = pathToFileURL(path.join(root, "packages/a/package.json")).toString();
    const cycle = yield* waitFor(
      () => collector.messages.find((message) =>
        message.method === "textDocument/publishDiagnostics" &&
        message.params?.uri === packageJsonUri &&
        (message.params.diagnostics ?? []).some((diagnostic) =>
          diagnostic.code === PACKAGE_CYCLE_CODE)),
      "workspace package cycle diagnostic",
    );
    // Both findings belong to packages/a's manifest: the workspace expanded
    // from the manifest, so cross-package rules ran over both packages.
    expect(cycle.params?.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([SUBPATH_EXPORT_CODE, PACKAGE_CYCLE_CODE]),
    );
  })), SESSION_TIMEOUT_MS);
