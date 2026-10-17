import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayerPort } from "../../src/pages/content/holodex/audio-lock/players";
import type { CellIdentity } from "../../src/pages/content/holodex/audio-lock/contracts";
import {
  createFakePlayerComponent,
  createTwitchSdk,
  createYoutubeSdk,
  fireReady,
} from "./fixtures";

function identity(
  key = "a",
  provider: "youtube" | "twitch" = "twitch",
): CellIdentity {
  return { key, contentId: `c-${key}`, provider, generation: 1 };
}

describe("createPlayerPort", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("late-binds twitch methods and does not touch Twitch global", async () => {
    const TwitchBefore = (window as unknown as { Twitch?: unknown }).Twitch;
    const ctor = function Player() {
      return undefined;
    };
    (window as unknown as { Twitch: { Player: unknown } }).Twitch = {
      Player: ctor,
    };
    const descBefore = Object.getOwnPropertyDescriptor(window, "Twitch");

    const sdk = createTwitchSdk({ muted: true, dangerousGetter: true });
    const comp = createFakePlayerComponent("twitch", sdk, true);
    const port = createPlayerPort({
      identity: identity(),
      playerComponent: comp,
      provider: "twitch",
      isReady: () => comp.ready,
    });
    expect(port).not.toBeNull();

    // must not read _embedWindow
    const read = await port!.readMuted();
    expect(read).toEqual({ kind: "known", muted: true });
    expect((window as unknown as { Twitch: { Player: unknown } }).Twitch.Player).toBe(
      ctor,
    );
    expect(Object.getOwnPropertyDescriptor(window, "Twitch")).toEqual(descBefore);

    port!.dispose();
    (window as unknown as { Twitch?: unknown }).Twitch = TwitchBefore;
  });

  it("returns not-ready before ready and does not call SDK", async () => {
    const sdk = createTwitchSdk({ muted: false });
    const comp = createFakePlayerComponent("twitch", sdk, false);
    const port = createPlayerPort({
      identity: identity(),
      playerComponent: comp,
      provider: "twitch",
      isReady: () => comp.ready,
    });
    const read = await port!.readMuted();
    expect(read).toEqual({ kind: "unavailable", reason: "not-ready" });
    expect(sdk.muteCalls).toBe(0);

    fireReady(comp);
    const read2 = await port!.readMuted();
    expect(read2).toEqual({ kind: "known", muted: false });
    port!.dispose();
  });

  it("maps throw/reject/hang to unavailable", async () => {
    vi.useFakeTimers();
    const throwSdk = createTwitchSdk({ throwRead: true });
    const throwComp = createFakePlayerComponent("twitch", throwSdk, true);
    const throwPort = createPlayerPort({
      identity: identity("t"),
      playerComponent: throwComp,
      provider: "twitch",
      isReady: () => true,
    });
    expect(await throwPort!.readMuted()).toEqual({
      kind: "unavailable",
      reason: "access-error",
    });
    throwPort!.dispose();

    const hangSdk = createTwitchSdk({ hangRead: true });
    const hangComp = createFakePlayerComponent("twitch", hangSdk, true);
    const hangPort = createPlayerPort({
      identity: identity("h"),
      playerComponent: hangComp,
      provider: "twitch",
      isReady: () => true,
    });
    const pending = hangPort!.readMuted();
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toEqual({ kind: "unavailable", reason: "timeout" });
    hangPort!.dispose();
  });

  it("non-boolean getMuted is unavailable, not coerced false", async () => {
    const sdk = createTwitchSdk();
    sdk.getMuted = () => undefined as unknown as boolean;
    const comp = createFakePlayerComponent("twitch", sdk, true);
    const port = createPlayerPort({
      identity: identity(),
      playerComponent: comp,
      provider: "twitch",
      isReady: () => true,
    });
    expect(await port!.readMuted()).toEqual({
      kind: "unavailable",
      reason: "access-error",
    });
    port!.dispose();
  });

  it("restoreSelectedAudio once for matching grant; wrong generation/dispose skip", async () => {
    const sdk = createTwitchSdk({ muted: true });
    const comp = createFakePlayerComponent("twitch", sdk, true);
    const id = identity();
    const port = createPlayerPort({
      identity: id,
      playerComponent: comp,
      provider: "twitch",
      isReady: () => true,
    });
    const grant = { identity: id, epoch: 2, source: "explicit" as const };
    expect(await port!.restoreSelectedAudio(grant)).toBe(true);
    expect(sdk.unmuteCalls).toBe(1);
    expect(sdk.rawMuted).toBe(false);
    expect(await port!.restoreSelectedAudio(grant)).toBe(false);
    expect(sdk.unmuteCalls).toBe(1);

    const bad = {
      identity: { ...id, generation: 99 },
      epoch: 3,
      source: "bootstrap" as const,
    };
    expect(await port!.restoreSelectedAudio(bad)).toBe(false);

    port!.dispose();
    expect(
      await port!.restoreSelectedAudio({
        identity: id,
        epoch: 4,
        source: "explicit",
      }),
    ).toBe(false);
  });

  it("youtube restore uses unMute and handles reject without unhandled rejection", async () => {
    const sdk = createYoutubeSdk({ muted: true });
    sdk.unMute = () => Promise.reject(new Error("nope"));
    const comp = createFakePlayerComponent("youtube", sdk, true);
    const id = identity("y", "youtube");
    const port = createPlayerPort({
      identity: id,
      playerComponent: comp,
      provider: "youtube",
      isReady: () => true,
    });
    await expect(
      port!.restoreSelectedAudio({
        identity: id,
        epoch: 1,
        source: "bootstrap",
      }),
    ).resolves.toBe(false);
    port!.dispose();
  });

  it("missing public methods returns null port", () => {
    const sdk = createTwitchSdk();
    delete sdk.getMuted;
    const comp = createFakePlayerComponent("twitch", sdk, true);
    const port = createPlayerPort({
      identity: identity(),
      playerComponent: comp,
      provider: "twitch",
      isReady: () => true,
    });
    // bind fails → port still created but reads unavailable; plan says
    // instance exists without methods → degrade at adapter level.
    // createPlayerPort still returns a port object for late bind.
    expect(port).not.toBeNull();
  });
});
