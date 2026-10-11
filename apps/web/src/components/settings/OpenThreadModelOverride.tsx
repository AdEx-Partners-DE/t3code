import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ensureLocalApi } from "../../localApi";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";

const KEEP = "";
const MAX_LISTED_MODELS = 60;

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
  const restore = useAtomCommand(serverEnvironment.restoreOpenThreadModels);
  const [modelKey, setModelKey] = useState(KEEP);
  const [effort, setEffort] = useState(KEEP);
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState(false);

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
    const confirmed = await ensureLocalApi().dialogs.confirm(
      action === "apply"
        ? `Set ${what} on every open thread on ${environmentLabel}? Each thread uses it from its next message; a run under way is not touched.`
        : `Put back the models the open threads on ${environmentLabel} had before? Threads you have changed since keep your choice.`,
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
            },
          }),
          (threads) =>
            threads === 0
              ? "Every open thread already had this"
              : `Set on ${threads} open ${threads === 1 ? "thread" : "threads"}`,
          "Could not set the model on the open threads",
        );
      } else {
        report(
          await restore({ environmentId, input: { commandId } }),
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

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
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
      <Button
        size="xs"
        disabled={pending || !allowed || (chosen === null && effortValue === KEEP)}
        onClick={() => void run("apply")}
      >
        Set on all open threads
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
