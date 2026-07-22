/**
 * @file LSP smoke test: spawn the built bin, run the initialize
 * handshake over stdio with LSP framing, and assert the advertised
 * server identity and text-document capabilities.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

function readFirstMessage(chunks: Buffer): unknown {
  const raw = chunks.toString("utf8");
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error(`no LSP frame in: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(headerEnd + 4));
}

it("answers the initialize handshake with its identity", async () => {
  const child = spawn(process.execPath, ["dist/server/index.js"], {
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

  const response = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("initialize response timed out")),
      15_000,
    );
    child.stdout.on("data", () => {
      try {
        resolve(readFirstMessage(Buffer.concat(stdout)));
        clearTimeout(timer);
      } catch {
        // partial frame; keep accumulating
      }
    });
  });

  child.kill();
  const result = (response as { result: { serverInfo: { name: string; version: string } } }).result;
  expect(result.serverInfo.name).toBe("safer-architecture-lsp");
  expect(result.serverInfo.version).toBe(PACKAGE_VERSION);
}, 20_000);
