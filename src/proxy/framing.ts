/**
 * @file LSP `Content-Length` wire codec. `encodePacket` frames a
 * JSON-RPC object; `FrameDecoder` is a stateful reassembler that turns
 * an arbitrary sequence of byte chunks — partial frames, coalesced
 * frames, or both — into whole JSON-RPC objects.
 */

export type Message = Record<string, unknown>;

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");

/** Malformed LSP framing or a JSON-RPC payload that is not an object. */
export class ProtocolError extends Error {}

export function encodePacket(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

function parseContentLength(lines: string[], source: string): number {
  let found: number | null = null;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) throw new ProtocolError(`${source}: invalid LSP header`);
    const name = line.slice(0, separator).trim().toLowerCase();
    if (name !== "content-length") continue;
    if (found !== null) throw new ProtocolError(`${source}: duplicate Content-Length header`);
    const value = line.slice(separator + 1).trim();
    if (!/^\d+$/.test(value)) throw new ProtocolError(`${source}: invalid Content-Length header`);
    found = Number(value);
  }
  if (found === null) throw new ProtocolError(`${source}: missing or invalid Content-Length header`);
  return found;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private contentLength: number | null = null;

  constructor(private readonly source: string) {}

  push(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** Yield every whole message currently buffered; throws on malformed framing. */
  *drain(): Generator<Message> {
    for (;;) {
      const message = this.next();
      if (message === null) return;
      yield message;
    }
  }

  /** True when a frame is mid-parse — a stream that ends here was cut inside a frame. */
  hasBufferedData(): boolean {
    return this.buffer.length > 0 || this.contentLength !== null;
  }

  private next(): Message | null {
    if (this.contentLength === null) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) return null;
      const lines = this.buffer
        .subarray(0, headerEnd)
        .toString("ascii")
        .split("\r\n")
        .filter((line) => line.length > 0);
      this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
      this.contentLength = parseContentLength(lines, this.source);
    }

    if (this.buffer.length < this.contentLength) return null;
    const body = this.buffer.subarray(0, this.contentLength);
    this.buffer = this.buffer.subarray(this.contentLength);
    this.contentLength = null;

    let decoded: unknown;
    try {
      decoded = JSON.parse(body.toString("utf8"));
    } catch {
      throw new ProtocolError(`${this.source}: LSP body is not valid UTF-8 JSON`);
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new ProtocolError(`${this.source}: JSON-RPC payload must be an object`);
    }
    return decoded as Message;
  }
}
