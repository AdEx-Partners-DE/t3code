/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `t3 acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Those commands and the argument-free
 * service launcher dispatch before the full CLI module graph loads. Other
 * invocations defer to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  // Guard sockets before any dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__service-launcher" && process.argv.length === 3) {
    // The launcher owns shutdown signals. Keep it outside the full CLI's
    // Effect runtime, as on the existing serviceLauncherCommand path.
    const { main: runServiceLauncher } = await import("./serviceLauncher.ts");
    runServiceLauncher().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      process.stderr.write(`[service-launcher] ${error.message}\n`);
      process.exitCode = 1;
    });
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    // Before anything reads stdin: the desktop app's Windows launcher starts
    // the CLI without one. Never for the fast paths, whose stdin is a pipe.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
