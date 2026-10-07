import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  mcpResourceBytes,
  type McpAppCallToolResult,
  type McpAppDisplayMode,
  type McpAppHost,
  type McpAppHostContext,
} from "@t3tools/client-runtime/mcp-apps";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  clampMcpAppHeight,
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  mcpAppAllowAttribute,
  mcpAppFileName,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import { Minimize2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useAssetUrlState } from "~/assets/assetUrls";
import { APP_VERSION } from "~/branding";
import { requestConfirmDialog } from "~/confirmDialog";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useTurnItemDetail } from "~/state/queries";
import { mcpAppEnvironment } from "~/state/mcpApps";
import { useAtomCommand } from "~/state/use-atom-command";

const commandFailure = (result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) => {
  const error = squashAtomCommandFailure(result);
  return new McpAppHostRefusal(
    error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  );
};

/** Largest file an app may hand the user through `ui/download-file`. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Saves a file through the browser's own download, which asks where when it is set to. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // After the click has started the download.
  queueMicrotask(() => URL.revokeObjectURL(url));
}

/**
 * An MCP App inline in the thread: the captured document in an opaque-origin
 * frame, speaking the MCP Apps bridge. Its tool calls and resource reads reach
 * its own MCP server through the environment; calls to tools the server does
 * not mark read-only, chat messages, and downloads ask first. Full screen keeps
 * the same frame (and the app's state) and only restyles its box.
 */
export function McpAppFrame(props: {
  readonly environmentId: EnvironmentId;
  /** The thread that produced the app, which its requests run against. */
  readonly threadId: ThreadId;
  /** The thread on screen, whose next turn the app's model context informs. */
  readonly conversationThreadId: ThreadId;
  readonly itemId: TurnItemId;
  /** The item's revision, so its stored call is fetched once per version. */
  readonly revision: string;
  readonly app: McpAppReference;
  readonly onSendMessage: ((text: string) => Promise<void>) | undefined;
}) {
  const { app } = props;
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(MCP_APP_DEFAULT_HEIGHT);
  const [navigatedAway, setNavigatedAway] = useState(false);
  const [displayMode, setDisplayMode] = useState<McpAppDisplayMode>("inline");
  // The app asked to be closed; the row falls back to its plain tool call.
  const [closed, setClosed] = useState(false);
  // Counts the app documents this row has shown. Reopening a closed app loads
  // a new one, which needs its own host and its own load tracking.
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: app.attachmentId,
      fileName: mcpAppFileName(app),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [app],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  // The frame keeps its first URL: a re-minted one would reload the app.
  const [src, setSrc] = useState<string | null>(null);
  if (src === null && asset._tag === "Success") setSrc(asset.url);

  // The wire timeline omits tool input and output; the app needs both.
  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    threadId: props.threadId,
    itemId: props.itemId,
    revision: props.revision,
  });
  const storedItem = detail.data?.item;
  const toolCall = useMemo(() => {
    if (storedItem?.type !== "dynamic_tool") return undefined;
    const output = storedItem.output as { readonly result?: unknown } | undefined;
    const result = output?.result as McpAppCallToolResult | undefined;
    return { arguments: storedItem.input, result };
  }, [storedItem]);

  const callTool = useAtomCommand(mcpAppEnvironment.callTool, { reportFailure: false });
  const toolInfo = useAtomCommand(mcpAppEnvironment.toolInfo, { reportFailure: false });
  const readResource = useAtomCommand(mcpAppEnvironment.readResource, { reportFailure: false });
  const updateModelContext = useAtomCommand(mcpAppEnvironment.updateModelContext, {
    reportFailure: false,
  });
  // The tool's definition, which the app receives as `toolInfo` at initialize.
  const [toolDefinition, setToolDefinition] = useState<unknown>(undefined);

  // Read by the host on every message, so it always sees current values
  // without being rebuilt (which would drop the app's session).
  const live = {
    theme,
    width,
    props,
    callTool,
    toolInfo,
    readResource,
    updateModelContext,
    displayMode,
    viewport,
    toolDefinition,
  };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  // Full screen follows the window's size, and Escape returns the app inline.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const shown = box.matches(":popover-open");
    if (displayMode === "fullscreen" && !shown) box.showPopover();
    if (displayMode !== "fullscreen" && shown) box.hidePopover();
  }, [displayMode]);
  useEffect(() => {
    if (displayMode !== "fullscreen") return;
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDisplayMode("inline");
    };
    window.addEventListener("resize", measure);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("keydown", onKey);
    };
  }, [displayMode]);

  // The definition is read once per app, before the host is built, so the
  // initialize response can carry it; a failure only leaves it out.
  useEffect(() => {
    let cancelled = false;
    void latest.current
      .toolInfo({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, itemId: props.itemId, name: app.tool },
      })
      .then((info) => {
        if (!cancelled && info._tag === "Success" && info.value.tool !== undefined) {
          setToolDefinition(info.value.tool);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.threadId, props.itemId, app.tool]);
  const hostRef = useRef<McpAppHost | null>(null);
  // The bridge belongs to the captured document. A frame that navigates keeps
  // its window, so a second load stops the app rather than letting a page T3
  // never served pose as it. This is not a confidentiality boundary: a frame
  // can always navigate itself, so the app could carry anything it read out
  // in a URL either way.
  const loads = useRef(0);
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      hostRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  useEffect(() => {
    if (src === null) return;
    const hostContext = (): McpAppHostContext => {
      const current = latest.current;
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        displayMode: current.displayMode,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions:
          current.displayMode === "fullscreen"
            ? { width: current.viewport.width, height: current.viewport.height }
            : { width: current.width, maxHeight: MCP_APP_MAX_HEIGHT },
        platform: isElectron ? "desktop" : "web",
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: `t3-code/${APP_VERSION}`,
        deviceCapabilities: {
          touch: window.matchMedia("(pointer: coarse)").matches,
          hover: window.matchMedia("(hover: hover)").matches,
        },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        ...(current.toolDefinition === undefined
          ? {}
          : { toolInfo: { tool: current.toolDefinition } }),
      };
    };
    // Approvals render in the page, beneath the top layer a full-screen app
    // occupies, so the app returns inline before T3 asks.
    const ask = (message: string) => {
      flushSync(() => setDisplayMode("inline"));
      return requestConfirmDialog(message);
    };
    const target = () => frameRef.current?.contentWindow ?? null;
    const scope = () => {
      const { environmentId, threadId, itemId } = latest.current.props;
      return { environmentId, input: { threadId, itemId } };
    };
    const host = makeMcpAppHost({
      app,
      hostVersion: APP_VERSION,
      // The document's origin is opaque, so "*" is the only target that reaches it;
      // the window reference itself is what scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      hostContext,
      callTool: async ({ name, arguments: args }) => {
        const { environmentId, input } = scope();
        const info = await latest.current.toolInfo({ environmentId, input: { ...input, name } });
        if (info._tag !== "Success") throw commandFailure(info);
        if (!info.value.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
        if (!info.value.readOnly) {
          const approved = await ask(
            `Allow ${app.server} to run ${info.value.title ?? name}?\n${JSON.stringify(args, null, 2)}`,
          );
          if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        }
        const result = await latest.current.callTool({
          environmentId,
          input: { ...input, name, arguments: args },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      readResource: async ({ uri }) => {
        const { environmentId, input } = scope();
        const result = await latest.current.readResource({
          environmentId,
          input: { ...input, uri },
        });
        if (result._tag !== "Success") throw commandFailure(result);
        return result.value;
      },
      openLink: async (url) => {
        // Only right after the reader used this frame, as with HTML renders.
        if (document.activeElement !== frameRef.current || !navigator.userActivation?.isActive) {
          throw new McpAppHostRefusal("Links open only from a click in the app.");
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
      sendMessage: async (text) => {
        const send = latest.current.props.onSendMessage;
        if (send === undefined) throw new McpAppHostRefusal("Messages are not available here.");
        const approved = await ask(`Send this message from ${app.server}?\n${text}`);
        if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        await send(text);
      },
      updateModelContext: async (context) => {
        const { environmentId, input } = scope();
        const result = await latest.current.updateModelContext({
          environmentId,
          input: {
            ...input,
            ...context,
            conversationThreadId: latest.current.props.conversationThreadId,
          },
        });
        if (result._tag !== "Success") throw commandFailure(result);
      },
      requestDisplayMode: async (mode) => {
        setDisplayMode(mode);
        return mode;
      },
      downloadFile: async (files) => {
        const names = files.map((file) => file.name).join(", ");
        const approved = await ask(`Save ${names} from ${app.server}?`);
        if (approved !== true) throw new McpAppHostRefusal("Declined by the user.");
        for (const file of files) {
          // A linked file is read from the app's own server, like its other reads.
          let bytes: Uint8Array | undefined;
          let mimeType = file.mimeType ?? "application/octet-stream";
          if (file._tag === "embedded") {
            bytes = file.bytes;
          } else {
            const { environmentId, input } = scope();
            const read = await latest.current.readResource({
              environmentId,
              input: { ...input, uri: file.uri },
            });
            if (read._tag !== "Success") throw commandFailure(read);
            const content = read.value.contents[0];
            bytes = mcpResourceBytes(content);
            const declared = (content as { readonly mimeType?: unknown } | undefined)?.mimeType;
            if (typeof declared === "string") mimeType = declared;
          }
          if (bytes === undefined) throw new McpAppHostRefusal(`${file.name} has no contents.`);
          if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
            throw new McpAppHostRefusal(`${file.name} is too large to save.`);
          }
          // A copy backed by a plain ArrayBuffer, which Blob requires.
          saveBlob(new Blob([bytes.slice()], { type: mimeType }), file.name);
        }
      },
      onRequestTeardown: () => {
        if (latest.current.displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
        // The app asked to go, so it gets its teardown before the frame does.
        void host.teardown().then(() => setClosed(true));
      },
      onSizeChanged: (size) => {
        // Full screen is a fixed box; what the app reports there would leave
        // the inline row its full-screen height on the way back.
        if (latest.current.displayMode === "fullscreen") return;
        if (size.height !== undefined) setHeight(clampMcpAppHeight(size.height));
      },
    });
    hostRef.current = host;
    const receive = (event: MessageEvent) => {
      // Only messages from this frame's own window reach its host.
      if (event.source !== null && event.source === target()) host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      // An unmount cannot wait: the request goes out before the frame does,
      // which is all a list that recycles rows can offer the app.
      void host.teardown();
      hostRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reopened document needs a new host.
  }, [src, app, documentGeneration]);

  // The host reads the context through `latest`; these only say when to resend.
  useEffect(() => {
    hostRef.current?.updateHostContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Context changes trigger a resend.
  }, [theme, width, displayMode, viewport, toolDefinition]);

  // A new document gets a new host, which needs the call again.
  useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall(toolCall);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each new document needs the call.
  }, [toolCall, src, documentGeneration]);

  // An app that asked to close keeps the box an inline row had, so the
  // timeline does not jump, and says how to bring it back.
  if (closed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-muted-foreground text-xs">
        <span>The {app.server} app was closed</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            loads.current = 0;
            setDocumentGeneration((value) => value + 1);
            setClosed(false);
          }}
        >
          Show app
        </Button>
      </div>
    );
  }

  const fullscreen = displayMode === "fullscreen";
  return (
    // The row keeps its inline height while the app is full screen, so the
    // timeline does not jump; the box itself is what goes full screen.
    <div style={{ height }}>
      <div
        ref={boxRef}
        // Full screen is the same box shown in the browser's top layer: moving
        // the frame to another parent would reload the app, and the timeline's
        // rows contain fixed positioning, which the top layer escapes.
        popover="manual"
        className={cn(
          "relative size-full overflow-hidden",
          app.prefersBorder === true && !fullscreen && "rounded-lg border border-border",
          fullscreen
            ? "fixed inset-0 m-0 flex h-dvh max-h-none w-dvw max-w-none flex-col border-0 bg-background p-0"
            : // A closed popover is hidden; inline, the box is a plain block.
              "block! static! m-0 border-0 bg-transparent p-0 text-inherit",
        )}
      >
        {fullscreen ? (
          <div className="flex h-10 shrink-0 items-center justify-between border-border border-b px-3 text-sm">
            <span className="truncate">{app.server}</span>
            <Button
              aria-label="Exit full screen"
              size="icon-sm"
              variant="ghost"
              onClick={() => setDisplayMode("inline")}
            >
              <Minimize2Icon className="size-4" />
            </Button>
          </div>
        ) : null}
        {navigatedAway ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            The {app.server} app left its page and was stopped
          </p>
        ) : src !== null ? (
          <iframe
            ref={frameRef}
            src={src}
            title={`${app.server} app`}
            // Never allow-same-origin: the opaque origin keeps the app out of the session.
            sandbox="allow-scripts allow-forms"
            allow={mcpAppAllowAttribute(app.permissions)}
            onLoad={onFrameLoad}
            className={cn("block w-full border-0", fullscreen ? "min-h-0 flex-1" : "h-full")}
            style={{ colorScheme: theme.appearance }}
          />
        ) : asset._tag === "Failure" ? (
          <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
            Unable to load the {app.server} app
          </p>
        ) : null}
      </div>
    </div>
  );
}
