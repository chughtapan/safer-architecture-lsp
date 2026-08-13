/**
 * @file LSP smoke test: spawn the built bin, run the initialize
 * handshake over stdio with LSP framing, and assert the advertised
 * server identity and text-document capabilities.
 */

import { Data, Effect } from "effect";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const PACKAGE_VERSION: string = (
  // package.json is the package's own manifest, so its `version` field is
  // guaranteed present whenever this test file resolves.
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/**
 * The identity `initialize` must advertise. It mirrors the `bin` name in
 * package.json, which editors key their client configuration off.
 */
const EXPECTED_SERVER_NAME = "safer-architecture-lsp";

const INITIALIZE_TIMEOUT_MS = 15_000;

/** The handshake never produced a frame within the allotted window. */
class InitializeTimeout extends Data.TaggedError("InitializeTimeout")<{
  readonly timeoutMs: number;
}> {}

function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

/**
 * Decode the first complete LSP frame in `chunks`.
 * @param chunks Everything read from the child's stdout so far.
 * @returns The decoded message, or `null` while the frame is still partial.
 */
function readFirstMessage(chunks: Buffer): unknown {
  const headerEnd = chunks.indexOf("\r\n\r\n");
  if (headerEnd === -1) {return null;}
  const header = chunks.subarray(0, headerEnd).toString("ascii");
  const match = /Content-Length: (\d+)/i.exec(header);
  if (match === null) {return null;}
  const bodyStart = headerEnd + 4;
  const length = Number(match[1]);
  if (chunks.length < bodyStart + length) {return null;}
  return JSON.parse(chunks.subarray(bodyStart, bodyStart + length).toString("utf8"));
}

it("answers the initialize handshake with its identity", () =>
  Effect.runPromise(Effect.gen(function* () {
    const child = spawn(process.execPath, ["dist/server/index.js", "serve"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));

    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, rootUri: null, capabilities: {}, workspaceFolders: null },
      }),
    );

    const response = yield* Effect.async<unknown, InitializeTimeout>((resume) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {return;}
        settled = true;
        resume(Effect.fail(new InitializeTimeout({ timeoutMs: INITIALIZE_TIMEOUT_MS })));
      }, INITIALIZE_TIMEOUT_MS);
      child.stdout.on("data", () => {
        if (settled) {return;}
        const message = readFirstMessage(Buffer.concat(stdout));
        if (message === null) {return;}
        settled = true;
        clearTimeout(timer);
        resume(Effect.succeed(message));
      });
      return Effect.sync(() => { clearTimeout(timer); });
    });

    child.kill();
    const result = (
      // A JSON-RPC reply to a successful `initialize` is guaranteed to carry a
      // `result.serverInfo` envelope, so the shape is known once it arrives.
      response as { result: { serverInfo: { name: string; version: string } } }
    ).result;
    // The advertised name is the bin identity editors match on; drift here
    // silently breaks every client configuration.
    expect(result.serverInfo.name).toBe(EXPECTED_SERVER_NAME);
    // The advertised version must track package.json rather than a copied
    // string, so a release bump cannot leave the handshake stale.
    expect(result.serverInfo.version).toBe(PACKAGE_VERSION);
  })), 20_000);
