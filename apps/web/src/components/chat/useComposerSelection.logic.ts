import type { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

/**
 * The options a model pick starts with. The same model on another account of the thread's
 * provider is an account swap and keeps the thread's options; otherwise the options last used
 * with that model on that account, or the thread's own when it is the same model there.
 */
export function modelPickOptions(input: {
  readonly pick: { readonly instanceId: ProviderInstanceId; readonly driver: ProviderDriverKind };
  readonly thread: ModelSelection;
  readonly threadDriver: ProviderDriverKind | undefined;
  readonly sameModel: boolean;
  readonly remembered: ModelSelection["options"] | undefined;
}): ModelSelection["options"] | undefined {
  const { pick, thread, sameModel, remembered } = input;
  const threadOptions = thread.options !== undefined && thread.options.length > 0;
  if (
    sameModel &&
    threadOptions &&
    thread.instanceId !== pick.instanceId &&
    input.threadDriver === pick.driver
  ) {
    return thread.options;
  }
  if (remembered !== undefined && remembered.length > 0) return remembered;
  return sameModel && thread.instanceId === pick.instanceId ? thread.options : undefined;
}
