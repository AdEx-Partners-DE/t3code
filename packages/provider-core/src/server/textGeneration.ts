import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export type ThreadChecklistItemStatus = "done" | "open" | "backlog" | "attention";

export interface ThreadChecklistGenerationInput {
  cwd: string;
  /** The thread so far, oldest first, already cut to what a prompt can carry. */
  transcript: string;
  /** The checklist from the last run, so items keep their wording as their status moves. */
  previous?:
    | ReadonlyArray<{ text: string; status: ThreadChecklistItemStatus; setByUser?: boolean }>
    | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadBlockerJudgementInput {
  cwd: string;
  /** What the thread was last asked to do. Empty when it is not known. */
  lastRequest: string;
  /** The reply the thread stopped on. */
  lastReply: string;
  /** What model and provider to use for the judgement. */
  modelSelection: ModelSelection;
}

export type ThreadBlockerJudgementResult =
  /** The agent could go on by itself; `instruction` tells it how. */
  | { kind: "sham"; instruction: string; reason: string }
  /** The thread waits for the user for a reason only they can settle. */
  | { kind: "real"; reason: string };

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadChecklistGenerationResult {
  items: ReadonlyArray<{
    text: string;
    status: ThreadChecklistItemStatus;
    /** Why the item needs the user, or what is missing. */
    note?: string | undefined;
    /** Number of the transcript entry where the point was raised or last settled. */
    entry?: number | undefined;
  }>;
}

/** A guide as the model wrote it, before the server holds it to the change. */
export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface ProviderTextGeneration {
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Boil a thread down to a checklist of what is done, open, parked, and
   * waiting on the user. Optional: a provider without it cannot be chosen for
   * checklists.
   */
  readonly generateThreadChecklist?: (
    input: ThreadChecklistGenerationInput,
  ) => Effect.Effect<ThreadChecklistGenerationResult, TextGenerationError>;
  /**
   * Decide whether a thread that stopped really needs the user or only asked
   * for leave it already has. Optional: a provider without it cannot supervise.
   */
  readonly judgeThreadBlocker?: (
    input: ThreadBlockerJudgementInput,
  ) => Effect.Effect<ThreadBlockerJudgementResult, TextGenerationError>;
  /** Explain a change request to the maintainer deciding whether it lands. */
  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}
