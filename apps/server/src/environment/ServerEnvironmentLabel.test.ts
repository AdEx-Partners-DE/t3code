import { afterEach, assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerEnvironmentLabel from "./ServerEnvironmentLabel.ts";

const { resolveServerEnvironmentLabel } = ServerEnvironmentLabel;
const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const layerProcessRunnerTest = Layer.succeed(
  ProcessRunner.ProcessRunner,
  ProcessRunner.ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);
const layerLinuxMachineInfo = Layer.merge(
  layerProcessRunnerTest,
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(path === "/etc/machine-info"),
    readFileString: (path) =>
      path === "/etc/machine-info"
        ? Effect.succeed('PRETTY_HOSTNAME="Build Agent 01"\nICON_NAME="computer-vm"\n')
        : Effect.succeed(""),
  }),
);
const withHostPlatform = <ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
  platform: NodeJS.Platform,
  hostname: string,
) =>
  Layer.mergeAll(
    layer,
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Hostname, hostname),
  );

afterEach(() => {
  runMock.mockReset();
});

describe("resolveServerEnvironmentLabel", () => {
  it.effect("prefers T3CODE_ENVIRONMENT_LABEL over every host name", () =>
    Effect.gen(function* () {
      const resolve = (env: Record<string, string>) =>
        ServerEnvironmentLabel.resolveServerEnvironmentLabel({ cwdBaseName: "t3code" }).pipe(
          Effect.provide(
            Layer.merge(
              withHostPlatform(layerLinuxMachineInfo, "linux", "desktop-gaming"),
              ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
            ),
          ),
        );

      expect(yield* resolve({ T3CODE_ENVIRONMENT_LABEL: "  DESKTOP-GAMING Alpha " })).toBe(
        "DESKTOP-GAMING Alpha",
      );
      // Blank means unset, so the machine's own name still applies.
      expect(yield* resolve({ T3CODE_ENVIRONMENT_LABEL: "  " })).toBe("Build Agent 01");
    }),
  );
});

const neverExits = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.never,
      stderr: Stream.never,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

it.effect("falls back to the hostname when hostnamectl never answers", () =>
  Effect.gen(function* () {
    // Without /etc/machine-info the label comes from hostnamectl, which waits on D-Bus.
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Hostname, "devbox"),
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, neverExits)),
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 seconds");
    assert.equal(yield* Fiber.join(label), "devbox");
  }),
);
