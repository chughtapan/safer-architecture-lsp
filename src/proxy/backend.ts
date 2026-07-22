/**
 * @file One child language server. Index 0 is the PRIMARY, authoritative
 * for language features; every other backend is a diagnostics-only
 * SIDECAR. Writes differ by role: the primary is strictly ordered and
 * awaited (it must never lose a message), while a sidecar owns a bounded
 * queue that drops under sustained backpressure so it can never stall the
 * client read loop.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { BackendSpec } from "./config.js";
import { FrameDecoder, encodePacket, type Message } from "./framing.js";
import { log } from "./log.js";

/** A sidecar buffers at most this many bytes before it starts dropping. */
const MAX_SIDECAR_BUFFER = 4 * 1024 * 1024;

export interface BackendHandlers {
  onMessage(index: number, message: Message): void;
  onClosed(index: number): void;
  onError(index: number, detail: string): void;
}

export class Backend {
  readonly diagnostics = new Map<string, unknown[]>();
  dropped = false;
  exited = false;
  exitCode = 1;

  private process: ChildProcess | undefined;
  private stdoutEnded = false;
  private handlers: BackendHandlers | undefined;
  private exitResolvers: Array<() => void> = [];

  private primaryTail: Promise<void> = Promise.resolve();
  private readonly sidecarQueue: Buffer[] = [];
  private sidecarBytes = 0;
  private sidecarFlushing = false;

  constructor(
    readonly index: number,
    readonly spec: BackendSpec,
  ) {}

  get label(): string {
    return this.spec.argv[0];
  }

  get isPrimary(): boolean {
    return this.index === 0;
  }

  start(handlers: BackendHandlers): void {
    this.handlers = handlers;
    const child = spawn(this.spec.argv[0], this.spec.argv.slice(1), {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.process = child;

    child.on("error", (error) => {
      if (!this.exited) {
        this.exited = true;
        this.releaseExitWaiters();
      }
      handlers.onError(this.index, `cannot start backend ${this.label}: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code === null ? (signal ? 1 : 0) : code;
      this.exited = true;
      this.releaseExitWaiters();
      this.maybeClosed();
    });

    const stdout = child.stdout;
    if (stdout === null) throw new Error(`backend ${this.label} has no stdout`);
    const decoder = new FrameDecoder(this.label);
    stdout.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      try {
        for (const message of decoder.drain()) handlers.onMessage(this.index, message);
      } catch (error) {
        handlers.onError(this.index, error instanceof Error ? error.message : String(error));
      }
    });
    stdout.on("end", () => {
      this.stdoutEnded = true;
      this.maybeClosed();
    });

    child.stdin?.on("error", (error) => {
      log(`${this.label}: stdin error: ${error.message}`);
    });
  }

  send(message: Message): Promise<void> {
    const packet = encodePacket(message);
    if (this.isPrimary) return this.writePrimary(packet);
    this.enqueueSidecar(packet);
    return Promise.resolve();
  }

  closeStdin(): void {
    const stdin = this.process?.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
  }

  terminate(): void {
    if (!this.exited) this.process?.kill("SIGTERM");
  }

  kill(): void {
    if (!this.exited) this.process?.kill("SIGKILL");
  }

  waitExit(): Promise<void> {
    if (this.exited || this.process === undefined) return Promise.resolve();
    return new Promise((resolve) => this.exitResolvers.push(resolve));
  }

  private maybeClosed(): void {
    if (this.exited && this.stdoutEnded && this.handlers) {
      this.handlers.onClosed(this.index);
    }
  }

  private releaseExitWaiters(): void {
    const resolvers = this.exitResolvers;
    this.exitResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  private writePrimary(packet: Buffer): Promise<void> {
    const write = this.primaryTail.then(() => this.writeOnce(packet));
    this.primaryTail = write.catch(() => undefined);
    return write;
  }

  private writeOnce(packet: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.process?.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error(`backend ${this.label} has no stdin`));
        return;
      }
      stdin.write(packet, (error) => (error ? reject(error) : resolve()));
    });
  }

  private enqueueSidecar(packet: Buffer): void {
    if (this.sidecarBytes + packet.length > MAX_SIDECAR_BUFFER && this.sidecarQueue.length > 0) {
      log(`${this.label}: stdin backpressured, dropping ${packet.length}B notification`);
      return;
    }
    this.sidecarQueue.push(packet);
    this.sidecarBytes += packet.length;
    this.flushSidecar();
  }

  private flushSidecar(): void {
    if (this.sidecarFlushing) return;
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) {
      this.sidecarQueue.length = 0;
      this.sidecarBytes = 0;
      return;
    }
    this.sidecarFlushing = true;
    const pump = (): void => {
      if (!stdin.writable) {
        this.sidecarQueue.length = 0;
        this.sidecarBytes = 0;
        this.sidecarFlushing = false;
        return;
      }
      let writable = true;
      while (writable && this.sidecarQueue.length > 0) {
        const packet = this.sidecarQueue.shift() as Buffer;
        this.sidecarBytes -= packet.length;
        writable = stdin.write(packet);
      }
      if (this.sidecarQueue.length > 0) stdin.once("drain", pump);
      else this.sidecarFlushing = false;
    };
    pump();
  }
}
