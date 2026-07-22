# proxy/

`safer-lsp-proxy` — a generic stdio LSP multiplexer for hosts that
cannot run two language servers for one file extension. The first
backend in the config is the PRIMARY (its death ends the proxy with its
exit code); the rest are SIDECARS (a crash is logged, their stale
diagnostics are cleared, and the primary keeps serving).

- `index.ts` — bin entry: `safer-lsp-proxy <config.json>`.
- `config.ts` — config parsing (`[{cmd, args}, ...]`).
- `framing.ts` — Content-Length codec (partial/coalesced frames).
- `backend.ts` — child process lifecycle.
- `multiplexer.ts` — request-id routing, capability merge, fanout,
  bounded sidecar write queues (no head-of-line blocking).
- `log.ts` — per-child prefixed stderr passthrough.
