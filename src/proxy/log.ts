/**
 * @file Diagnostic logging for the proxy. Every operational line goes to
 * stderr so stdout stays a clean LSP transport for the client.
 */

export function log(message: string): void {
  process.stderr.write(`safer-lsp-proxy: ${message}\n`);
}
