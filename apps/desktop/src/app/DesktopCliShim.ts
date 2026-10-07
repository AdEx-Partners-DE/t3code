import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// A desktop install puts no `t3` on PATH, so commands the server asks a person
// to run (`sudo t3 browser setup`) had nothing to call. The app keeps a small
// launcher for its bundled CLI in the T3 home, which is never on PATH and so
// never shadows another `t3`, and the server names it by absolute path in those
// commands through T3CODE_CLI_PATH. An AppImage mounts somewhere new each run,
// so its launcher mounts the AppImage itself instead of pointing into it.
const { logInfo, logWarning } = makeComponentLogger("desktop-cli-shim");

const MARKER = "Written by T3 Code: runs the desktop app's bundled t3 CLI.";

/** Server entry inside the app, relative to its server root (an asar archive when packaged). */
const SERVER_ENTRY = "apps/server/dist/bin.mjs";

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** cmd.exe expands `%` even inside quotes; Windows paths cannot contain `"`. */
const cmdWord = (value: string) => `"${value.replaceAll("%", "%%")}"`;

const MOVED = "T3 Code is no longer at $app. Open the app once to update this command.";

export type CliShimTarget =
  | { readonly kind: "appimage"; readonly appImage: string; readonly executableName: string }
  | { readonly kind: "direct"; readonly executable: string; readonly entry: string }
  | { readonly kind: "windows"; readonly executable: string; readonly entry: string };

/**
 * The launcher script. Electron runs the server as plain Node with
 * `ELECTRON_RUN_AS_NODE`, which reads the entry from inside the asar archive.
 */
export const renderCliShim = (target: CliShimTarget) => {
  if (target.kind === "windows") {
    return [
      "@echo off",
      `rem ${MARKER}`,
      "setlocal",
      'set "T3CODE_CLI_PATH=%~f0"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
      `if exist ${cmdWord(target.executable)} goto run`,
      `echo ${MOVED.replace("$app", target.executable.replaceAll("%", "%%"))} 1>&2`,
      "exit /b 127",
      ":run",
      `${cmdWord(target.executable)} ${cmdWord(target.entry)} %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  const header = [
    "#!/bin/sh",
    `# ${MARKER}`,
    'export T3CODE_CLI_PATH="$0"',
    "export ELECTRON_RUN_AS_NODE=1",
    `app=${shellWord(target.kind === "appimage" ? target.appImage : target.executable)}`,
    'if [ ! -x "$app" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
  ];
  if (target.kind === "direct") {
    return [...header, `exec "$app" ${shellWord(target.entry)} "$@"`, ""].join("\n");
  }
  return [
    ...header,
    // The AppImage runtime prints its mount point, then stays mounted until
    // killed. Background jobs ignore Ctrl-C, so the traps unmount it on any exit.
    "out=$(mktemp) || exit 1",
    '"$app" --appimage-mount >"$out" &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null; rm -f "$out"' EXIT`,
    "trap 'exit 130' INT TERM",
    'while [ ! -s "$out" ]; do',
    '  kill -0 "$mounter" 2>/dev/null || { echo "Could not open $app." >&2; exit 1; }',
    "  sleep 0.05",
    "done",
    'mount=$(head -n 1 "$out")',
    `"$mount/${target.executableName}" "$mount/resources/app.asar/${SERVER_ENTRY}" "$@"`,
    "",
  ].join("\n");
};

/** Where the packaged app keeps its launcher: `<T3 home>/bin/t3`, `t3.cmd` on Windows. */
export const launcherPath = (environment: DesktopEnvironment.DesktopEnvironment["Service"]) =>
  environment.path.join(
    environment.baseDir,
    "bin",
    environment.platform === "win32" ? "t3.cmd" : "t3",
  );

/**
 * Writes the packaged app's launcher to `<T3 home>/bin` and returns its path
 * for the backend's T3CODE_CLI_PATH. Development builds run from a checkout
 * and get none.
 */
export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (!environment.isPackaged) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  const path = environment.path;
  const windows = environment.platform === "win32";
  const shimPath = launcherPath(environment);
  const entry = path.join(environment.serverRoot, SERVER_ENTRY);
  const content = renderCliShim(
    windows
      ? { kind: "windows", executable: process.execPath, entry }
      : Option.match(environment.appImagePath, {
          onSome: (appImage) => ({
            kind: "appimage" as const,
            appImage,
            executableName: path.basename(process.execPath),
          }),
          // macOS and .deb installs live at a fixed path, so the launcher runs the app directly.
          onNone: () => ({ kind: "direct" as const, executable: process.execPath, entry }),
        }),
  );

  return yield* Effect.gen(function* () {
    const existing = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.getOrUndefined(existing) !== content) {
      yield* fs.makeDirectory(path.dirname(shimPath), { recursive: true });
      // Written beside the launcher and renamed over it, so a running `t3` never reads half a file.
      const staging = `${shimPath}.${process.pid}.tmp`;
      yield* fs.writeFileString(staging, content, { mode: 0o755 });
      yield* fs.rename(staging, shimPath);
      yield* logInfo("installed t3 launcher", { shimPath });
    }
    return Option.some(shimPath);
  }).pipe(
    // Best-effort: nothing here may block the backend's start; commands then fall back to plain `t3`.
    Effect.catchCause((cause) =>
      logWarning("could not install t3 launcher", { shimPath, cause: Cause.pretty(cause) }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
    Effect.withSpan("desktop.cliShim.install"),
  );
});
