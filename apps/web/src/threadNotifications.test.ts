import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { threadNotificationTag } from "./threadNotifications";
const environmentId = "fd6fff30-f90b-4ee7-9812-4cf497791b90" as EnvironmentId;
const threadId = "a8395a98-a186-4fe7-9d4c-fb8ba63b7588" as ThreadId;

describe("threadNotificationTag", () => {
  it("stays under the platform toast tag budget", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(tag).toHaveLength(16);
    expect(tag.length).toBeLessThanOrEqual(32);
  });

  it("is stable for the same environment and thread", () => {
    expect(threadNotificationTag(environmentId, threadId)).toBe(
      threadNotificationTag(environmentId, threadId),
    );
  });

  it("separates environments and threads", () => {
    const tag = threadNotificationTag(environmentId, threadId);
    expect(threadNotificationTag("env-2" as EnvironmentId, threadId)).not.toBe(tag);
    expect(threadNotificationTag(environmentId, "thread-2" as ThreadId)).not.toBe(tag);
  });
});

const SOUND_SECONDS = 0.6;

const audio = { currentTime: 0, started: 0 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started += 1;
      },
    };
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    await playNotificationSound("input", () => true);

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });
});
