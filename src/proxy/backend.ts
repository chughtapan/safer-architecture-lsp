/**
 * @file One child language server. Index 0 is the PRIMARY, authoritative
 * for language features; every other backend is a diagnostics-only
 * SIDECAR. Writes differ by role: the primary is strictly ordered behind a
 * one-permit semaphore and reports its failures to the caller (it must
 * never lose a message), while a sidecar owns a bounded queue that drops
 * under sustained backpressure so it can never stall the client read loop.
 */

import { Data, Effect } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import type { BackendSpec } from "./config.js";
import { encodePacket, FrameDecoder, type Message } from "./framing.js";
import { log } from "./log.js";

// safer-arch-ignore no-trivial-sink-file: child-process lifecycle is a deliberate seam; folding it into the multiplexer would tangle spawn/kill handling with routing logic.

/** A sidecar buffers at most this many bytes before it starts dropping. */
const MAX_SIDECAR_BUFFER = 4 * 1024 * 1024;

/** Raised when a spawned backend cannot offer the stdio the proxy requires. */
class BackendError extends Error {}

/**
 * A packet the proxy could not hand to a backend's stdin. Only the primary
 * ever reports one: a sidecar's writes go through the drop-on-backpressure
 * queue, so they cannot fail the caller.
 */
export class BackendWriteError extends Data.TaggedError("BackendWriteError")<{
  readonly message: string;
}> {}

/**
 * The owner's side of a backend: decoded messages, the backend going down, and
 * failures attributed to it. Every callback carries the backend index, which is
 * what lets the owner treat a primary failure as fatal and a sidecar's as
 * survivable.
 */
export interface BackendHandlers {
  onMessage(index: number, message: Message): void;
  onClosed(index: number): void;
  onError(index: number, detail: string): void;
}

/**
 * A spawned language server plus the state the proxy keeps about it: its latest
 * diagnostics per URI, whether it has been dropped, and how it exited. Writes
 * take the primary or sidecar path described in the file overview.
 */
export class Backend {
  readonly index: number;
  readonly spec: BackendSpec;
  readonly diagnostics = new Map<string, unknown[]>();
  dropped = false;
  exited = false;
  exitCode = 1;

  private process?: ChildProcess;
  private stdoutEnded = false;
  private handlers?: BackendHandlers;
  private exitResolvers: Array<() => void> = [];

  private readonly primaryWrites: Effect.Semaphore = Effect.unsafeMakeSemaphore(1);
  private readonly sidecarQueue: Buffer[] = [];
  private sidecarBytes = 0;
  private sidecarDraining = false;

  constructor(index: number, spec: BackendSpec) {
    this.index = index;
    this.spec = spec;
  }

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
      this.exitCode = code ?? (signal ? 1 : 0);
      this.exited = true;
      this.releaseExitWaiters();
      this.maybeClosed();
    });

    const stdout = child.stdout;
    if (stdout === null) {throw new BackendError(`backend ${this.label} has no stdout`);}
    const decoder = new FrameDecoder(this.label);
    stdout.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      try {
        for (const message of decoder.drain()) {handlers.onMessage(this.index, message);}
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

  send(message: Message): Effect.Effect<undefined, BackendWriteError> {
    const packet = encodePacket(message);
    if (this.isPrimary) {return this.writePrimary(packet);}
    return Effect.sync(() => { this.enqueueSidecar(packet); }).pipe(Effect.as(undefined));
  }

  closeStdin(): void {
    const stdin = this.process?.stdin;
    if (stdin && !stdin.destroyed) {stdin.end();}
  }

  terminate(): void {
    if (!this.exited) {this.process?.kill("SIGTERM");}
  }

  kill(): void {
    if (!this.exited) {this.process?.kill("SIGKILL");}
  }

  waitExit(): Effect.Effect<undefined> {
    return Effect.async<undefined>((resume) => {
      if (this.exited || this.process === undefined) {
        resume(Effect.succeed(undefined));
        return;
      }
      this.exitResolvers.push(() => { resume(Effect.succeed(undefined)); });
    });
  }

  private maybeClosed(): void {
    if (this.exited && this.stdoutEnded && this.handlers) {
      this.handlers.onClosed(this.index);
    }
  }

  private releaseExitWaiters(): void {
    const resolvers = this.exitResolvers;
    this.exitResolvers = [];
    for (const resolve of resolvers) {resolve();}
  }

  // One permit, so the primary's packets reach its stdin in the order the
  // multiplexer produced them; a failed write releases the permit like any
  // other exit, so the next message is not stranded behind it.
  private writePrimary(packet: Buffer): Effect.Effect<undefined, BackendWriteError> {
    return this.primaryWrites.withPermits(1)(this.writeOnce(packet));
  }

  private writeOnce(packet: Buffer): Effect.Effect<undefined, BackendWriteError> {
    return Effect.async<undefined, BackendWriteError>((resume) => {
      const stdin = this.process?.stdin;
      if (!stdin || stdin.destroyed) {
        resume(
          Effect.fail(new BackendWriteError({ message: `backend ${this.label} has no stdin` })),
        );
        return;
      }
      stdin.write(packet, (error) => {
        if (error) {
          resume(Effect.fail(new BackendWriteError({ message: error.message })));
        } else {
          resume(Effect.succeed(undefined));
        }
      });
    });
  }

  private enqueueSidecar(packet: Buffer): void {
    if (this.sidecarBytes + packet.length > MAX_SIDECAR_BUFFER && this.sidecarQueue.length > 0) {
      log(`${this.label}: stdin backpressured, dropping ${packet.length}B notification`);
      return;
    }
    this.sidecarQueue.push(packet);
    this.sidecarBytes += packet.length;
    if (!this.sidecarDraining) {this.flushSidecar();}
  }

  // Node's pipe buffer is unbounded — write() reports backpressure by
  // returning false but still accepts the chunk. Once it does, stop
  // handing it more and hold the backlog in our own bounded queue (which
  // drops in enqueueSidecar) until the child drains its end.
  private flushSidecar(): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.sidecarQueue.length = 0;
      this.sidecarBytes = 0;
      return;
    }
    for (;;) {
      const packet = this.sidecarQueue.shift();
      if (packet === undefined) {return;}
      this.sidecarBytes -= packet.length;
      if (!stdin.write(packet)) {
        this.sidecarDraining = true;
        stdin.once("drain", () => {
          this.sidecarDraining = false;
          this.flushSidecar();
        });
        return;
      }
    }
  }
}
