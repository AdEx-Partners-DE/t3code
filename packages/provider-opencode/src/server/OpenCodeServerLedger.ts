import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

const ProcessIdentity = Schema.Struct({ pid: Schema.Int, startTime: Schema.String });
type ProcessIdentity = typeof ProcessIdentity.Type;

const OpenCodeServerEntry = Schema.Struct({
  version: Schema.Literal(1),
  pgid: Schema.Int,
  pid: Schema.Int,
  startTime: Schema.String,
  command: Schema.String,
  port: Schema.Int,
  stateDir: Schema.String,
  owner: ProcessIdentity,
});
type OpenCodeServerEntry = typeof OpenCodeServerEntry.Type;
const OpenCodeServerEntryJson = Schema.fromJsonString(OpenCodeServerEntry);
const decodeEntry = Schema.decodeUnknownOption(OpenCodeServerEntryJson);
const encodeEntry = Schema.encodeEffect(OpenCodeServerEntryJson);

/** A Windows process query that did not produce an answer; the process state is unknown. */
class WindowsProcessQueryError extends Schema.TaggedError<WindowsProcessQueryError>()(
  "WindowsProcessQueryError",
  { filter: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The Windows process query (${this.filter}) gave no answer.`;
  }
}

/**
 * Local `opencode serve` processes run in their own process group so T3 can
 * stop the whole group, which also means they outlive a T3 server that is
 * SIGKILLed or crashes. On Windows they are not detached, but a killed
 * process takes no children with it there either. Each spawn is recorded
 * under the state directory and removed on a graceful stop; the next server
 * start stops whatever a dead server left behind.
 */
export class OpenCodeServerLedger extends Context.Service<
  OpenCodeServerLedger,
  {
    readonly track: (server: {
      readonly pid: number;
      readonly port: number;
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<Effect.Effect<void>>;
  }
>()("@t3tools/provider-opencode/server/OpenCodeServerLedger") {}

const ENTRY_DIRECTORY = "opencode-servers";
const ENTRY_FILE = /^\d+\.json$/;
const STOP_POLL_INTERVAL = "50 millis";
const STOP_POLL_ATTEMPTS = 40;
/** Windows queries run off the server start, so a failed one can wait and ask again. */
const WINDOWS_QUERY_RETRY = { times: 2, schedule: Schedule.spaced("1 second") };

interface ObservedProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly startTime: string;
  readonly command: string;
  readonly zombie: boolean;
}

// `ps -o lstart` prints e.g. `Sat Sep  6 20:51:57 2026`; C locale and UTC keep it stable.
const DARWIN_PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

const parseDarwinPs = (output: string): ReadonlyArray<ObservedProcess> =>
  output.split("\n").flatMap((line) => {
    const match = DARWIN_PS_LINE.exec(line);
    if (match === null) return [];
    return [
      {
        pid: Number(match[1]),
        pgid: Number(match[2]),
        zombie: match[3]!.startsWith("Z"),
        startTime: match[4]!,
        command: match[5]!.trimEnd(),
      },
    ];
  });

// Windows has neither `/proc` nor `ps`; CIM reports the same facts. Start time is the creation
// time in UTC ticks. `pgid` carries the parent, since Windows has no process groups. A CIM error
// would otherwise be non-terminating and still print `[]`, so it stops the script, which then
// prints nothing.
const WINDOWS_PROCESS_QUERY = (filter: string) =>
  `$ErrorActionPreference = 'Stop'; ` +
  `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop | ` +
  `ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; ` +
  `startTime = [string]$_.CreationDate.ToUniversalTime().Ticks; command = [string]$_.CommandLine } })`;

/**
 * Throws unless the output is the JSON array the query prints, `[]` when nothing matched. The
 * spawner does not fail on a non-zero exit, so empty output from a PowerShell or CIM failure must
 * not read as "no such process".
 */
const parseWindowsProcesses = (output: string): ReadonlyArray<ObservedProcess> => {
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows)) throw new Error("Unexpected Windows process query output");
  return rows.flatMap((row: Record<string, unknown>) =>
    typeof row.pid === "number" && typeof row.startTime === "string"
      ? [
          {
            pid: row.pid,
            pgid: typeof row.ppid === "number" ? row.ppid : -1,
            startTime: row.startTime,
            command: typeof row.command === "string" ? row.command : "",
            zombie: false,
          },
        ]
      : [],
  );
};

/**
 * Whether a command line ends in the serve arguments. Windows command lines quote each argument
 * (`"serve" "--hostname=127.0.0.1" "--port=4096"`), and the npm shim pads them with spaces.
 */
const endsWithServeArgs = (command: string, args: ReadonlyArray<string>, platform: string) =>
  platform === "win32"
    ? command
        .replaceAll('"', "")
        .replace(/\s+/g, " ")
        .trimEnd()
        .endsWith(` ${args.join(" ")}`)
    : command.endsWith(` ${args.join(" ")}`);

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    signalProcessGroup(pgid, signal);
  } catch {}
};

const groupExists = (pgid: number) => {
  try {
    signalProcessGroup(pgid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
};

export const make = Effect.fn("OpenCodeServerLedger.make")(function* (input: {
  readonly stateDir: string;
  readonly ownerPid?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const directory = path.join(input.stateDir, ENTRY_DIRECTORY);
  // Windows servers are not detached, but a T3 server that is killed rather than stopped still
  // leaves them running: Windows does not end a process's children with it.
  const recordable = platform === "linux" || platform === "darwin" || platform === "win32";

  // A process-group scan calls this for every /proc entry; avoid a span per process.
  const observeLinux = Effect.fnUntraced(function* (pid: number, group?: number) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(pgid) || startTime === undefined) return undefined;
    if (group !== undefined && pgid !== group) return undefined;
    const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`);
    return {
      pid,
      pgid,
      startTime,
      command: cmdline.replace(/\0$/, "").replaceAll("\0", " "),
      zombie: fields[0] === "Z",
    } satisfies ObservedProcess;
  });

  const psDarwin = (selection: ReadonlyArray<string>) =>
    spawner
      .string(
        ChildProcess.make(
          "/bin/ps",
          ["-ww", "-o", "pid=,pgid=,stat=,lstart=,args=", ...selection],
          {
            env: { LC_ALL: "C", TZ: "UTC" },
            extendEnv: true,
            stdin: "ignore",
            stderr: "ignore",
          },
        ),
      )
      .pipe(Effect.timeout("5 seconds"), Effect.map(parseDarwinPs));

  const psWindows = (filter: string) =>
    spawner
      .string(
        ChildProcess.make(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY(filter)],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.flatMap((output) =>
          Effect.try({
            try: () => parseWindowsProcesses(output),
            catch: (cause) => new WindowsProcessQueryError({ filter, cause }),
          }),
        ),
      );

  type WindowsQueryFailure = Effect.Error<ReturnType<typeof psWindows>>;

  const observe = (pid: number): Effect.Effect<ObservedProcess | undefined> => {
    if (platform === "linux") return observeLinux(pid).pipe(Effect.orElseSucceed(() => undefined));
    if (platform === "win32") {
      return psWindows(`ProcessId=${pid}`).pipe(
        Effect.map((found) => found.find((candidate) => candidate.pid === pid)),
        Effect.orElseSucceed(() => undefined),
      );
    }
    if (platform === "darwin") {
      return psDarwin(["-p", String(pid)]).pipe(
        Effect.map((found) => found.find((candidate) => candidate.pid === pid)),
        Effect.orElseSucceed(() => undefined),
      );
    }
    return Effect.succeed(undefined);
  };

  const observeGroup = (pgid: number): Effect.Effect<ReadonlyArray<ObservedProcess>> => {
    if (platform === "linux") {
      return fs.readDirectory("/proc").pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names.filter((name) => /^\d+$/.test(name)),
            (name) => observeLinux(Number(name), pgid).pipe(Effect.orElseSucceed(() => undefined)),
            { concurrency: 16 },
          ),
        ),
        Effect.map((found) => found.filter((candidate) => candidate !== undefined)),
        Effect.orElseSucceed(() => []),
      );
    }
    if (platform === "darwin") {
      return psDarwin(["-A"]).pipe(
        Effect.map((found) => found.filter((candidate) => candidate.pgid === pgid)),
        Effect.orElseSucceed(() => []),
      );
    }
    if (platform === "win32") {
      // The spawned process is the shell running npm's `opencode.cmd` shim; `opencode.exe` is
      // its child, and it is what outlives a killed T3 server.
      return psWindows(`ProcessId=${pgid} OR ParentProcessId=${pgid}`).pipe(
        Effect.retry(WINDOWS_QUERY_RETRY),
        Effect.map((found) =>
          found.toSorted((left, right) => Number(left.pid === pgid) - Number(right.pid === pgid)),
        ),
        Effect.orElseSucceed(() => []),
      );
    }
    return Effect.succeed([]);
  };

  // A Windows query can fail on a busy machine (a PowerShell start, CIM). That says nothing about
  // the process, so reaping treats it as unknown: it stops nothing and keeps the entry for a later
  // start. Elsewhere a failed read means the process is gone.
  const observeOrUnknown = (pid: number): Effect.Effect<ObservedProcess | undefined | "unknown"> =>
    platform === "win32"
      ? psWindows(`ProcessId=${pid}`).pipe(
          Effect.map((found) => found.find((candidate) => candidate.pid === pid)),
          Effect.orElseSucceed(() => "unknown" as const),
        )
      : observe(pid);

  const isRunning = (identity: ProcessIdentity) =>
    observeOrUnknown(identity.pid).pipe(
      Effect.map((observed) =>
        observed === "unknown"
          ? ("unknown" as const)
          : observed !== undefined && !observed.zombie && observed.startTime === identity.startTime,
      ),
    );

  const ownerPid = input.ownerPid ?? process.pid;
  // Read on first use: on Windows a process query takes a PowerShell start, which server
  // startup should not wait for. Only an answer is kept: a Windows query that still fails after
  // its retries is asked again at the next recording rather than leaving this server unrecorded.
  const readOwner: Effect.Effect<ObservedProcess | undefined, WindowsQueryFailure> =
    platform === "win32"
      ? psWindows(`ProcessId=${ownerPid}`).pipe(
          Effect.retry(WINDOWS_QUERY_RETRY),
          Effect.map((found) => found.find((candidate) => candidate.pid === ownerPid)),
        )
      : observe(ownerPid);
  const ownerIdentity = yield* Effect.cachedWithTTL(
    readOwner.pipe(
      Effect.map((ownerProcess) =>
        ownerProcess === undefined
          ? undefined
          : { pid: ownerPid, startTime: ownerProcess.startTime },
      ),
    ),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  );

  const record = Effect.fn("OpenCodeServerLedger.record")(
    function* (server: Parameters<OpenCodeServerLedger["Service"]["track"]>[0]) {
      if (!recordable) return Effect.void;
      const pgid = server.pid;
      // The spawned process leads the group. If it already exited (a wrapper
      // that left the server running), any live member identifies the group:
      // a group id is not reused while the group has members.
      const owner = yield* ownerIdentity.pipe(Effect.orElseSucceed(() => undefined));
      const leader = platform === "win32" ? undefined : yield* observe(pgid);
      const members =
        leader !== undefined && !leader.zombie && leader.pgid === pgid
          ? [leader]
          : (yield* observeGroup(pgid)).filter((candidate) => !candidate.zombie);
      const member =
        members.find((candidate) => endsWithServeArgs(candidate.command, server.args, platform)) ??
        members[0];
      if (owner === undefined || member === undefined) {
        if (platform === "win32" || groupExists(pgid)) {
          yield* Effect.logWarning(
            "Could not record an OpenCode server; it will keep running if this server crashes",
            { pid: pgid, port: server.port },
          );
        }
        return Effect.void;
      }
      const entryPath = path.join(directory, `${pgid}.json`);
      const entry: OpenCodeServerEntry = {
        version: 1,
        pgid,
        pid: member.pid,
        startTime: member.startTime,
        command: member.command,
        port: server.port,
        stateDir: input.stateDir,
        owner,
      };
      yield* writeFileStringAtomically({
        filePath: entryPath,
        contents: yield* encodeEntry(entry),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return fs
        .remove(entryPath, { force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not forget a stopped OpenCode server", { cause }),
          ),
        );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record an OpenCode server process", { cause }).pipe(
        Effect.as(Effect.void),
      ),
    ),
  );

  const track: OpenCodeServerLedger["Service"]["track"] = (server) =>
    platform !== "win32"
      ? record(server)
      : // A process query on Windows starts PowerShell, which takes seconds on a busy machine.
        // The server start does not wait for it, and a start that is interrupted (a provider
        // check that gave up) does not cancel it; forgetting the server cancels it instead.
        Effect.gen(function* () {
          const recording = yield* Effect.forkDetach(record(server));
          return Fiber.interrupt(recording).pipe(
            Effect.andThen(fs.remove(path.join(directory, `${server.pid}.json`), { force: true })),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not forget a stopped OpenCode server", { cause }),
            ),
          );
        });

  // Signals only a group whose recorded member still has the same pid, start
  // time, group, and full command line, so a recycled pid is never touched.
  // Returns false when the recorded process could not be queried, so its entry is kept.
  const stopOrphan = Effect.fn("OpenCodeServerLedger.stopOrphan")(function* (
    entry: OpenCodeServerEntry,
  ) {
    const observed = yield* observeOrUnknown(entry.pid);
    if (observed === "unknown") return false;
    if (
      observed === undefined ||
      observed.zombie ||
      observed.startTime !== entry.startTime ||
      (platform !== "win32" && observed.pgid !== entry.pgid) ||
      observed.command !== entry.command
    ) {
      return true;
    }
    yield* Effect.logInfo("Stopping an OpenCode server left by a previous T3 Code server", {
      pid: entry.pgid,
      port: entry.port,
    });
    if (platform === "win32") {
      // The recorded process is the server itself; `/T` takes anything it started along.
      yield* spawner
        .string(
          ChildProcess.make("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
            stdin: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.timeout("15 seconds"), Effect.ignore);
      // Judged by the process rather than taskkill's output: the entry stays unless the server
      // is known to be gone, so a later start can try again.
      const after = yield* observeOrUnknown(entry.pid);
      return after !== "unknown" && (after === undefined || after.startTime !== entry.startTime);
    }
    signalGroup(entry.pgid, "SIGTERM");
    for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS && groupExists(entry.pgid); attempt++) {
      yield* Effect.sleep(STOP_POLL_INTERVAL);
    }
    // The group never emptied, so its pgid cannot have been reused.
    if (groupExists(entry.pgid)) signalGroup(entry.pgid, "SIGKILL");
    return true;
  });

  const reapEntry = Effect.fn("OpenCodeServerLedger.reapEntry")(
    function* (entryPath: string) {
      const entry = decodeEntry(yield* fs.readFileString(entryPath));
      if (Option.isSome(entry) && entry.value.stateDir === input.stateDir) {
        // Running or unknown: the entry stays for a later start.
        if ((yield* isRunning(entry.value.owner)) !== false) return;
        if (!(yield* stopOrphan(entry.value))) return;
      }
      yield* fs.remove(entryPath, { force: true });
    },
    (effect, entryPath) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not clean up a recorded OpenCode server", { entryPath, cause }),
        ),
      ),
  );

  const reapOrphans = Effect.gen(function* () {
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      names.filter((name) => ENTRY_FILE.test(name)),
      (name) => reapEntry(path.join(directory, name)),
      { concurrency: "unbounded", discard: true },
    );
  });

  // `record` is `track` without the Windows background fork, for callers that need the entry.
  return { track, record, reapOrphans };
});

export const layer = (input: { readonly stateDir: string }) =>
  Layer.effect(
    OpenCodeServerLedger,
    Effect.gen(function* () {
      const ledger = yield* make(input);
      yield* ledger.reapOrphans.pipe(Effect.forkScoped);
      return OpenCodeServerLedger.of({ track: ledger.track });
    }),
  );

export const layerTest = Layer.succeed(
  OpenCodeServerLedger,
  OpenCodeServerLedger.of({ track: () => Effect.succeed(Effect.void) }),
);
