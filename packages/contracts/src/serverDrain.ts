import * as Schema from "effect/Schema";

const LeaseId = Schema.String.check(Schema.isUUID(4));

export const ServerDrainInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("acquire"),
    leaseId: LeaseId,
    recoveryPolicy: Schema.optional(Schema.Literal("s97")),
  }),
  Schema.Struct({ operation: Schema.Literal("cancel"), leaseId: LeaseId }),
  Schema.Struct({ operation: Schema.Literal("status") }),
]);
export type ServerDrainInput = typeof ServerDrainInput.Type;

export const ServerDrainState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("open"), pid: Schema.Int }),
  Schema.Struct({
    state: Schema.Literal("acquiring"),
    pid: Schema.Int,
    leaseId: LeaseId,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    state: Schema.Literal("held"),
    pid: Schema.Int,
    leaseId: LeaseId,
    expiresAt: Schema.Number,
    disposition: Schema.Literals(["idle", "s97-recovery"]),
  }),
]);
export type ServerDrainState = typeof ServerDrainState.Type;

export class ServerDrainError extends Schema.TaggedError<ServerDrainError>()(
  "ServerDrainError",
  {
    reason: Schema.Literals([
      "admission_closed",
      "lease_conflict",
      "busy",
      "timeout",
      "expired",
      "inspection_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    if (this.reason === "admission_closed") {
      return "The server is preparing to update. Your message was not sent. Try again shortly.";
    }
    return `Server deployment drain failed: ${this.reason}.`;
  }
}
