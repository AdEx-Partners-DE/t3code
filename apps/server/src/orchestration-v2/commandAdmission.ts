import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";

// A short deployment lease rejects mutations by default. Only operations that
// finish, stop, or discard existing work may bypass admission; their queue
// promotion still goes through WorkAdmission.whenOpen.
export function requiresWorkAdmission(command: OrchestrationV2ServerCommand): boolean {
  switch (command.type) {
    case "thread.stop":
    case "thread.settle":
    case "run.interrupt":
    case "subagent.stop":
    case "thread.background-work.settle":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "checkpoint.rollback.fail":
    case "notification.delivery.accept":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "queue.hold":
    case "queue.clear":
    case "queued-run.cancel":
      return false;
    default:
      return true;
  }
}
