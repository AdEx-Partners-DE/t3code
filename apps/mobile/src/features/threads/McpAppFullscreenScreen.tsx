import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadMcpApp } from "./McpAppWebView";

type McpAppFullscreenScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly conversationThreadId?: string;
  readonly itemId: string;
  readonly revision?: string;
}>;

/**
 * The thread an app's messages go to. A link only names it, so it counts only
 * when it is the app's own thread or a fork of it; anything else falls back to
 * the app's thread.
 */
function useConversationThreadId(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requested: string | undefined,
): ThreadId {
  const shells = useThreadShells();
  return useMemo(
    () =>
      requested !== undefined && descendsFrom(shells, environmentId, requested, threadId)
        ? ThreadId.make(requested)
        : threadId,
    [shells, environmentId, threadId, requested],
  );
}

/** True when `threadId` is `ancestorId` or one of its forks, at any depth. */
function descendsFrom(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  threadId: string,
  ancestorId: ThreadId,
): boolean {
  const parents = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId)
      .map((shell) => [shell.id as string, shell.lineage.parentThreadId]),
  );
  let current: string | null | undefined = threadId;
  for (let depth = 0; depth < 64 && current != null; depth += 1) {
    if (current === ancestorId) return true;
    current = parents.get(current);
  }
  return false;
}

/**
 * An MCP App full screen (`ui/request-display-mode`), in a modal over the
 * thread. It is its own view of the app; closing it returns to the row. The
 * app is read from its stored tool call, never from the route, so a link can
 * only open an app that call really produced.
 */
export function McpAppFullscreenScreen({ route }: McpAppFullscreenScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const itemId = TurnItemId.make(params.itemId);
  const conversationThreadId = useConversationThreadId(
    environmentId,
    threadId,
    params.conversationThreadId,
  );
  const detail = useEnvironmentQuery(
    orchestrationEnvironment.turnItem({
      environmentId,
      input: {
        threadId,
        itemId,
        ...(params.revision === undefined ? {} : { revision: params.revision }),
      },
    }),
  );
  const item = detail.data?.item;
  // One reference per stored item: a new object each render would rebuild the
  // app's host on every layout change, such as rotating the device.
  const app = useMemo(
    () => (item?.type === "dynamic_tool" ? mcpAppFromToolItem(item) : undefined),
    [item],
  );

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="h-11 flex-row items-center justify-between px-3">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {app?.server ?? "App"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit full screen"
          hitSlop={8}
          onPress={onClose}
        >
          <SymbolView name="xmark" size={18} tintColor="gray" />
        </Pressable>
      </View>
      <View
        className="flex-1"
        style={{ paddingBottom: insets.bottom }}
        onLayout={(event) =>
          setSize({
            width: Math.round(event.nativeEvent.layout.width),
            height: Math.round(event.nativeEvent.layout.height - insets.bottom),
          })
        }
      >
        {app === undefined ? (
          detail.data === undefined ? null : (
            <Text className="m-6 text-sm text-foreground-muted">This app cannot be shown.</Text>
          )
        ) : size.width > 0 ? (
          <ThreadMcpApp
            environmentId={environmentId}
            threadId={threadId}
            conversationThreadId={conversationThreadId}
            itemId={itemId}
            revision={params.revision ?? (item == null ? "" : turnItemDetailRevision(item))}
            app={app}
            width={size.width}
            height={size.height}
            displayMode="fullscreen"
            onExitFullscreen={onClose}
          />
        ) : null}
      </View>
    </View>
  );
}
