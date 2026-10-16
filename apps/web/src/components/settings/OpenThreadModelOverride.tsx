import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ModelOverrideScope,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ensureLocalApi } from "../../localApi";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";

const KEEP = "";
const MAX_LISTED_MODELS = 60;

const SCOPES: ReadonlyArray<{ readonly id: ModelOverrideScope; readonly label: string }> = [
  { id: "all", label: "All open threads" },
  { id: "tasks", label: "Only scheduled task threads" },
  { id: "adhoc", label: "Only threads without a task" },
];
/** How the confirmation and the toasts name the threads a scope covers. */
const SCOPE_NOUN: Record<ModelOverrideScope, string> = {
  all: "open thread",
  tasks: "scheduled task thread",
  adhoc: "open thread without a task",
};
const SCOPE_NOUN_PLURAL: Record<ModelOverrideScope, string> = {
  all: "open threads",
  tasks: "scheduled task threads",
  adhoc: "open threads without a task",
};

interface ModelChoice {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly label: string;
  /** Thinking levels this model offers, as id and label. */
  readonly efforts: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

/**
 * Sets a model, a thinking level, or both on every open thread of one
 * environment, and restores what was there before. Lives in settings because
 * it acts on all threads, not on the one in view.
 */
export function OpenThreadModelOverride() {
  const { connectedEnvironments } = useSettingsScope();
  const environment = connectedEnvironments[0] ?? null;
  if (environment === null) return null;
  return (
    <OpenThreadModelOverrideControls
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
    />
  );
}

function OpenThreadModelOverrideControls({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const allowed = useAtomValue(
    serverEnvironment.overrideOpenThreadModels.permissionAtom(environmentId),
  );
  const apply = useAtomCommand(serverEnvironment.overrideOpenThreadModels);
  const restore = useAtomCommand(serverEnvironment.overrideOpenThreadModels);
  const [modelKey, setModelKey] = useState(KEEP);
  const [effort, setEffort] = useState(KEEP);
  const [keepOwnAccount, setKeepOwnAccount] = useState(false);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<ModelOverrideScope>("all");
  const [pending, setPending] = useState(false);
  // What the server holds in force for task threads and for the others. It
  // also reaches threads that open later, so the page says so instead of
  // looking as if nothing were set.
  const [standing, setStanding] = useState<
    Extract<Awaited<ReturnType<typeof apply>>, { _tag: "Success" }>["value"]["standing"]
  >({ tasks: null, adhoc: null });
  useEffect(() => {
    if (!allowed) return;
    let current = true;
    void apply({ environmentId, input: { commandId: CommandId.make(randomUUID()) } }).then(
      (result) => {
        if (current && result._tag === "Success") setStanding(result.value.standing);
      },
    );
    return () => {
      current = false;
    };
  }, [allowed, apply, environmentId]);

  const choices = useMemo<ReadonlyArray<ModelChoice>>(
    () =>
      deriveProviderInstanceEntries(providers)
        .filter((entry) => entry.enabled && entry.isAvailable && entry.status === "ready")
        .flatMap((entry) =>
          entry.models
            .filter((model) => model.isLegacy !== true)
            .map((model) => ({
              key: `${entry.instanceId}\n${model.slug}`,
              instanceId: entry.instanceId,
              model: model.slug,
              label: `${entry.displayName} · ${model.name}`,
              efforts: (model.capabilities?.optionDescriptors ?? []).flatMap((descriptor) =>
                descriptor.type === "select" && /effort/i.test(descriptor.id)
                  ? descriptor.options.map((option) => ({ id: option.id, label: option.label }))
                  : [],
              ),
            })),
        ),
    [providers],
  );
  const chosen = choices.find((choice) => choice.key === modelKey) ?? null;
  // Some providers list hundreds of models; the list shows what the filter
  // leaves, and never more than fits a menu.
  const listed = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return choices
      .filter((choice) => needle === "" || choice.label.toLowerCase().includes(needle))
      .slice(0, MAX_LISTED_MODELS);
  }, [choices, filter]);
  // With a model chosen, its own levels; otherwise every level some model offers.
  const efforts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const choice of chosen === null ? choices : [chosen]) {
      for (const level of choice.efforts) if (!seen.has(level.id)) seen.set(level.id, level.label);
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [choices, chosen]);
  const effortValue = efforts.some((level) => level.id === effort) ? effort : KEEP;

  const report = (
    result: Awaited<ReturnType<typeof apply>> | Awaited<ReturnType<typeof restore>>,
    done: (threads: number) => string,
    failed: string,
  ) => {
    if (result._tag === "Success") {
      setStanding(result.value.standing);
      // A composer keeps its own saved pick per thread, which would hide the
      // change; move every changed thread's composer along.
      const drafts = useComposerDraftStore.getState();
      for (const entry of result.value.changed) {
        drafts.setModelSelection(
          scopeThreadRef(environmentId, entry.threadId),
          entry.modelSelection,
          { explicit: true, replaceOptions: true },
        );
      }
      toastManager.add({ type: "success", title: done(result.value.threads) });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failed,
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };
  const run = async (action: "apply" | "restore") => {
    const what = [chosen?.label, effortValue === KEEP ? null : `thinking ${effortValue}`]
      .filter((part) => part !== null && part !== undefined)
      .join(", ");
    const noun = SCOPE_NOUN[scope];
    const confirmed = await ensureLocalApi().dialogs.confirm(
      action === "apply"
        ? `Set ${what} on every ${noun} on ${environmentLabel}? Each thread uses it from its next message; a run under way is not touched. A thread that moves to another model or account loses its prompt cache: its next message pays its whole context again at the cache-write price.`
        : `Put back the models every ${noun} on ${environmentLabel} had before? Threads you have changed since keep your choice.`,
    );
    if (!confirmed) return;
    setPending(true);
    try {
      const commandId = CommandId.make(randomUUID());
      if (action === "apply") {
        report(
          await apply({
            environmentId,
            input: {
              commandId,
              ...(chosen === null
                ? {}
                : { model: { instanceId: chosen.instanceId, model: chosen.model } }),
              ...(effortValue === KEEP ? {} : { effort: effortValue }),
              ...(keepOwnAccount && chosen !== null ? { keepOwnAccount: true } : {}),
              scope,
            },
          }),
          (threads) =>
            threads === 0
              ? `Every ${noun} already had this`
              : `Set on ${threads} ${threads === 1 ? noun : SCOPE_NOUN_PLURAL[scope]}`,
          "Could not set the model on the open threads",
        );
      } else {
        report(
          await restore({ environmentId, input: { commandId, restore: true, scope } }),
          (threads) =>
            threads === 0
              ? "Nothing to put back"
              : `Put back on ${threads} ${threads === 1 ? "thread" : "threads"}`,
          "Could not restore the models",
        );
      }
    } finally {
      setPending(false);
    }
  };

  const describe = (override: (typeof standing)["tasks"]) => {
    if (override === null) return null;
    const model =
      override.model === undefined
        ? null
        : (choices.find(
            (choice) =>
              choice.instanceId === override.model?.instanceId &&
              choice.model === override.model?.model,
          )?.label ?? `${override.model.instanceId} · ${override.model.model}`);
    return [
      model,
      override.effort === undefined ? null : `thinking ${override.effort}`,
      override.keepOwnAccount === true ? "each thread stays on its own account" : null,
    ]
      .filter((part) => part !== null)
      .join(", ");
  };
  const tasksText = describe(standing.tasks);
  const adhocText = describe(standing.adhoc);
  // One line when both parts follow the same override, one per part otherwise.
  const standingLines =
    tasksText !== null && tasksText === adhocText
      ? [`In force for all open threads: ${tasksText}.`]
      : [
          tasksText === null ? null : `In force for scheduled task threads: ${tasksText}.`,
          adhocText === null ? null : `In force for threads without a task: ${adhocText}.`,
        ].filter((line) => line !== null);

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      {standingLines.length === 0 ? null : (
        <div className="w-full text-xs text-muted-foreground" data-testid="standing-model-override">
          {standingLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p>
            Until you put it back, a thread that opens later is set to it when a task, an agent or
            the server writes to it. A thread you have written in since keeps the model you picked
            in the composer.
          </p>
        </div>
      )}
      <Select
        value={scope}
        onValueChange={(value) => setScope((value as ModelOverrideScope | null) ?? "all")}
      >
        <SelectTrigger size="sm" aria-label="Which threads" className="w-56">
          <SelectValue>{SCOPES.find((entry) => entry.id === scope)?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {SCOPES.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Input
        nativeInput
        aria-label="Filter the model list"
        placeholder={`Filter ${choices.length} models`}
        className="w-40"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <Select value={modelKey} onValueChange={(value) => setModelKey(value ?? KEEP)}>
        <SelectTrigger size="sm" aria-label="Model for all open threads" className="w-56">
          <SelectValue>{chosen?.label ?? "Keep each thread's model"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={KEEP}>Keep each thread's model</SelectItem>
          {listed.map((choice) => (
            <SelectItem key={choice.key} value={choice.key}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select value={effortValue} onValueChange={(value) => setEffort(value ?? KEEP)}>
        <SelectTrigger size="sm" aria-label="Thinking level for all open threads" className="w-40">
          <SelectValue>
            {efforts.find((level) => level.id === effortValue)?.label ?? "Keep thinking level"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={KEEP}>Keep thinking level</SelectItem>
          {efforts.map((level) => (
            <SelectItem key={level.id} value={level.id}>
              {level.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {/* The list names an account with each model, and choosing one moves the threads to
          that account. This keeps them where they are and changes only the model. */}
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch
          checked={keepOwnAccount}
          disabled={chosen === null}
          onCheckedChange={(checked) => setKeepOwnAccount(checked === true)}
          aria-label="Keep each thread on its own account"
        />
        Keep each thread on its own account
      </label>
      <Button
        size="xs"
        disabled={pending || !allowed || (chosen === null && effortValue === KEEP)}
        onClick={() => void run("apply")}
      >
        {scope === "all" ? "Set on all open threads" : `Set on ${SCOPE_NOUN_PLURAL[scope]}`}
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={pending || !allowed}
        onClick={() => void run("restore")}
      >
        Put back
      </Button>
    </div>
  );
}
