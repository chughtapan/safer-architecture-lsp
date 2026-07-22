/**
 * @file Full stdio LSP session against the built bin: initialize with a
 * real workspace, receive publishDiagnostics for a genuine finding,
 * then edit safer-architecture.config.json and observe the workspace
 * hot-reload change the published result — the 2am-Friday test.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeFixture, type Fixture } from "./support/fixtures.js";

const BIN = path.resolve("dist/server/index.js");

let fixture: Fixture | null = null;
let child: ChildProcessWithoutNullStreams | null = null;

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
  readonly params?: { uri?: string; diagnostics?: readonly { code?: unknown }[] };
}

/** Incremental Content-Length decoder over the child's stdout. */
class MessageCollector {
  #buffer = Buffer.alloc(0);
  readonly messages: LspMessage[] = [];

  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) throw new Error(`bad LSP header: ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + length) return;
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.messages.push(JSON.parse(body) as LspMessage);
      this.#buffer = this.#buffer.subarray(bodyStart + length);
    }
  }
}

async function waitFor<T>(
  probe: () => T | undefined,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it("publishes real diagnostics over a full session and hot-reloads config edits", async () => {
  fixture = makeFixture({
    "alpha/index.ts":
      'import { b } from "../beta/index.js";\nexport const a: number = b + 1;\n',
    "beta/index.ts":
      'import { a } from "../alpha/index.js";\nexport const b: number = a + 1;\n',
  });
  const root = fixture.root;

  child = spawn(process.execPath, [BIN, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  const collector = new MessageCollector();
  child.stdout.on("data", (chunk: Buffer) => collector.push(chunk));
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
  await waitFor(
    () => collector.messages.find((m) => m.id === 1),
    "initialize response",
  );
  child.stdin.write(frame({ jsonrpc: "2.0", method: "initialized", params: {} }));

  // The initial publish happens on registration — no didOpen required
  // (agents need findings for files nobody opened).
  const alphaUri = pathToFileURL(path.join(root, "alpha", "index.ts")).toString();
  const cyclePublish = await waitFor(
    () =>
      collector.messages.find(
        (m) =>
          m.method === "textDocument/publishDiagnostics" &&
          m.params?.uri === alphaUri &&
          (m.params.diagnostics ?? []).length > 0,
      ),
    "diagnostics for alpha/index.ts",
  );
  expect(cyclePublish.params?.diagnostics?.length).toBeGreaterThan(0);

  // Hot reload: an (invalid) config edit must surface a diagnostic on
  // the config file itself — proving the watcher rebuilt the workspace.
  const configPath = path.join(root, "safer-architecture.config.json");
  const configUri = pathToFileURL(configPath).toString();
  writeFileSync(configPath, "{ definitely not json");
  const configPublish = await waitFor(
    () =>
      collector.messages.find(
        (m) =>
          m.method === "textDocument/publishDiagnostics" &&
          m.params?.uri === configUri &&
          (m.params.diagnostics ?? []).some((d) => d.code === "invalid-config"),
      ),
    "invalid-config diagnostic after hot reload",
  );
  expect(configPublish).toBeDefined();

  // Protocol teardown: shutdown then exit ends the process with code 0.
  child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }));
  await waitFor(() => collector.messages.find((m) => m.id === 2), "shutdown response");
  const exited = new Promise<number | null>((resolve) => {
    child?.on("exit", (code) => resolve(code));
  });
  child.stdin.write(frame({ jsonrpc: "2.0", method: "exit", params: null }));
  const code = await exited;
  expect(code).toBe(0);
}, 180_000);
