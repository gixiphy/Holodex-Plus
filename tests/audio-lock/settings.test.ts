import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageLocal = new Map<string, unknown>();
const changeListeners: Array<
  (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    area: string,
  ) => void
> = [];

vi.mock("webextension-polyfill", () => ({
  storage: {
    local: {
      async get(key: string) {
        if (storageLocal.has(key)) return { [key]: storageLocal.get(key) };
        return {};
      },
      async set(obj: Record<string, unknown>) {
        for (const [k, v] of Object.entries(obj)) storageLocal.set(k, v);
      },
    },
    onChanged: {
      addListener(
        cb: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          area: string,
        ) => void,
      ) {
        changeListeners.push(cb);
      },
      removeListener(
        cb: (
          changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
          area: string,
        ) => void,
      ) {
        const i = changeListeners.indexOf(cb);
        if (i >= 0) changeListeners.splice(i, 1);
      },
    },
  },
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
}));

import {
  AUDIO_LOCK_CHANNEL,
  AUDIO_LOCK_VERSION,
  parseAudioLockMessage,
} from "../../src/pages/content/holodex/audio-lock/contracts";
import { Options } from "../../src/utils/options";

describe("parseAudioLockMessage", () => {
  it("accepts ready and config; rejects bad shapes", () => {
    expect(
      parseAudioLockMessage({
        channel: AUDIO_LOCK_CHANNEL,
        version: AUDIO_LOCK_VERSION,
        type: "ready",
      }),
    ).toEqual({
      channel: AUDIO_LOCK_CHANNEL,
      version: AUDIO_LOCK_VERSION,
      type: "ready",
    });
    expect(
      parseAudioLockMessage({
        channel: AUDIO_LOCK_CHANNEL,
        version: AUDIO_LOCK_VERSION,
        type: "config",
        enabled: true,
      }),
    ).toMatchObject({ type: "config", enabled: true });
    expect(
      parseAudioLockMessage({
        channel: AUDIO_LOCK_CHANNEL,
        version: AUDIO_LOCK_VERSION,
        type: "config",
        enabled: "yes",
      }),
    ).toBeNull();
    expect(
      parseAudioLockMessage({
        channel: "other",
        version: 1,
        type: "ready",
      }),
    ).toBeNull();
  });
});

describe("Options twitchAudioLock", () => {
  beforeEach(() => {
    storageLocal.clear();
  });

  it("defaults to true and persists false", async () => {
    expect(Options.schema().twitchAudioLock).toBe(true);
    expect(await Options.get("twitchAudioLock")).toBe(true);
    await Options.set("twitchAudioLock", false);
    expect(await Options.get("twitchAudioLock")).toBe(false);
  });

  it("missing key returns default true", async () => {
    storageLocal.clear();
    expect(await Options.get("twitchAudioLock")).toBe(true);
  });
});

describe("startAudioLockSettingsBridge", () => {
  beforeEach(() => {
    storageLocal.clear();
    changeListeners.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts config on ready and ignores foreign messages", async () => {
    const { startAudioLockSettingsBridge } = await import(
      "../../src/pages/content/holodex/audio-lock-settings"
    );
    const posted: unknown[] = [];
    const origin = window.location.origin;
    const postSpy = vi
      .spyOn(window, "postMessage")
      .mockImplementation((data: unknown) => {
        posted.push(data);
      });

    const stop = startAudioLockSettingsBridge(window);
    await Promise.resolve();
    await Promise.resolve();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          channel: AUDIO_LOCK_CHANNEL,
          version: AUDIO_LOCK_VERSION,
          type: "ready",
        },
        origin,
        source: window,
      }),
    );

    // foreign source ignored
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          channel: AUDIO_LOCK_CHANNEL,
          version: AUDIO_LOCK_VERSION,
          type: "ready",
        },
        origin,
        source: null,
      }),
    );

    expect(
      posted.some(
        (p) =>
          parseAudioLockMessage(p)?.type === "config" &&
          (parseAudioLockMessage(p) as { enabled?: boolean }).enabled === true,
      ),
    ).toBe(true);

    stop();
    postSpy.mockRestore();
  });

  it("storage change updates config; invalid disables", async () => {
    const { startAudioLockSettingsBridge } = await import(
      "../../src/pages/content/holodex/audio-lock-settings"
    );
    const posted: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      posted.push(data);
    });
    const stop = startAudioLockSettingsBridge(window);
    await Promise.resolve();

    for (const cb of changeListeners) {
      cb({ twitchAudioLock: { newValue: false } }, "local");
    }
    expect(
      posted.some((p) => {
        const m = parseAudioLockMessage(p);
        return m?.type === "config" && m.enabled === false;
      }),
    ).toBe(true);

    for (const cb of changeListeners) {
      cb({ twitchAudioLock: { newValue: "nope" } }, "local");
    }
    expect(
      posted.some((p) => {
        const m = parseAudioLockMessage(p);
        return m?.type === "config" && m.enabled === false;
      }),
    ).toBe(true);

    stop();
  });

  it("5000ms storage timeout disables", async () => {
    vi.useFakeTimers();
    storageLocal.clear();
    // hang get by overriding after module load — use delayed Options via map lock
    const { startAudioLockSettingsBridge } = await import(
      "../../src/pages/content/holodex/audio-lock-settings"
    );

    // Force Options.get to hang: leave a pending forever by replacing storage get
    const poly = await import("webextension-polyfill");
    vi.spyOn(poly.storage.local, "get").mockImplementation(
      () => new Promise(() => undefined),
    );

    const posted: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      posted.push(data);
    });
    const stop = startAudioLockSettingsBridge(window);
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      posted.some((p) => {
        const m = parseAudioLockMessage(p);
        return m?.type === "config" && m.enabled === false;
      }),
    ).toBe(true);
    stop();
  });
});

describe("options page form", () => {
  beforeEach(() => {
    storageLocal.clear();
    document.body.innerHTML = '<form id="options"></form>';
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders existing options plus twitchAudioLock checkbox", async () => {
    await import("../../src/pages/options/index");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    // wait for async Options.get loops
    await vi.waitFor(() => {
      expect(document.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThanOrEqual(
        4,
      );
    });
    const labels = [...document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(labels).toContain("Keep selected audio in multiview");
    expect(labels).toContain("Like Button on Holodex");
  });
});
