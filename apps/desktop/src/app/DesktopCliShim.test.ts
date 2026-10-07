// @effect-diagnostics nodeBuiltinImport:off - Runs the rendered launcher in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { renderCliShim } from "./DesktopCliShim.ts";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const writeExecutable = (path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o755 });
};

/**
 * A stand-in AppImage: `--appimage-mount` prints a mount directory holding an
 * app executable that reports its arguments, then stays up until killed and
 * records that it was.
 */
const fakeAppImage = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
  directories.push(root);
  const mount = NodePath.join(root, "mount");
  writeExecutable(
    NodePath.join(mount, "t3code"),
    '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE cli=$T3CODE_CLI_PATH"\nprintf "%s\\n" "$@"\nexit 3\n',
  );
  const appImage = NodePath.join(root, "T3 Code.AppImage");
  writeExecutable(
    appImage,
    `#!/bin/sh\n[ "$1" = --appimage-mount ] || exit 9\necho '${mount}'\ntrap 'touch "${root}/unmounted"; exit 0' TERM\nwhile :; do sleep 0.05; done\n`,
  );
  const shim = NodePath.join(root, "bin", "t3");
  writeExecutable(shim, renderCliShim({ kind: "appimage", appImage, executableName: "t3code" }));
  return { root, mount, appImage, shim };
};

describe("renderCliShim", () => {
  it("runs the AppImage's bundled CLI with every argument and unmounts after", () => {
    const { root, mount, shim } = fakeAppImage();
    const result = NodeChildProcess.spawnSync(shim, ["browser", "setup", "a b"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(3);
    expect(result.stdout.split("\n")).toEqual([
      `node=1 cli=${shim}`,
      `${mount}/resources/app.asar/apps/server/dist/bin.mjs`,
      "browser",
      "setup",
      "a b",
      "",
    ]);
    // The trap kills the mount helper as the launcher exits.
    NodeChildProcess.spawnSync("sh", [
      "-c",
      `i=0; while [ ! -e '${root}/unmounted' ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done`,
    ]);
    expect(NodeFS.existsSync(NodePath.join(root, "unmounted"))).toBe(true);
  });

  it("says how to fix a launcher whose AppImage moved", () => {
    const { appImage, shim } = fakeAppImage();
    NodeFS.rmSync(appImage);
    const result = NodeChildProcess.spawnSync(shim, ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("Open the app once to update this command.");
  });

  it("runs an installed app's server directly", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-shim-"));
    directories.push(root);
    const executable = NodePath.join(root, "opt", "T3 Code", "t3code");
    writeExecutable(
      executable,
      '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE"\nprintf "%s\\n" "$@"\n',
    );
    const shim = NodePath.join(root, "t3");
    writeExecutable(
      shim,
      renderCliShim({ kind: "direct", executable, entry: "/opt/T3's/app.asar/bin.mjs" }),
    );
    const result = NodeChildProcess.spawnSync(shim, ["browser", "setup"], { encoding: "utf8" });
    expect(result.stdout.split("\n")).toEqual([
      "node=1",
      "/opt/T3's/app.asar/bin.mjs",
      "browser",
      "setup",
      "",
    ]);
  });
});
