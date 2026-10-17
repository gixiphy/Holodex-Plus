import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPanelDispatch,
  createAudioLockController,
  endPanelDispatch,
  hasPanelDispatch,
  type TestableHandle,
} from "../../src/pages/content/holodex/audio-lock/controller";
import { createInitialState, transition } from "../../src/pages/content/holodex/audio-lock/state";
import { TIMING } from "../../src/pages/content/holodex/audio-lock/contracts";
import { createPlayerPort } from "../../src/pages/content/holodex/audio-lock/players";
import {
  createFakeMultiviewRoot,
  createFakePlayerComponent,
  createFakeStore,
  createFakeVideoCell,
  createPanelEvent,
  createTwitchSdk,
  createYoutubeSdk,
  effectiveMuteProp,
  flushMicrotasks,
  type FakeVideoCell,
} from "./fixtures";

function setupMixed() {
  const store = createFakeStore({
    muteOthers: true,
    cells: [
      { key: "a", provider: "youtube", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ],
  });
  const ytSdk = createYoutubeSdk({ muted: false });
  const twSdk = createTwitchSdk({ muted: false }); // reports unmuted while store muted
  const ytPlayer = createFakePlayerComponent("youtube", ytSdk, true);
  const twPlayer = createFakePlayerComponent("twitch", twSdk, true);
  const cellA = createFakeVideoCell({
    store,
    key: "a",
    provider: "youtube",
    player: ytPlayer,
  });
  const cellB = createFakeVideoCell({
    store,
    key: "b",
    provider: "twitch",
    player: twPlayer,
  });
  createFakeMultiviewRoot(store, [cellA, cellB]);
  window.history.pushState({}, "", "/multiview");
  return { store, cellA, cellB, ytSdk, twSdk };
}

describe("controller", () => {
  let handle: TestableHandle;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    handle?.dispose();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("keeps A when B polls unmuted without token", async () => {
    const { cellA, cellB, ytSdk, twSdk } = setupMixed();
    handle = createAudioLockController({
      window,
      document,
    }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();

    // adopt active A from snapshot
    let state = handle.__getState();
    state = {
      ...state,
      mode: "locked",
      selection: "selected",
      active: {
        key: "a",
        contentId: "id-a",
        provider: "youtube",
        generation: 1,
      },
      muteOthers: true,
      extensionEnabled: true,
      epoch: 1,
    };
    handle.__setState(state);

    const bindingB = handle.__lastBindings.get("b");
    expect(bindingB).toBeTruthy();
    await handle.__reconcile({
      key: "b",
      contentId: "id-b",
      provider: "twitch",
      generation: 1,
    });

    expect(handle.__getState().active?.key).toBe("a");
    expect(twSdk.muteCalls).toBeGreaterThanOrEqual(1);
    expect(ytSdk.muteCalls).toBe(0);
    expect(cellA.muted).toBe(false);
    void cellB;
  });

  it("blocks B first play when A selected", () => {
    const { cellA, cellB } = setupMixed();
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: {
        key: "a",
        contentId: "id-a",
        provider: "youtube",
        generation: 1,
      },
      muteOthers: true,
      extensionEnabled: true,
      epoch: 1,
    });

    const before = cellB.muteOthersCalls.length;
    cellB.updatePausedState(false);
    // wrapper should block muteOthers for first play
    expect(cellB.muteOthersCalls.length).toBe(before);
    expect(handle.__getState().active?.key).toBe("a");
    expect(cellA.firstPlay).toBe(true);
  });

  it("bootstrap_poll_does_not_mute_unassigned_or_false_cells", async () => {
    const store = createFakeStore({
      muteOthers: true,
      cells: [
        { key: "0", provider: "twitch", muted: "omit" },
        { key: "1", provider: "twitch", muted: "omit" },
        { key: "2", provider: "youtube", muted: "omit" },
        { key: "3", provider: "youtube", muted: "omit" },
      ],
    });
    const cells: FakeVideoCell[] = [];
    const sdks = [];
    for (const key of ["0", "1", "2", "3"]) {
      const provider = key < "2" ? "twitch" : "youtube";
      const sdk =
        provider === "twitch"
          ? createTwitchSdk({ muted: false })
          : createYoutubeSdk({ muted: false });
      sdks.push(sdk);
      const player = createFakePlayerComponent(provider, sdk, true);
      const cell = createFakeVideoCell({ store, key, provider, player });
      cell.editMode = true; // not eligible for fallback
      cells.push(cell);
    }
    createFakeMultiviewRoot(store, cells);
    window.history.pushState({}, "", "/multiview");

    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    handle.__setState({
      ...createInitialState(),
      extensionEnabled: true,
      muteOthers: true,
      mode: "waiting-for-choice",
      selection: "bootstrap",
      active: null,
      epoch: 0,
    });

    for (const cell of cells) {
      await handle.__reconcile({
        key: String(cell.item.i),
        contentId: `id-${cell.item.i}`,
        provider: cell.isTwitchVideo ? "twitch" : "youtube",
        generation: 1,
      });
    }
    expect(sdks.every((s) => s.muteCalls === 0)).toBe(true);
    expect(handle.__getState().selection).toBe("bootstrap");
    for (const key of ["0", "1", "2", "3"]) {
      expect(store.state.multiview.layoutContent[key].muted).toBeUndefined();
    }
  });

  it("unassigned_selection_restores_actual_player_audio via panel", async () => {
    vi.useRealTimers();
    const store = createFakeStore({
      muteOthers: true,
      cells: [
        { key: "a", provider: "twitch", muted: "omit" },
        { key: "b", provider: "youtube", muted: true },
      ],
    });
    const sdk = createTwitchSdk({ muted: true });
    const player = createFakePlayerComponent("twitch", sdk, true);
    const cellA = createFakeVideoCell({
      store,
      key: "a",
      provider: "twitch",
      player,
    });
    const cellB = createFakeVideoCell({
      store,
      key: "b",
      provider: "youtube",
      player: createFakePlayerComponent("youtube", createYoutubeSdk({ muted: true })),
    });
    createFakeMultiviewRoot(store, [cellA, cellB]);
    window.history.pushState({}, "", "/multiview");

    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();

    const binding = handle.__lastBindings.get("a");
    expect(binding).toBeTruthy();
    const idA = binding!.identity;
    expect(effectiveMuteProp(cellA.muted)).toBe(false);
    const watchersBefore = cellA.watcherCalls;

    const event = createPanelEvent(true);
    beginPanelDispatch(event, true);
    await flushMicrotasks();
    expect(hasPanelDispatch()).toBe(true);
    cellA.setMuted(false);
    expect(cellA.watcherCalls).toBe(watchersBefore);
    endPanelDispatch(event);

    const r = transition(handle.__getState(), {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: idA,
      muted: false,
    });
    handle.__setState(r.state);
    expect(r.state.selectionGrant?.grant).toBeTruthy();
    expect(cellA.watcherCalls).toBe(watchersBefore);

    const grant = r.state.selectionGrant!.grant;
    expect(sdk.rawMuted).toBe(true);
    handle.__ports.get("a")?.dispose();
    handle.__ports.delete("a");
    const port = createPlayerPort({
      identity: idA,
      playerComponent: player,
      provider: "twitch",
      isReady: () => true,
    });
    expect(port).toBeTruthy();
    const restored = await port!.restoreSelectedAudio(grant);
    expect(restored).toBe(true);
    expect(sdk.rawMuted).toBe(false);
    expect(handle.__getState().active?.key).toBe("a");
    expect(await port!.restoreSelectedAudio(grant)).toBe(false);
    expect(sdk.unmuteCalls).toBe(1);
    port!.dispose();
    void cellB;
  });

  it("panel gate survives microtasks between capture and target", async () => {
    const event = createPanelEvent(true);
    beginPanelDispatch(event, true);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(hasPanelDispatch()).toBe(true);
    endPanelDispatch(event);
    expect(hasPanelDispatch()).toBe(false);
  });

  it("wrong event cannot end another dispatch; eventPhase NONE clears", () => {
    const a = createPanelEvent(true);
    const b = createPanelEvent(true);
    beginPanelDispatch(a, true);
    endPanelDispatch(b);
    expect(hasPanelDispatch()).toBe(true);
    (a as unknown as { eventPhase: number }).eventPhase = Event.NONE;
    expect(hasPanelDispatch()).toBe(false);
  });

  it("untrusted nested click does not inherit gate", () => {
    const outer = createPanelEvent(true);
    beginPanelDispatch(outer, true);
    const nested = createPanelEvent(false);
    beginPanelDispatch(nested, false);
    expect(hasPanelDispatch()).toBe(false);
  });

  it("setMuted(false) early return still supplements muteOthers once", async () => {
    const store = createFakeStore({
      muteOthers: true,
      cells: [{ key: "a", provider: "twitch", muted: "omit" }],
    });
    const sdk = createTwitchSdk({ muted: true });
    const cell = createFakeVideoCell({
      store,
      key: "a",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", sdk),
    });
    createFakeMultiviewRoot(store, [cell]);
    window.history.pushState({}, "", "/multiview");
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();

    const id = {
      key: "a",
      contentId: "id-a",
      provider: "twitch" as const,
      generation: 1,
    };
    const r = transition(handle.__getState(), {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: id,
      muted: false,
    });
    handle.__setState(r.state);
    const before = cell.muteOthersCalls.length;
    await handle.__applyEffects(r.effects);
    expect(cell.muteOthersCalls.length).toBe(before + 1);
  });

  it("token expires after 2500ms", () => {
    handle = createAudioLockController({ window, document }) as TestableHandle;
    const id = {
      key: "b",
      contentId: "id-b",
      provider: "twitch" as const,
      generation: 1,
    };
    const state = transition(
      {
        ...createInitialState(),
        extensionEnabled: true,
        muteOthers: true,
        mode: "locked",
        selection: "selected",
        active: {
          key: "a",
          contentId: "id-a",
          provider: "youtube",
          generation: 1,
        },
        epoch: 1,
      },
      {
        type: "IFRAME_INTENT",
        now: 1000,
        identity: id,
        source: "iframe",
      },
    ).state;
    expect(state.intent?.expiresAt).toBe(1000 + TIMING.USER_INTENT_MS);
    const late = transition(state, {
      type: "OBSERVED_MUTED",
      now: 1000 + TIMING.USER_INTENT_MS + 1,
      identity: id,
      muted: false,
      hasValidToken: false,
    });
    expect(late.state.active?.key).toBe("a");
  });

  it("dispose clears ports and listeners", () => {
    setupMixed();
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    expect(handle.__ports.size).toBeGreaterThan(0);
    handle.dispose();
    expect(handle.__ports.size).toBe(0);
  });
});
