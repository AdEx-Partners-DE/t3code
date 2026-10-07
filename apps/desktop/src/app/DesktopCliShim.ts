import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// A Linux desktop install puts no `t3` on PATH, so commands the server asks a
// person to run (`sudo t3 browser setup`) had nothing to call. The app writes a
// small `t3` launcher for its bundled server and the server names it in those
// commands through T3CODE_CLI_PATH. An AppImage mounts somewhere new each run,
// so its launcher mounts the AppImage itself instead of pointing into it.
const { logInfo, logWarning } = makeComponentLogger("desktop-cli-shim");

/** Written into every launcher, so the app only ever replaces its own. */
const SHIM_MARKER = "# Written by T3 Code: runs the desktop app's bundled t3 CLI.";

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Server entry inside the app, relative to its root (app.asar when packaged). */
const SERVER_ENTRY = "apps/server/dist/bin.mjs";

/**
 * The launcher script. Electron runs the server as plain Node with
 * `ELECTRON_RUN_AS_NODE`, which reads the entry from inside app.asar.
 */
export const renderCliShim = (
  input:
    | { readonly kind: "appimage"; readonly appImage: string; readonly executableName: string }
    | { readonly kind: "direct"; readonly executable: string; readonly entry: string },
) => {
  const header = [
    "#!/bin/sh",
    SHIM_MARKER,
    'export T3CODE_CLI_PATH="$0"',
    "export ELECTRON_RUN_AS_NODE=1",
  ];
  if (input.kind === "direct") {
    return [
      ...header,
      `exec ${shellWord(input.executable)} ${shellWord(input.entry)} "$@"`,
      "",
    ].join("\n");
  }
  return [
    ...header,
    `appimage=${shellWord(input.appImage)}`,
    'if [ ! -x "$appimage" ]; then',
    '  echo "T3 Code is no longer at $appimage. Open the app once to update this command." >&2',
    "  exit 127",
    "fi",
    // The AppImage runtime prints its mount point, then stays mounted until
    // killed. Background jobs ignore Ctrl-C, so the traps unmount it on any exit.
    "out=$(mktemp) || exit 1",
    '"$appimage" --appimage-mount >"$out" &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null; rm -f "$out"' EXIT`,
    "trap 'exit 130' INT TERM",
    'while [ ! -s "$out" ]; do',
    '  kill -0 "$mounter" 2>/dev/null || { echo "Could not open $appimage." >&2; exit 1; }',
    "  sleep 0.05",
    "done",
    'mount=$(head -n 1 "$out")',
    `"$mount/${input.executableName}" "$mount/resources/app.asar/${SERVER_ENTRY}" "$@"`,
    "",
  ].join("\n");
};

/**
 * Installs `~/.local/bin/t3` for a packaged Linux app and returns its path for
 * the backend's T3CODE_CLI_PATH. Leaves any `t3` it did not write alone, such
 * as an npm install, and returns none.
 */
export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "linux" || !environment.isPackaged) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const shimPath = path.join(environment.homeDirectory, ".local", "bin", "t3");
  const content = Option.match(environment.appImagePath, {
    onSome: (appImage) =>
      renderCliShim({
        kind: "appimage",
        appImage,
        executableName: path.basename(process.execPath),
      }),
    // A .deb installs to a fixed path, so its launcher runs the app directly.
    onNone: () =>
      renderCliShim({
        kind: "direct",
        executable: process.execPath,
        entry: path.join(environment.serverRoot, SERVER_ENTRY),
      }),
  });

  return yield* Effect.gen(function* () {
    const existing = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isSome(existing) && !existing.value.includes(SHIM_MARKER)) {
      yield* logInfo("leaving an existing t3 command in place", { shimPath });
      return Option.none<string>();
    }
    if (Option.getOrUndefined(existing) !== content) {
      yield* fs.makeDirectory(path.dirname(shimPath), { recursive: true });
      // Written beside the launcher and renamed over it, so a running `t3` never reads half a file.
      const staging = `${shimPath}.${process.pid}.tmp`;
      yield* fs.writeFileString(staging, content, { mode: 0o755 });
      yield* fs.rename(staging, shimPath);
      yield* logInfo("installed t3 command", { shimPath });
    }
    return Option.some(shimPath);
  }).pipe(
    // Best-effort: a read-only home must not block startup; commands then fall back to plain `t3`.
    Effect.catch((error) =>
      logWarning("could not install t3 command", { shimPath, message: error.message }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
    Effect.withSpan("desktop.cliShim.install"),
  );
});
