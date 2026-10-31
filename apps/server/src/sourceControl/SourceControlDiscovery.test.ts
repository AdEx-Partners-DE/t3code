import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { SourceControlProviderKind, VcsProcessSpawnError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import {
  fakeDiscovery,
  fakeSourceControlProvider,
} from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const kind = SourceControlProviderKind.make;

// Serves both the host's runs and the server's own VCS probes, whose inputs share these fields.
const run = (
  input: Pick<
    SourceControlHost.SourceControlProcessInput,
    "operation" | "command" | "args" | "cwd"
  >,
): Effect.Effect<SourceControlHost.SourceControlProcessOutput, VcsProcessSpawnError> => {
  if (input.args[0] === "--version") {
    return input.command === "missing-cli"
      ? Effect.fail(
          new VcsProcessSpawnError({
            operation: input.operation,
            command: input.command,
            cwd: input.cwd,
            cause: new Error(`${input.command} not found`),
          }),
        )
      : Effect.succeed(TestSourceControlHost.processOutput(`${input.command} version test\n`));
  }
  return Effect.succeed(
    TestSourceControlHost.processOutput(`signed in as ${input.command}-user\n`),
  );
};

const cliDiscovery = (name: string) => ({
  type: "cli" as const,
  kind: kind(name),
  label: name,
  installHint: `Install ${name}.`,
  executable: name === "beta" ? "missing-cli" : `${name}-cli`,
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: ({ stdout }: { readonly stdout: string }) =>
    providerAuth({ status: "authenticated", account: /as (\S+)/.exec(stdout)?.[1] }),
});

const layerDiscovery = (runProcess = run) =>
  Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    SourceControlProviderRegistry.makeWithProviders(
      [
        cliDiscovery("alpha"),
        cliDiscovery("beta"),
        fakeDiscovery("gamma", {
          probeAuth: Effect.succeed(providerAuth({ status: "authenticated", account: "api-user" })),
        }),
      ].map((discovery) => ({
        kind: discovery.kind,
        provider: fakeSourceControlProvider(discovery.kind),
        discovery,
      })),
    ),
  ).pipe(
    Layer.provideMerge(TestSourceControlHost.layer({ process: { run: runProcess } })),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
    Layer.provideMerge(Layer.mock(VcsProcess.VcsProcess)({ run: runProcess })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("reports every hosting integration in registry order with its sign-in", () =>
  Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        version: item.version,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: kind("alpha"),
          status: "available",
          version: Option.some("alpha-cli version test"),
          auth: "authenticated",
          account: Option.some("alpha-cli-user"),
        },
        {
          kind: kind("beta"),
          status: "missing",
          version: Option.none(),
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: kind("gamma"),
          status: "available",
          version: Option.none(),
          auth: "authenticated",
          account: Option.some("api-user"),
        },
      ],
    );
    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => [item.kind, item.status]),
      [
        ["git", "available"],
        ["jj", "available"],
      ],
    );
  }).pipe(Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery())))),
);

it.effect.each(["darwin", "linux"] as const)(
  "names incompatible executables only on macOS (%s)",
  (platform) => {
    const runProcess: typeof run = (input) =>
      Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause:
            input.command === "missing-cli"
              ? new Error("not found")
              : Object.assign(new Error("spawn Unknown system error -86"), { errno: -86 }),
        }),
      );
    return Effect.gen(function* () {
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const result = yield* discovery.discover;
      for (const item of [...result.versionControlSystems, ...result.sourceControlProviders]) {
        if (item.kind === kind("gamma")) continue;
        assert.strictEqual(item.status, "missing");
        if (platform === "darwin" && item.executable !== "missing-cli") {
          assert.include(
            item.installHint,
            `\`/usr/local/bin/${item.executable}\` is built for another CPU architecture, so this arm64 machine cannot run it. Remove or replace it.`,
          );
        } else {
          assert.notInclude(item.installHint, "CPU architecture");
        }
      }
    }).pipe(
      Effect.provide(SourceControlDiscovery.layer.pipe(Layer.provide(layerDiscovery(runProcess)))),
      Effect.provideService(SpawnExecutableResolution, (command) => `/usr/local/bin/${command}`),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, "arm64"),
    );
  },
);

/** A discovery whose `jj` probe counts its spawns; `jjDelay` keeps a scan in flight. */
const makeCachingDiscoveryTest = (jjDelay?: Duration.Input) => {
  let jjSpawns = 0;
  const processMock = {
    // Counts when the spawn runs, as a real process start would, not when it is built.
    run: (input: VcsProcess.VcsProcessInput) =>
      Effect.suspend(() => {
        if (input.command === "git") {
          return Effect.succeed(TestSourceControlHost.processOutput("git version 2.51.0\n"));
        }
        const spawnFailure = new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        });
        if (input.command !== "jj") return Effect.fail(spawnFailure);
        jjSpawns += 1;
        return jjDelay === undefined
          ? Effect.fail(spawnFailure)
          : Effect.sleep(jjDelay).pipe(Effect.andThen(Effect.fail(spawnFailure)));
      }),
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layer = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-cache-" }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        discover: Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, jjSpawns: () => jjSpawns };
};

it.effect("keeps a scan for repeated discovers and scans again on rescan", () => {
  const test = makeCachingDiscoveryTest();
  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    yield* discovery.discover;
    yield* discovery.discover;
    assert.strictEqual(test.jjSpawns(), 1);
    yield* discovery.rescan;
    assert.strictEqual(test.jjSpawns(), 2);
    yield* discovery.discover;
    assert.strictEqual(test.jjSpawns(), 2);
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps the scan when the client that started it leaves before it ends", () => {
  const test = makeCachingDiscoveryTest("1 second");
  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const leaving = yield* Effect.forkChild(discovery.discover);
    yield* TestClock.adjust("10 millis");
    yield* Fiber.interrupt(leaving);
    yield* TestClock.adjust("2 seconds");
    yield* discovery.discover;
    assert.strictEqual(test.jjSpawns(), 1);
  }).pipe(Effect.provide(test.layer));
});
