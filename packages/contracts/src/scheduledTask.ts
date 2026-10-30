import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local time as HH:MM, such as 09:30." });

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0));

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval"),
  everyMs: ScheduledTaskIntervalMs,
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time"),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday. 0 is Sunday, 6 is Saturday.",
      }),
    ).annotate({
      description: "Default: every day.",
    }),
  ),
});

const ScheduledTaskWebhookSignatureFields = {
  header: TrimmedNonEmptyString.annotate({
    description: "Header with the signature, such as x-hub-signature-256.",
  }),
  encoding: Schema.Literals(["hex", "base64"]),
  prefix: Schema.String.annotate({
    description: "Text before the digest, such as 'sha256='. Empty for none.",
  }),
};

export const ScheduledTaskWebhookSignature = Schema.Struct(
  ScheduledTaskWebhookSignatureFields,
).annotate({ description: "HMAC-SHA256 check on the raw body." });
export type ScheduledTaskWebhookSignature = typeof ScheduledTaskWebhookSignature.Type;

/** Matches how long the relay holds a request for an offline environment. */
export const MAX_WEBHOOK_DELIVERY_AGE_MINUTES = 24 * 60;

const WebhookMaxDeliveryAgeMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_WEBHOOK_DELIVERY_AGE_MINUTES }),
).annotate({
  description: "Skip requests held offline over this many minutes. Omit to run all.",
});

export function isWebhookDedupeTemplate(template: string): boolean {
  const placeholders = /\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}/g;
  const matches = [...template.matchAll(placeholders)];
  const remainder = template.replace(placeholders, "");
  return matches.length > 0 && !remainder.includes("{{") && !remainder.includes("}}");
}

const WebhookDedupeTemplate = Schema.String.check(Schema.makeFilter(isWebhookDedupeTemplate));

const ScheduledTaskWebhookDedupe = Schema.Struct({
  replayKey: Schema.optional(WebhookDedupeTemplate),
  coalesceKey: Schema.optional(WebhookDedupeTemplate),
  coalesceWindowSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
}).annotate({
  description: "Replay and coalesce key templates. Window in seconds, default 120.",
});

export const MAX_WEBHOOK_FILTERS = 16;

const WebhookFilterPath = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(body|headers|query)(\.|$)/),
);

/**
 * Forms edit an `in` list as comma-separated text, so a value that has no
 * comma and no surrounding whitespace survives that round trip unchanged.
 */
const WebhookFilterListValue = Schema.String.check(
  Schema.isPattern(/^[^,\s](?:[^,]*[^,\s])?$/),
).annotate({ description: "Non-empty, without commas or surrounding whitespace." });

export const ScheduledTaskWebhookFilter = Schema.Union([
  Schema.Struct({
    path: WebhookFilterPath,
    op: Schema.Literals(["equals", "notEquals", "startsWith"]),
    value: Schema.String,
  }),
  Schema.Struct({
    path: WebhookFilterPath,
    op: Schema.Literal("in"),
    value: Schema.Array(WebhookFilterListValue).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ path: WebhookFilterPath, op: Schema.Literal("exists") }),
]).annotate({
  description:
    "Path: `headers.x-event` or `body.action`. String compare. Objects pass only 'exists'. A `[]` segment matches any array item. `notEquals` passes only if no item equals.",
});
export type ScheduledTaskWebhookFilter = typeof ScheduledTaskWebhookFilter.Type;
export type ScheduledTaskWebhookFilterOp = ScheduledTaskWebhookFilter["op"];

const ScheduledTaskWebhookFilters = Schema.Array(ScheduledTaskWebhookFilter)
  .check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS))
  .annotate({
    description: "All must match. Max 16. Omitted: keep stored. [] clears.",
  });

const ScheduledTaskWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: Schema.NullOr(ScheduledTaskWebhookSignature),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
}).annotate({
  description: "Run on each webhook request.",
});

const ScheduledTaskUpsertWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...ScheduledTaskWebhookSignatureFields,
        secret: Schema.optional(TrimmedNonEmptyString).annotate({
          description: "Default: stored secret.",
        }),
        secretRef: Schema.optional(SecretRef).annotate({
          description: "From `request_secret`. Instead of `secret`. Spent by this save.",
        }),
      }),
    ),
  ).annotate({
    description: "Omit for URL token only.",
  }),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
}).annotate({
  description:
    "Run per webhook request. Prompt can use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}}, {{request}}.",
});

/**
 * Run the prompt each time the bound thread goes idle: no run active or
 * queued, nothing waiting on the user. Both limits are required, because a
 * prompt that answers every finished run would otherwise never stop.
 */
export const ScheduledTaskIdleSchedule = Schema.Struct({
  type: Schema.Literal("idle").annotate({
    description: "Run when the bound thread has finished and nothing waits on the user.",
  }),
  maxRuns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({
    description: "The task turns itself off after this many runs.",
  }),
  minPauseMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
    description: "Shortest wait after a run ends before the next one may start.",
  }),
  stopPhrase: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMinLength(3), Schema.isMaxLength(80)),
  ).annotate({
    description:
      "The task turns itself off instead of running when the thread's last reply contains this text, ignoring case.",
  }),
  allOpenThreads: Schema.optional(Schema.Boolean).annotate({
    description:
      "Send to every open thread that stands still instead of one bound thread. The task then has no thread of its own; maxRuns counts the sends over all threads.",
  }),
  maxParallel: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  ).annotate({
    description:
      "With allOpenThreads: send only while fewer than this many open threads are at work. Defaults to 2.",
  }),
  projectOnly: Schema.optional(Schema.Boolean).annotate({
    description: "With allOpenThreads: cover only the open threads of the task's project.",
  }),
  excludeThreadIds: Schema.optional(Schema.Array(ThreadId)).annotate({
    description: "With allOpenThreads: threads this task never sends to.",
  }),
  supervise: Schema.optional(Schema.Boolean).annotate({
    description:
      "With allOpenThreads: a model reads each standing thread's last reply first. A thread that only asked for leave it already has gets an instruction to go on instead of the task's prompt; a thread that really needs the user is left alone. At most twice per thread until the user writes in it again.",
  }),
  superviseDryRun: Schema.optional(Schema.Boolean).annotate({
    description:
      "With supervise: only record each verdict and the instruction that would be sent, and send nothing. For trying the supervisor on real threads.",
  }),
  /** With supervise: per thread, how often this task has sent it on. Kept by the server. */
  supervised: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
  /** With supervise: per thread, when this task last sent it on. Kept by the server. */
  supervisedAt: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** With allOpenThreads: per thread, the run this task last reacted to. Kept by the server. */
  nudged: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  watchThreadId: Schema.optional(ThreadId).annotate({
    description:
      "Wait for this thread to finish instead of the task's own thread. With maxRuns 1 this starts one thread's work after another's.",
  }),
  minRemainingPercent: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
  ).annotate({
    description:
      "The task turns itself off instead of running when the thread's account has less than this much of its tightest usage window left.",
  }),
  /** Runs since the task was last armed. Kept by the server; saving or enabling resets it. */
  runsUsed: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).annotate({
  description: "Run each time the bound thread goes idle, up to a fixed number of runs.",
});
export type ScheduledTaskIdleSchedule = typeof ScheduledTaskIdleSchedule.Type;

/**
 * Read model for persisted schedules. Keep accepting legacy sub-minute rows so
 * users can list, disable, edit, or delete them after the write minimum changes.
 */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskWebhookSchedule,
  ScheduledTaskIdleSchedule,
]);
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Min 60000.",
    }),
  }),
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskUpsertWebhookSchedule,
  ScheduledTaskIdleSchedule,
]);
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTaskWebhookEndpoint = Schema.Struct({
  path: TrimmedNonEmptyString,
  url: Schema.NullOr(TrimmedNonEmptyString),
  hasSecret: Schema.Boolean,
});
export type ScheduledTaskWebhookEndpoint = typeof ScheduledTaskWebhookEndpoint.Type;

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  webhook: Schema.optional(ScheduledTaskWebhookEndpoint),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  tasks: ForwardCompatibleArray(ScheduledTask),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskRotateWebhookTokenInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRotateWebhookTokenInput = typeof ScheduledTaskRotateWebhookTokenInput.Type;

export const ScheduledTaskWebhookDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ScheduledTaskWebhookDeliveryId"),
);
export type ScheduledTaskWebhookDeliveryId = typeof ScheduledTaskWebhookDeliveryId.Type;

export const ScheduledTaskWebhookDeliveryOutcome = Schema.Literals([
  "accepted",
  "dispatch_failed",
  "duplicate",
  "coalesced",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
  "filtered",
]);
export type ScheduledTaskWebhookDeliveryOutcome = typeof ScheduledTaskWebhookDeliveryOutcome.Type;

export const ScheduledTaskWebhookDeliverySummary = Schema.Struct({
  id: ScheduledTaskWebhookDeliveryId,
  taskId: ScheduledTaskId,
  receivedAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  contentType: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // Any string, so an outcome added later doesn't break a client's whole list.
  outcome: Schema.Union([ScheduledTaskWebhookDeliveryOutcome, Schema.String]),
  signatureVerified: Schema.Boolean,
  pendingWindow: Schema.optional(Schema.Boolean),
  missingFields: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDeliverySummary = typeof ScheduledTaskWebhookDeliverySummary.Type;

export const ScheduledTaskWebhookDelivery = Schema.Struct({
  ...ScheduledTaskWebhookDeliverySummary.fields,
  query: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  renderedPrompt: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDelivery = typeof ScheduledTaskWebhookDelivery.Type;

export const ScheduledTaskListWebhookDeliveriesInput = Schema.Struct({
  id: ScheduledTaskId,
  /**
   * Sent by clients that decode any outcome. Shipped clients decode a closed
   * list and fail on the whole response, so without it the server leaves out
   * rows with outcomes they don't know.
   */
  acceptAnyOutcome: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskListWebhookDeliveriesInput =
  typeof ScheduledTaskListWebhookDeliveriesInput.Type;

export const ScheduledTaskListWebhookDeliveriesResult = Schema.Struct({
  deliveries: Schema.Array(ScheduledTaskWebhookDeliverySummary),
});
export type ScheduledTaskListWebhookDeliveriesResult =
  typeof ScheduledTaskListWebhookDeliveriesResult.Type;

export const ScheduledTaskGetWebhookDeliveryInput = Schema.Struct({
  id: ScheduledTaskId,
  deliveryId: ScheduledTaskWebhookDeliveryId,
  acceptAnyOutcome: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskGetWebhookDeliveryInput = typeof ScheduledTaskGetWebhookDeliveryInput.Type;

export const ScheduledTaskGetWebhookDeliveryResult = Schema.Struct({
  delivery: ScheduledTaskWebhookDelivery,
});
export type ScheduledTaskGetWebhookDeliveryResult =
  typeof ScheduledTaskGetWebhookDeliveryResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// "Pause all tasks" holds every scheduled task of an environment at once. A task
// the user switches on again while the pause is on is exempt and runs. Server and
// clients share this one rule, so a task's switch shows what the scheduler does.

/** Whether the pause keeps this task from running. */
export function isTaskHeldByPause(
  taskId: string,
  paused: boolean,
  exemptIds: ReadonlyArray<string>,
): boolean {
  return paused && !exemptIds.includes(taskId);
}

/**
 * What a task's own switch should show: on only when the task is enabled and
 * the pause does not hold it.
 */
export function taskRunsOnItsOwn(
  task: { readonly id: string; readonly enabled: boolean },
  paused: boolean,
  exemptIds: ReadonlyArray<string>,
): boolean {
  return task.enabled && !isTaskHeldByPause(task.id, paused, exemptIds);
}
