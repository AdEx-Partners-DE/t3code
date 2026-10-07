import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { readMcpAppReference } from "@t3tools/shared/mcpApp";
import * as Schema from "effect/Schema";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ThreadMcpApp } from "./McpAppWebView";

const decodeAppJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

type McpAppFullscreenScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly conversationThreadId: string;
  readonly itemId: string;
  readonly revision: string;
  /** The app's reference, as JSON: the screen hosts the same app the row did. */
  readonly app: string;
}>;

/**
 * An MCP App full screen (`ui/request-display-mode`), in a modal over the
 * thread. It is its own view of the app; closing it returns to the row.
 */
export function McpAppFullscreenScreen({ route }: McpAppFullscreenScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const params = route.params;
  const app = decodeAppJson(params.app).pipe((parsed) =>
    parsed._tag === "Some" ? readMcpAppReference(parsed.value) : undefined,
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
          <Text className="m-6 text-sm text-foreground-muted">This app cannot be shown.</Text>
        ) : size.width > 0 ? (
          <ThreadMcpApp
            environmentId={EnvironmentId.make(params.environmentId)}
            threadId={ThreadId.make(params.threadId)}
            conversationThreadId={ThreadId.make(params.conversationThreadId)}
            itemId={TurnItemId.make(params.itemId)}
            revision={params.revision}
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
