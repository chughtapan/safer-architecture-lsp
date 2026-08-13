/**
 * @file Diagnostic logging for the proxy. Every operational line goes to
 * stderr so stdout stays a clean LSP transport for the client.
 */

/**
 * Emit one operational line on stderr, tagged so the proxy's output stays
 * distinguishable from a backend's own stderr, which it inherits.
 * @param message Line to write; the tag and trailing newline are added here.
 */
export function log(message: string): void {
  process.stderr.write(`safer-lsp-proxy: ${message}\n`);
}
