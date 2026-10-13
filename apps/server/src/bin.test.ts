import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const runCli = vi.fn();
const runLauncher = vi.fn<() => Promise<void>>();
const runAcp = vi.fn<() => Promise<void>>();

const loadBin = (
  args: string[],
  options: { rejectFullCli?: boolean; entrypoint?: boolean } = {},
) => {
  process.argv = [process.execPath, "bin.ts", ...args];
  vi.doMock("./entrypoint.ts", () => ({ isEntrypoint: () => options.entrypoint !== false }));
  vi.doMock("./binCli.ts", () => {
    if (options.rejectFullCli) throw new Error("full CLI evaluated");
    return { runCli };
  });
  vi.doMock("./serviceLauncher.ts", () => ({ main: runLauncher }));
  vi.doMock("./mcp/AcpMcpStdioBridge.ts", () => ({ runAcpMcpCliFastPath: runAcp }));
  return import("./bin.ts");
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runLauncher.mockResolvedValue(undefined);
  runAcp.mockResolvedValue(undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.doUnmock("./entrypoint.ts");
  vi.doUnmock("./binCli.ts");
  vi.doUnmock("./serviceLauncher.ts");
  vi.doUnmock("./mcp/AcpMcpStdioBridge.ts");
});

describe("CLI entry dispatch", () => {
  it("starts the bare service launcher without evaluating the full CLI", async () => {
    await loadBin(["__service-launcher"], { rejectFullCli: true });
    expect(runLauncher).toHaveBeenCalledExactlyOnceWith();
    expect(runCli).not.toHaveBeenCalled();
  });

  it.each([new Error("launcher failed"), "launcher failed"])(
    "reports launcher rejection without loading the full CLI: %s",
    async (cause) => {
      const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      runLauncher.mockRejectedValue(cause);
      await loadBin(["__service-launcher"], { rejectFullCli: true });
      expect(write).toHaveBeenCalledWith("[service-launcher] launcher failed\n");
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    { args: [] },
    { args: ["serve"] },
    { args: ["--help"] },
    { args: ["__service-launcher", "--help"] },
    { args: ["__service-launcher", "--invalid"] },
    { args: ["__service-launcher", "extra"] },
    { args: ["--home-dir", "/tmp/example", "__service-launcher"] },
  ])("keeps CLI parsing for $args", async ({ args }) => {
    await loadBin(args);
    expect(runCli).toHaveBeenCalledExactlyOnceWith();
    expect(runLauncher).not.toHaveBeenCalled();
  });

  it.each(["acp-mcp-bridge", "acp-mcp-call"])("preserves the %s fast path", async (command) => {
    await loadBin([command, "--example", "value"], { rejectFullCli: true });
    expect(runAcp).toHaveBeenCalledExactlyOnceWith(command, ["--example", "value"]);
    expect(runLauncher).not.toHaveBeenCalled();
  });

  it("does not execute a command when imported", async () => {
    await loadBin(["__service-launcher"], { rejectFullCli: true, entrypoint: false });
    expect(runCli).not.toHaveBeenCalled();
    expect(runLauncher).not.toHaveBeenCalled();
    expect(runAcp).not.toHaveBeenCalled();
  });
});
