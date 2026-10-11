/**
 * Decides which new turns "Pause all queues" holds back.
 *
 * The pause first only stopped a queue from moving up. A message sent to a
 * thread that stands still is not in a queue, so it started at once, and
 * agents writing to each other kept threads running through the pause. With
 * this, the pause means: nothing starts unless the user starts it.
 *
 * @module QueuePauseHold
 */
import type { OrchestrationV2Command } from "@t3tools/contracts";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * Whether the message would start a turn the user did not ask for just now:
 * sent by an agent or the server, relayed by a tool, or fired by a scheduled
 * task. What the user types into a client is theirs and goes through.
 * Messages aimed at a run under way (a steer, a restart) are not new turns.
 */
export function startsWithoutTheUser(
  command: Pick<
    MessageDispatch,
    "createdBy" | "creationSource" | "scheduledTaskId" | "dispatchMode"
  >,
): boolean {
  if (
    command.dispatchMode.type === "steer_active" ||
    command.dispatchMode.type === "restart_active"
  ) {
    return false;
  }
  return (
    command.createdBy !== "user" ||
    command.scheduledTaskId !== undefined ||
    (command.creationSource !== "web" && command.creationSource !== "mobile")
  );
}
