// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const SERVE_ARGS = ["serve", "--hostname=127.0.0.1", "--port=4096"];

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

// A group of zombies can be reaped between a check and the kill, so ESRCH just means it is gone.
const killGroup = (pgid: number) =>
  Effect.sync(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  });

// libuv ignores a failed setsid(), which happens when the new pid equals the id of a group
// that still has members (such as a sleep orphaned by an earlier test). The child would then
// share the test worker's group, so the script first confirms it leads its own group and exits
// with 97 before starting anything if it does not.
const groupLeaderGuard = `pgid="$(ps -o pgid= -p $$ 2>&1 | tr -d ' ')"; [ "$pgid" = "$$" ] || { echo "ungrouped:$pgid"; exit 97; }; echo grouped; `;

// Yields the group, or a description of why this shell cannot be used as one.
const spawnGroupLeader = (args: ReadonlyArray<string>, script: string) =>
  Effect.gen(function* () {
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", groupLeaderGuard + script, ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = child.pid;
    if (pid === undefined) return yield* Effect.die("spawn failed");
    const grouped = yield* Deferred.make<true | string>();
    const exited = yield* Deferred.make<NodeJS.Signals | null>();
    const printed = yield* Deferred.make<void>();
    child.once("exit", (_code, signal) => Deferred.doneUnsafe(exited, Effect.succeed(signal)));
    // "close" fires after stdout drains, so a guard line always lands first. It only fires before
    // "grouped" when the shell died without starting the script, such as from a signal.
    child.once("close", (code, signal) =>
      Deferred.doneUnsafe(
        grouped,
        Effect.succeed(
          `shell ${pid} exited (code ${code}, signal ${signal}) before its group check`,
        ),
      ),
    );
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (line === "grouped") Deferred.doneUnsafe(grouped, Effect.succeed(true));
      if (line.startsWith("ungrouped:")) {
        const output = line.slice("ungrouped:".length);
        Deferred.doneUnsafe(
          grouped,
          Effect.succeed(`\`ps -o pgid= -p ${pid}\` printed ${JSON.stringify(output)}`),
        );
      }
      if (line === "ready") Deferred.doneUnsafe(printed, Effect.void);
    });
    const result = yield* Deferred.await(grouped);
    return result === true
      ? { pid, exited: Deferred.await(exited), printed: Deferred.await(printed) }
      : result;
  });

// A pid colliding with a live group id is rare, so a few retries clear it. Repeated failures
// mean the guard itself is broken (for example a missing or BusyBox `ps`).
const GROUP_LEADER_ATTEMPTS = 5;

const spawnGroup = (args: ReadonlyArray<string>, script = "sleep 600 & wait") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      let failure = "";
      for (let attempt = 0; attempt < GROUP_LEADER_ATTEMPTS; attempt++) {
        const group = yield* spawnGroupLeader(args, script);
        if (typeof group !== "string") return group;
        failure = group;
      }
      return yield* Effect.die(
        `no shell led its own process group after ${GROUP_LEADER_ATTEMPTS} attempts; last: ${failure}`,
      );
    }),
    ({ pid }) => killGroup(pid),
  );

const recordFromDeadServer = (stateDir: string, server: { readonly pid: number }) =>
  Effect.gen(function* () {
    const previousServer = yield* spawnGroup([]);
    const previousLedger = yield* OpenCodeServerLedger.make({
      stateDir,
      ownerPid: previousServer.pid,
    });
    yield* Effect.asVoid(previousLedger.track({ pid: server.pid, port: 4096, args: SERVE_ARGS }));
    yield* killGroup(previousServer.pid);
    yield* previousServer.exited;
  });

const hostPlatform = HostProcess.Platform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux" ? ["linux", "darwin"] : hostPlatform === "darwin" ? ["darwin"] : [];

describe.each(observedPlatforms)("OpenCodeServerLedger observing as %s", (platform) => {
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(NodeServices.layer),
    );

  it.live("stops an OpenCode server group left by a server that died", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const orphan = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, orphan);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toHaveLength(1);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(yield* orphan.exited).toBe("SIGTERM");
      expect(groupExists(orphan.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("records a group whose spawned wrapper already exited", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      // The inner shell prints once it has exec'd. Until then it still carries the wrapper's
      // command line, and recording that would make the reaper skip the group as recycled.
      const wrapper = yield* spawnGroup(
        SERVE_ARGS,
        '/bin/sh -c "echo ready; sleep 600 & wait" "$0" "$@" & exit 0',
      );
      yield* wrapper.exited;
      yield* wrapper.printed;
      expect(groupExists(wrapper.pid)).toBe(true);

      yield* recordFromDeadServer(stateDir, wrapper);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toHaveLength(1);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(wrapper.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("leaves a recycled pid alone when its start time does not match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "opencode-servers", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace(/"startTime":"[^"]+"/, '"startTime":"1"'));

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves a serve process on another port alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "opencode-servers", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace("--port=4096", "--port=4097"));

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves the servers of a running T3 server alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const running = yield* OpenCodeServerLedger.make({ stateDir });
      const server = yield* spawnGroup(SERVE_ARGS);
      const forget = yield* running.track({ pid: server.pid, port: 4096, args: SERVE_ARGS });

      const other = yield* OpenCodeServerLedger.make({ stateDir });
      yield* other.reapOrphans;
      expect(groupExists(server.pid)).toBe(true);

      yield* forget;
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A long-lived process whose command line ends in the serve arguments, like `opencode.exe`. */
const spawnWindowsProcess = (command: string, args: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn(command, args, { stdio: "ignore", windowsHide: true });
      const exited = yield* Deferred.make<void>();
      child.once("exit", () => Deferred.doneUnsafe(exited, Effect.void));
      const pid = child.pid;
      if (pid === undefined) return yield* Effect.die("spawn failed");
      return { pid, kill: () => child.kill(), exited: Deferred.await(exited) };
    }),
    ({ kill }) => Effect.sync(kill),
  );
/** A PowerShell that exits 1 without output, as a CIM failure on a busy machine does. */
const failedQuery = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
const IDLE_SCRIPT = "setInterval(() => {}, 1e6)";
const spawnWindowsServer = (args: ReadonlyArray<string>) =>
  spawnWindowsProcess(process.execPath, ["-e", IDLE_SCRIPT, ...args]);

describe.runIf(hostPlatform === "win32")("OpenCodeServerLedger on Windows", () => {
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(NodeServices.layer),
    );

  /** Records `serverPid` for a T3 server that is then killed, as a deploy or a crash does. */
  const recordFromKilledServer = (stateDir: string, serverPid: number) =>
    Effect.gen(function* () {
      const previousServer = yield* spawnWindowsServer([]);
      const previousLedger = yield* OpenCodeServerLedger.make({
        stateDir,
        ownerPid: previousServer.pid,
      });
      yield* Effect.asVoid(previousLedger.record({ pid: serverPid, port: 4096, args: SERVE_ARGS }));
      previousServer.kill();
      yield* previousServer.exited;
    });

  const entries = (stateDir: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(stateDir, "opencode-servers");
      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      return yield* Effect.forEach(names, (name) =>
        fs
          .readFileString(path.join(directory, name))
          .pipe(Effect.map((text) => ({ name, entry: JSON.parse(text) as { pid: number } }))),
      );
    });

  it.live(
    "stops a server left by a T3 server that was killed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const orphan = yield* spawnWindowsServer(SERVE_ARGS);
        yield* recordFromKilledServer(stateDir, orphan.pid);
        expect(yield* entries(stateDir)).toHaveLength(1);

        const ledger = yield* OpenCodeServerLedger.make({ stateDir });
        yield* ledger.reapOrphans;

        yield* orphan.exited.pipe(Effect.timeout("10 seconds"));
        expect(yield* entries(stateDir)).toHaveLength(0);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "records and stops the server under npm's shell wrapper, not the wrapper",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        // `cmd /c` stays the parent of the server, as with npm's `opencode.cmd` shim.
        const wrapper = yield* spawnWindowsProcess("cmd.exe", [
          "/d",
          "/c",
          process.execPath,
          "-e",
          IDLE_SCRIPT,
          ...SERVE_ARGS,
        ]);
        // The server is the wrapper's child; give cmd a moment to start it.
        yield* Effect.sleep("500 millis");
        yield* recordFromKilledServer(stateDir, wrapper.pid);
        const [recorded] = yield* entries(stateDir);
        expect(recorded?.entry.pid).not.toBe(wrapper.pid);
        const serverPid = recorded!.entry.pid;
        // A killed wrapper leaves its child running.
        wrapper.kill();
        yield* wrapper.exited;
        expect(isAlive(serverPid)).toBe(true);

        const ledger = yield* OpenCodeServerLedger.make({ stateDir });
        yield* ledger.reapOrphans;

        expect(isAlive(serverPid)).toBe(false);
        expect(yield* entries(stateDir)).toHaveLength(0);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "forgetting a server cancels its pending recording and leaves no entry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const server = yield* spawnWindowsServer(SERVE_ARGS);
        const ledger = yield* OpenCodeServerLedger.make({ stateDir });
        // Returns at once: the process queries run in the background.
        const forget = yield* ledger.track({ pid: server.pid, port: 4096, args: SERVE_ARGS });
        yield* forget;
        expect(yield* entries(stateDir)).toHaveLength(0);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "stops nothing and keeps the entry when the process query fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const server = yield* spawnWindowsServer(SERVE_ARGS);
        yield* recordFromKilledServer(stateDir, server.pid);

        // PowerShell that exits without output, as a CIM failure on a busy machine does.
        const failingQueries = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
        const ledger = yield* OpenCodeServerLedger.make({ stateDir }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingQueries),
        );
        yield* ledger.reapOrphans;

        expect(isAlive(server.pid)).toBe(true);
        expect(yield* entries(stateDir)).toHaveLength(1);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "keeps the entry when taskkill does not stop the server",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const server = yield* spawnWindowsServer(SERVE_ARGS);
        yield* recordFromKilledServer(stateDir, server.pid);

        // Real process queries, but a taskkill that stops nothing.
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const noTaskkill = ChildProcessSpawner.make((command) =>
          (command as unknown as { readonly command: string }).command === "taskkill"
            ? real.spawn(ChildProcess.make("cmd.exe", ["/d", "/c", "exit 1"]))
            : real.spawn(command),
        );
        const ledger = yield* OpenCodeServerLedger.make({ stateDir }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noTaskkill),
        );
        yield* ledger.reapOrphans;

        expect(isAlive(server.pid)).toBe(true);
        expect(yield* entries(stateDir)).toHaveLength(1);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "records on a later try after its process queries kept failing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const server = yield* spawnWindowsServer(SERVE_ARGS);

        // The first three PowerShell queries fail (the owner query and its two retries).
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        let failuresLeft = 3;
        // Decided when each attempt runs: a retry runs the same spawn effect again.
        const flaky = ChildProcessSpawner.make((command) =>
          Effect.suspend(() =>
            (command as unknown as { readonly command: string }).command === "powershell.exe" &&
            failuresLeft-- > 0
              ? Effect.succeed(failedQuery())
              : real.spawn(command),
          ),
        );
        const ledger = yield* OpenCodeServerLedger.make({ stateDir }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, flaky),
        );
        const recordServer = ledger
          .record({ pid: server.pid, port: 4096, args: SERVE_ARGS })
          .pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, flaky));

        yield* Effect.asVoid(recordServer);
        expect(yield* entries(stateDir)).toHaveLength(0);
        // The failed owner query was not kept, so the next recording asks again and succeeds.
        yield* Effect.asVoid(recordServer);
        expect(yield* entries(stateDir)).toHaveLength(1);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "leaves the servers of a running T3 server alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const server = yield* spawnWindowsServer(SERVE_ARGS);
        const runningOwner = yield* spawnWindowsServer([]);
        const ownerLedger = yield* OpenCodeServerLedger.make({
          stateDir,
          ownerPid: runningOwner.pid,
        });
        yield* Effect.asVoid(ownerLedger.record({ pid: server.pid, port: 4096, args: SERVE_ARGS }));

        const ledger = yield* OpenCodeServerLedger.make({ stateDir });
        yield* ledger.reapOrphans;

        expect(isAlive(server.pid)).toBe(true);
        expect(yield* entries(stateDir)).toHaveLength(1);
      }).pipe(provideHost),
    60_000,
  );

  it.live(
    "leaves a recycled pid alone when its start time does not match",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
        const server = yield* spawnWindowsServer(SERVE_ARGS);
        yield* recordFromKilledServer(stateDir, server.pid);
        const path = yield* Path.Path;
        const [recorded] = yield* entries(stateDir);
        const entryPath = path.join(stateDir, "opencode-servers", recorded!.name);
        yield* fs.writeFileString(
          entryPath,
          JSON.stringify({ ...recorded!.entry, startTime: "0" }),
        );

        const ledger = yield* OpenCodeServerLedger.make({ stateDir });
        yield* ledger.reapOrphans;

        expect(isAlive(server.pid)).toBe(true);
        expect(yield* entries(stateDir)).toHaveLength(0);
      }).pipe(provideHost),
    60_000,
  );
});

describe.skipIf(observedPlatforms.length === 0)("OpenCode server startup", () => {
  it.live("stops the group when interrupted while the server is being recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-startup-" });
      const binaryPath = path.join(tempDir, "opencode");
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\nsleep 600 &\nexit 0\n");
      yield* fs.chmod(binaryPath, 0o755);

      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const recording = yield* Deferred.make<number>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const layerRuntime = OpenCodeRuntime.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner
                .spawn(command)
                .pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
            ),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            OpenCodeServerLedger.OpenCodeServerLedger,
            OpenCodeServerLedger.OpenCodeServerLedger.of({
              track: (server) =>
                Effect.gen(function* () {
                  yield* (yield* Deferred.await(spawned)).exitCode.pipe(Effect.ignore);
                  yield* Deferred.succeed(recording, server.pid);
                  return yield* Effect.never;
                }),
            }),
          ),
        ),
      );

      const serverScope = yield* Scope.make();
      const starting = yield* OpenCodeRuntime.OpenCodeRuntime.pipe(
        Effect.flatMap((runtime) =>
          runtime.startOpenCodeServerProcess({ binaryPath, directory: tempDir, port: 4096 }),
        ),
        Effect.provideService(Scope.Scope, serverScope),
        Effect.provide(layerRuntime),
        Effect.forkChild,
      );
      const pgid = yield* Deferred.await(recording);
      yield* Effect.addFinalizer(() => killGroup(pgid));
      expect(groupExists(pgid)).toBe(true);

      yield* Fiber.interrupt(starting);
      yield* Scope.close(serverScope, Exit.void);

      expect(groupExists(pgid)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
