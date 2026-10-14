import { describe, expect, it } from "@effect/vitest";
import type { ThreadChecklistItem } from "@t3tools/contracts";

import {
  checklistForPrompt,
  keepUserStatuses,
  setChecklistItemStatus,
} from "./checklistUserStatus.ts";

const item = (
  text: string,
  status: ThreadChecklistItem["status"],
  setByUser = false,
): ThreadChecklistItem => ({ text, status, ...(setByUser ? { setByUser: true as const } : {}) });

describe("setChecklistItemStatus", () => {
  it("marks the item with that text, ignoring case and spacing", () => {
    expect(
      setChecklistItemStatus(
        [item("Deploy the fix", "open"), item("Write docs", "open")],
        "deploy  the fix",
        "done",
      ),
    ).toEqual([item("Deploy the fix", "done", true), item("Write docs", "open")]);
  });

  it("knows no item it cannot find", () => {
    expect(setChecklistItemStatus([item("Deploy the fix", "open")], "Other", "done")).toBeNull();
  });
});

describe("keepUserStatuses", () => {
  it("keeps the user's status when the model reads the item differently", () => {
    expect(
      keepUserStatuses(
        [item("Deploy the fix", "done", true)],
        [item("Deploy the fix", "attention")],
      ),
    ).toEqual([item("Deploy the fix", "done", true)]);
  });

  it("brings back a parked item the model dropped, but lets a finished one go", () => {
    expect(
      keepUserStatuses(
        [item("Rename the API", "backlog", true), item("Old step", "done", true)],
        [item("New point", "open")],
      ),
    ).toEqual([item("New point", "open"), item("Rename the API", "backlog", true)]);
  });

  it("changes nothing when the user set nothing", () => {
    const generated = [item("New point", "open")];
    expect(keepUserStatuses([item("Old", "open")], generated)).toBe(generated);
  });
});

describe("checklistForPrompt", () => {
  it("tells the model which statuses the user set", () => {
    expect(checklistForPrompt([item("A", "done", true), item("B", "open")])).toEqual([
      { text: "A", status: "done", setByUser: true },
      { text: "B", status: "open" },
    ]);
  });
});
