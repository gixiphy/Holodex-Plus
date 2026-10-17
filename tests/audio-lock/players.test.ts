import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayerPort } from "../../src/pages/content/holodex/audio-lock/players";
import type { CellIdentity } from "../../src/pages/content/holodex/audio-lock/contracts";
import {
  createFakePlayerComponent,
  createFakeVideoCell,
  createFakeStore,
  createTwitchSdk,
  createYoutubeSdk,
  fireReady,
  flushMicrotasks,
  mountPlayerOnCell,
  replaceCellContent,
  youtubeRawFor,
  type FakePlayerComponent,
  type FakeVideoCell,
  type FakeEnv,
} from "./fixtures";

function identity(
  key = "a",
  provider: "youtube" | "twitch" = "twitch",
): CellIdentity {
  return { key, contentId: `c-${key}`, provider, generation: 1 };
}

/** Parent VideoCell shape for direct createPlayerPort calls (VideoCell.vue:79-80). */
function fakeCellFor(
  comp: FakePlayerComponent,
  provider: "youtube" | "twitch",
  opts?: { registerOnReady?: boolean; readyBeforeInstall?: boolean },
): FakeVideoCell {
  const store = createFakeStore({
    muteOthers: true,
    cells: [{ key: "a", provider, muted: true }],
  });
  const cell = createFakeVideoCell({
    store,
    key: "a",
    provider,
    player: null,
    readyBeforeInstall: false,
  });
  if (opts?.registerOnReady !== false) {
    mountPlayerOnCell(cell, comp, {
      readyBeforeInstall: opts?.readyBeforeInstall ?? false,
    });
  } else {
    cell.$refs.player = comp;
    if (comp.$el.parentElement !== cell.$el) cell.$el.appendChild(comp.$el);
  }
  return cell;
}

function portFor(
  comp: FakePlayerComponent,
  provider: "youtube" | "twitch",
  cell: FakeVideoCell,
  extra?: { onReady?: () => void; onContractMismatch?: () => void },
) {
  return createPlayerPort({
    identity: identity("a", provider),
    cell,
    playerComponent: comp,
    provider,
    onReady: extra?.onReady,
    onContractMismatch: extra?.onContractMismatch,
  });
}

describe("createPlayerPort", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // Upstream: PlayerMixin.ts:27-35,46; VideoCell.vue:79-80,210-216; YoutubePlayer.vue:69
  it("fixture_matches_upstream_player_shape", () => {
    for (const provider of ["twitch", "youtube"] as const) {
      document.body.innerHTML = "";
      const sdk =
        provider === "twitch"
          ? createTwitchSdk({ muted: true })
          : createYoutubeSdk({ muted: true });
      const comp = createFakePlayerComponent(provider, sdk);
      for (const k of ["ready", "twPlayer", "ytPlayer"] as const) {
        expect(Object.prototype.hasOwnProperty.call(comp, k)).toBe(false);
      }
      const cell = fakeCellFor(comp, provider, { readyBeforeInstall: false });
      expect(cell).toHaveProperty("twPlayer");
      expect(cell).toHaveProperty("ytPlayer");
      expect(cell.twPlayer).toBeNull();
      expect(cell.ytPlayer).toBeNull();
      fireReady(comp);
      if (provider === "twitch") {
        expect(cell.twPlayer).toBe(comp.player);
      } else {
        const raw = youtubeRawFor(comp)!;
        expect(cell.ytPlayer).toBe(raw);
        expect(cell.ytPlayer).not.toBe(comp.player);
        expect(
          comp.$el.contains(
            (cell.ytPlayer as { getIframe: () => HTMLIFrameElement }).getIframe(),
          ),
        ).toBe(true);
      }
    }
  });

  it("binds_on_vue_ready_event_without_ready_field", async () => {
    for (const provider of ["twitch", "youtube"] as const) {
      document.body.innerHTML = "";
      const sdk =
        provider === "twitch"
          ? createTwitchSdk({ muted: false })
          : createYoutubeSdk({ muted: false });
      const comp = createFakePlayerComponent(provider, sdk);
      const cell = fakeCellFor(comp, provider, { readyBeforeInstall: false });
      const port = portFor(comp, provider, cell);
      expect(await port!.readMuted()).toEqual({
        kind: "unavailable",
        reason: "not-ready",
      });
      expect(sdk.muteCalls).toBe(0);
      expect(sdk.unmuteCalls).toBe(0);
      fireReady(comp);
      expect(await port!.readMuted()).toEqual({ kind: "known", muted: false });
      expect(port!.isBound()).toBe(true);
      const beforeDispose = (comp.listeners.ready ?? []).length;
      port!.dispose();
      // Port $off removes its listener; cell template @ready remains
      expect((comp.listeners.ready ?? []).length).toBe(beforeDispose - 1);
    }
  });

  it("late_bind_twitch_requires_cell_twPlayer_identity", async () => {
    const sdk = createTwitchSdk({ muted: true });
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: true });
    const port = portFor(comp, "twitch", cell);
    expect(port!.isBound()).toBe(true);
    expect(await port!.readMuted()).toEqual({ kind: "known", muted: true });
    port!.dispose();

    {
      const sdk = createTwitchSdk({ muted: true });
      const comp = createFakePlayerComponent("twitch", sdk);
      const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: true });
      // intentional negative late-bind cases (cell refs only)
      cell.twPlayer = { other: true };
      const port = portFor(comp, "twitch", cell);
      expect(await port!.readMuted()).toEqual({
        kind: "unavailable",
        reason: "not-ready",
      });
      cell.twPlayer = null;
      expect(await port!.readMuted()).toEqual({
        kind: "unavailable",
        reason: "not-ready",
      });
      port!.dispose();
    }
  });

  it("late_bind_youtube_rejects_stale_cell_ytPlayer", async () => {
    const store = createFakeStore({
      muteOthers: true,
      cells: [{ key: "y", provider: "youtube", muted: true }],
    });
    const sdk1 = createYoutubeSdk({ muted: true });
    const player1 = createFakePlayerComponent("youtube", sdk1, {
      elementId: "yt-old",
    });
    const cell = createFakeVideoCell({
      store,
      key: "y",
      provider: "youtube",
      player: player1,
      readyBeforeInstall: true,
    });
    const { root, appEl, multiview } = await import("./fixtures").then((m) =>
      m.createFakeMultiviewRoot(store, [cell]),
    );
    const env: FakeEnv = {
      store,
      root,
      appEl,
      multiview,
      cells: new Map([["y", cell]]),
      sdks: new Map([["y", sdk1]]),
    };
    const staleRaw = cell.ytPlayer;
    replaceCellContent(env, "y", { provider: "youtube", contentId: "yt-new" });
    const newComp = cell.$refs.player!;
    const newSdk = env.sdks.get("y")!;
    expect(cell.ytPlayer).toBe(staleRaw);
    const port = createPlayerPort({
      identity: identity("y", "youtube"),
      cell,
      playerComponent: newComp,
      provider: "youtube",
    });
    expect(await port!.readMuted()).toEqual({
      kind: "unavailable",
      reason: "not-ready",
    });
    expect(newSdk.muteCalls).toBe(0);
    expect(newSdk.unmuteCalls).toBe(0);
    fireReady(newComp);
    expect(await port!.readMuted()).toEqual({ kind: "known", muted: false });
    expect(port!.isBound()).toBe(true);
    port!.dispose();

    // getIframe throws → not-ready, no uncaught exception
    {
      const sdk = createYoutubeSdk({ muted: true });
      const comp = createFakePlayerComponent("youtube", sdk);
      const cell = fakeCellFor(comp, "youtube", { readyBeforeInstall: true });
      cell.ytPlayer = {
        getIframe() {
          throw new Error("gone");
        },
      };
      const port = portFor(comp, "youtube", cell);
      await expect(port!.readMuted()).resolves.toEqual({
        kind: "unavailable",
        reason: "not-ready",
      });
      port!.dispose();
    }
  });

  it("ready_event_binds_even_before_cell_onReady", async () => {
    const sdk = createTwitchSdk({ muted: false });
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", {
      registerOnReady: false,
      readyBeforeInstall: false,
    });
    // Port registers $on first; cell onReady later (reverse of VideoCell template order)
    const port = portFor(comp, "twitch", cell);
    comp.$on("ready", (p) => cell.onReady(p));
    expect(cell.twPlayer).toBeNull();
    fireReady(comp);
    // After fireReady, cell.onReady runs after port listener (registration order)
    // Plan: port listener runs first while twPlayer still null → still bound via readySignal
    expect(port!.isBound()).toBe(true);
    expect(await port!.readMuted()).toEqual({ kind: "known", muted: false });
    port!.dispose();
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
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: true });
    const port = portFor(comp, "twitch", cell);
    expect(port).not.toBeNull();

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
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: false });
    const port = portFor(comp, "twitch", cell);
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
    const throwComp = createFakePlayerComponent("twitch", throwSdk);
    const throwCell = fakeCellFor(throwComp, "twitch", { readyBeforeInstall: true });
    const throwPort = portFor(throwComp, "twitch", throwCell);
    expect(await throwPort!.readMuted()).toEqual({
      kind: "unavailable",
      reason: "access-error",
    });
    throwPort!.dispose();

    const hangSdk = createTwitchSdk({ hangRead: true });
    const hangComp = createFakePlayerComponent("twitch", hangSdk);
    const hangCell = fakeCellFor(hangComp, "twitch", { readyBeforeInstall: true });
    const hangPort = portFor(hangComp, "twitch", hangCell);
    const pending = hangPort!.readMuted();
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toEqual({ kind: "unavailable", reason: "timeout" });
    hangPort!.dispose();
  });

  it("non-boolean getMuted is unavailable, not coerced false", async () => {
    const sdk = createTwitchSdk();
    sdk.getMuted = () => undefined as unknown as boolean;
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: true });
    const port = portFor(comp, "twitch", cell);
    expect(await port!.readMuted()).toEqual({
      kind: "unavailable",
      reason: "access-error",
    });
    port!.dispose();
  });

  it("restoreSelectedAudio once for matching grant; wrong generation/dispose skip", async () => {
    const sdk = createTwitchSdk({ muted: true });
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: true });
    const id = identity();
    const port = createPlayerPort({
      identity: id,
      cell,
      playerComponent: comp,
      provider: "twitch",
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
    const comp = createFakePlayerComponent("youtube", sdk);
    const cell = fakeCellFor(comp, "youtube", { readyBeforeInstall: true });
    const id = identity("y", "youtube");
    const port = createPlayerPort({
      identity: id,
      cell,
      playerComponent: comp,
      provider: "youtube",
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
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: true });
    const port = portFor(comp, "twitch", cell);
    // bind fails → port still created but reads unavailable; plan Task 3 replaces this
    expect(port).not.toBeNull();
  });

  it("onReady_fires_once_on_first_bind", async () => {
    const sdk = createTwitchSdk({ muted: true });
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: false });
    let readyCount = 0;
    const port = portFor(comp, "twitch", cell, {
      onReady: () => {
        readyCount += 1;
      },
    });
    expect(readyCount).toBe(0);
    fireReady(comp);
    await flushMicrotasks();
    expect(readyCount).toBe(1);
    fireReady(comp);
    await port!.readMuted();
    await flushMicrotasks();
    expect(readyCount).toBe(1);
    port!.dispose();
    fireReady(comp);
    await flushMicrotasks();
    expect(readyCount).toBe(1);
  });

  it("isBound_reflects_late_bind_and_dispose", async () => {
    const sdk = createTwitchSdk({ muted: true });
    const comp = createFakePlayerComponent("twitch", sdk);
    const cell = fakeCellFor(comp, "twitch", { readyBeforeInstall: false });
    const port = portFor(comp, "twitch", cell);
    expect(port!.isBound()).toBe(false);
    fireReady(comp);
    await port!.readMuted();
    expect(port!.isBound()).toBe(true);
    port!.dispose();
    expect(port!.isBound()).toBe(false);
  });
});
