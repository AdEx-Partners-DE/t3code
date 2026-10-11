import * as NodeModule from "node:module";

import type * as Undici from "undici";

// undici stays external to the CLI bundle (scripts/lib/cli-external-packages.ts).
// Inside a Node single-executable only `require` can load it from disk.
const requireUndici = NodeModule.createRequire(import.meta.url);

/**
 * True when the runtime's built-in `fetch` negotiates HTTP/2 by default.
 * Node 26 bundles undici 8, which offers h2 over ALPN to every HTTPS origin.
 * Node 22/24 (and Electron) bundle undici 6/7, whose fetch stays on HTTP/1.1.
 */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

/**
 * Replaces the process-wide fetch dispatcher with one that only speaks HTTP/1.1.
 *
 * Node's built-in fetch reads its dispatcher from the
 * `Symbol.for("undici.globalDispatcher.1"/".2")` globals, and the npm package's
 * `setGlobalDispatcher` writes both. This covers requests using the default
 * fetch dispatcher, including Effect's `FetchHttpClient`; `node:http` callers
 * (e.g. `cli/sshHelper.ts`) are unaffected and already speak HTTP/1.1.
 *
 * Node's `--use-env-proxy` / `NODE_USE_ENV_PROXY` installs an
 * `EnvHttpProxyAgent` at startup; that choice is kept so proxies still apply.
 */
export function installHttp1FetchDispatcher(): void {
  const undici = requireUndici("undici") as typeof Undici;
  const options = { allowH2: false };
  const usesEnvProxy = undici.getGlobalDispatcher().constructor.name === "EnvHttpProxyAgent";
  undici.setGlobalDispatcher(
    usesEnvProxy ? new undici.EnvHttpProxyAgent(options) : new undici.Agent(options),
  );
}

/**
 * Keeps outbound fetch on HTTP/1.1. An undici HTTP/2 session that hits its
 * idle timeout can emit `'error'` on a stream with no listener, which Node
 * turns into an uncaught exception that exits the server
 * (https://github.com/nodejs/undici/issues/5936). Runtimes whose fetch never
 * negotiates h2 are left untouched.
 */
export function keepOutboundFetchOnHttp1(): void {
  if (builtinFetchUsesHttp2(process.versions.undici)) installHttp1FetchDispatcher();
}
