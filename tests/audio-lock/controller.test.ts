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
  addFakeCell,
  applyPreset,
  countSessionResources,
  createFakeMultiviewRoot,
  createFakePlayerComponent,
  createFakeStore,
  createFakeVideoCell,
  createPanelEvent,
  createTwitchSdk,
  createYoutubeSdk,
  effectiveMuteProp,
  fireReady,
  mountPlayerOnCell,
  flushMicrotasks,
  removeFakeCell,
  replaceCellContent,
  replacePlayer,
  type FakeEnv,
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
  const ytPlayer = createFakePlayerComponent("youtube", ytSdk);
  const twPlayer = createFakePlayerComponent("twitch", twSdk);
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
    expect(handle.__getState().selection).toBe("selected");
    expect(twSdk.muteCalls).toBeGreaterThanOrEqual(1);
    void cellA;
    void cellB;
    void ytSdk;
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
      const player = createFakePlayerComponent(provider, sdk);
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
    const player = createFakePlayerComponent("twitch", sdk);
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
      cell: cellA,
      playerComponent: player,
      provider: "twitch",
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
      assignment: true,
      origin: "poll",
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

  function setupEnv(
    cells: Array<{
      key: string;
      provider: "youtube" | "twitch";
      muted?: boolean | "omit";
      readyBeforeInstall?: boolean;
    }>,
  ): FakeEnv {
    const store = createFakeStore({ muteOthers: true, cells });
    const cellList: FakeVideoCell[] = [];
    const cellMap = new Map<string, FakeVideoCell>();
    const sdks = new Map<string, ReturnType<typeof createTwitchSdk>>();
    for (const c of cells) {
      const sdk =
        c.provider === "twitch"
          ? createTwitchSdk({ muted: c.muted === true })
          : createYoutubeSdk({ muted: c.muted === true });
      const player = createFakePlayerComponent(c.provider, sdk);
      const cell = createFakeVideoCell({
        store,
        key: c.key,
        provider: c.provider,
        player,
        readyBeforeInstall: c.readyBeforeInstall,
      });
      cellList.push(cell);
      cellMap.set(c.key, cell);
      sdks.set(c.key, sdk);
    }
    const { root, appEl, multiview } = createFakeMultiviewRoot(store, cellList);
    window.history.pushState({}, "", "/multiview");
    return { store, root, appEl, multiview, cells: cellMap, sdks };
  }

  it("rescans_cells_added_after_discovery_window", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "x", provider: "youtube", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().active?.key).toBe("a");

    await vi.advanceTimersByTimeAsync(121_000);
    addFakeCell(env, { key: "b", provider: "twitch", muted: true, readyBeforeInstall: true });
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(0);
    // heartbeat also rescans
    await vi.advanceTimersByTimeAsync(2000);

    expect(handle.__lastBindings.has("b")).toBe(true);
    const cellB = env.cells.get("b")!;
    const sdkA = env.sdks.get("a")!;
    cellB.setMuted(false);
    cellB.updatePausedState(false);
    await flushMicrotasks();
    expect(handle.__getState().active?.key).toBe("a");
    expect(sdkA.rawMuted).toBe(false);
  });

  it("session_observers_released_on_teardown", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    const baseline = countSessionResources(env.store);
    let moCreated = 0;
    let moDisconnected = 0;
    const OriginalMO = window.MutationObserver;
    window.MutationObserver = class extends OriginalMO {
      constructor(cb: MutationCallback) {
        super(cb);
        moCreated += 1;
      }
      disconnect() {
        moDisconnected += 1;
        super.disconnect();
      }
    } as typeof MutationObserver;

    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    expect(moCreated).toBeGreaterThanOrEqual(1);

    handle.setEnabled(false);
    expect(countSessionResources(env.store).watchers).toBe(baseline.watchers);
    expect(moDisconnected).toBeGreaterThanOrEqual(1);

    handle.setEnabled(true);
    handle.__tryDiscover();
    handle.dispose();
    expect(countSessionResources(env.store).watchers).toBe(baseline.watchers);

    window.MutationObserver = OriginalMO;
  });

  it("same_key_provider_swap_rebinds_port", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const oldSdk = env.sdks.get("b")!;
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const genBefore = handle.__lastBindings.get("b")!.identity.generation;

    replaceCellContent(env, "b", { provider: "youtube", contentId: "yt-b2" });
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);

    const genAfter = handle.__lastBindings.get("b")!.identity.generation;
    expect(genAfter).not.toBe(genBefore);
    const newSdk = env.sdks.get("b")!;
    const oldMutes = oldSdk.muteCalls;
    await handle.__reconcile(handle.__lastBindings.get("b")!.identity);
    expect(newSdk.muteCalls).toBeGreaterThanOrEqual(1);
    expect(oldSdk.muteCalls).toBe(oldMutes);
  });

  it("new_vm_instance_for_same_key_is_patched", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    const oldCell = env.cells.get("a")!;
    const origCheck = oldCell.__orig!.manualCheckMuted;

    removeFakeCell(env, "a");
    const neu = addFakeCell(env, {
      key: "a",
      provider: "twitch",
      muted: false,
      contentId: "id-a",
    });
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(2000);

    // Old VM should not remain the live binding target
    expect(handle.__lastBindings.get("a")?.cell).toBe(neu);
    expect(neu.manualCheckMuted).not.toBe(neu.__orig?.manualCheckMuted);
    void oldCell;
    void origCheck;
  });

  it("remove_active_enters_silence", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "youtube", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().active?.key).toBe("a");

    removeFakeCell(env, "a");
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().selection).toBe("silence");

    const cellB = env.cells.get("b")!;
    cellB.firstPlay = true;
    cellB.updatePausedState(false);
    expect(handle.__getState().active).toBeNull();
    expect(handle.__getState().selection).toBe("silence");
  });

  it("refresh_mute_true_is_observation_only", async () => {
    const env = setupEnv([
      { key: "0", provider: "twitch", muted: "omit" },
      { key: "1", provider: "twitch", muted: "omit" },
      { key: "2", provider: "youtube", muted: "omit" },
      { key: "3", provider: "youtube", muted: "omit" },
    ]);
    for (const c of env.cells.values()) c.editMode = true;
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    handle.__setState({
      ...handle.__getState(),
      mode: "waiting-for-choice",
      selection: "bootstrap",
      active: null,
    });
    for (const cell of env.cells.values()) {
      cell.setMuted(true);
    }
    expect(handle.__getState().selection).toBe("bootstrap");
    for (const key of env.cells.keys()) {
      expect(env.store.state.multiview.layoutContent[key].muted).toBeUndefined();
    }
  });

  it("degraded_is_not_reinstalled_by_discovery", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const hang = createTwitchSdk({ hangRead: true });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("b", hang);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    const idB = handle.__lastBindings.get("b")!.identity;
    for (let i = 0; i < 3; i++) {
      const p = handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(750);
      await p;
    }
    expect(handle.__getState().mode).toBe("degraded");
    const patchedBefore = env.cells.get("b")!.manualCheckMuted;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handle.__getState().mode).toBe("degraded");
    expect(env.cells.get("b")!.manualCheckMuted).toBe(patchedBefore);
  });

  it("reenable_clears_degraded", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    handle.__setState({
      ...handle.__getState(),
      mode: "degraded",
      reportedCodes: { "player-unavailable": true },
    });
    handle.setEnabled(false);
    handle.setEnabled(true);
    handle.__tryDiscover();
    expect(handle.__lastBindings.has("a")).toBe(true);
    expect(handle.__getState().mode).not.toBe("degraded");
    void env;
  });

  it("degraded_route_reentry_recovers", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const hang = createTwitchSdk({ hangRead: true });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("b", hang);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    const idB = handle.__lastBindings.get("b")!.identity;
    for (let i = 0; i < 3; i++) {
      const p = handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(750);
      await p;
    }
    expect(handle.__getState().mode).toBe("degraded");
    // Restore a healthy player for B so rediscovery can succeed
    {
      const sdk = createTwitchSdk({ muted: true });
      const __p = createFakePlayerComponent("twitch", sdk);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
      env.sdks.set("b", sdk);
    }
    const origA = env.cells.get("a")!.__orig!.setMuted;
    window.history.pushState({}, "", "/");
    await vi.advanceTimersByTimeAsync(2000);
    window.history.pushState({}, "", "/multiview");
    await vi.advanceTimersByTimeAsync(4000);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(handle.__lastBindings.size).toBe(2);
    expect(env.cells.get("a")!.setMuted).not.toBe(origA);
    expect(env.cells.get("b")!.setMuted).not.toBe(
      env.cells.get("b")!.__orig!.setMuted,
    );
  });

  it("route_watch_released_on_disable_and_dispose", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const hang = createTwitchSdk({ hangRead: true });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("b", hang);
    const baseline = vi.getTimerCount();
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    const idB = handle.__lastBindings.get("b")!.identity;
    for (let i = 0; i < 3; i++) {
      const p = handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(750);
      await p;
    }
    expect(handle.__getState().mode).toBe("degraded");
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(baseline + 1);
    handle.setEnabled(false);
    expect(vi.getTimerCount()).toBe(baseline);
    void env;
  });

  it("route_watch_released_on_dispose", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const hang = createTwitchSdk({ hangRead: true });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("b", hang);
    const baseline = vi.getTimerCount();
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    const idB = handle.__lastBindings.get("b")!.identity;
    for (let i = 0; i < 3; i++) {
      const p = handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(750);
      await p;
    }
    expect(handle.__getState().mode).toBe("degraded");
    handle.dispose();
    expect(vi.getTimerCount()).toBe(baseline);
    const setMutedBefore = env.cells.get("a")!.setMuted;
    window.history.pushState({}, "", "/");
    await vi.advanceTimersByTimeAsync(2000);
    window.history.pushState({}, "", "/multiview");
    await vi.advanceTimersByTimeAsync(4000);
    expect(env.cells.get("a")!.setMuted).toBe(setMutedBefore);
  });

  it("non_multiview_start_waits_for_route", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    window.history.pushState({}, "", "/");
    handle = createAudioLockController({ window, document }) as TestableHandle;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const origSet = env.cells.get("a")!.setMuted;
    handle.setEnabled(true);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(warn).not.toHaveBeenCalled();
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(env.cells.get("a")!.setMuted).toBe(origSet);
    window.history.pushState({}, "", "/multiview");
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.cells.get("a")!.setMuted).not.toBe(origSet);
    expect(handle.__getState().mode).toBe("locked");
    warn.mockRestore();
  });

  it("early_return_supplement_exactly_once_without_fixture_counter", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: true }]);
    const cell = env.cells.get("a")!;
    let mappedCalls = 0;
    const underlying = cell.muteOthers.bind(cell);
    cell.muteOthers = (id) => {
      mappedCalls += 1;
      return underlying(id);
    };
    (cell as { muteOthersCalls: unknown }).muteOthersCalls = { no: "length" };

    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    const id = handle.__lastBindings.get("a")!.identity;
    const r = transition(handle.__getState(), {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: id,
      muted: false,
    });
    handle.__setState(r.state);
    mappedCalls = 0;
    await handle.__applyEffects(r.effects);
    expect(mappedCalls).toBe(1);

    // U assignment path also supplements once
    env.store.state.multiview.layoutContent.a.muted = undefined;
    const r2 = transition(handle.__getState(), {
      type: "EXPLICIT_SET_MUTED",
      now: 1,
      identity: id,
      muted: false,
    });
    handle.__setState(r2.state);
    mappedCalls = 0;
    await handle.__applyEffects(r2.effects);
    expect(mappedCalls).toBe(1);
  });

  it("fallback_skips_paused_and_not_playing", async () => {
    const env = setupEnv([
      { key: "0", provider: "twitch", muted: "omit" },
      { key: "1", provider: "twitch", muted: "omit" },
      { key: "2", provider: "youtube", muted: "omit" },
      { key: "3", provider: "youtube", muted: "omit" },
    ]);
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
    });
    for (const c of env.cells.values()) {
      c.firstPlay = true;
      c.editMode = false;
    }
    const c0 = env.cells.get("0")!;
    // player already READY via fixture mount (no player.ready field)
    // mark 0 paused via wrapper
    c0.updatePausedState(true);
    // only cell 2 playing
    env.cells.get("2")!.updatePausedState(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.__getState().active?.key).toBe("2");
  });

  it("fallback_waits_then_rearms_on_play", async () => {
    const env = setupEnv([
      { key: "0", provider: "twitch", muted: "omit" },
      { key: "1", provider: "twitch", muted: "omit" },
    ]);
    for (const c of env.cells.values()) {
      c.editMode = false;
      c.firstPlay = true;
    }
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
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.__getState().active).toBeNull();
    env.cells.get("1")!.updatePausedState(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.__getState().active?.key).toBe("1");
  });

  it("manual_refresh_cannot_switch_active", async () => {
    for (const provider of ["twitch", "youtube"] as const) {
      document.body.innerHTML = "";
      const env = setupEnv([
        { key: "a", provider: "twitch", muted: false },
        { key: "b", provider, muted: true },
      ]);
      handle = createAudioLockController({ window, document }) as TestableHandle;
      handle.setEnabled(true);
      handle.__tryDiscover();
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.__getState().active?.key).toBe("a");
      const cellB = env.cells.get("b")!;
      cellB.setMuted(false);
      cellB.firstPlay = true;
      cellB.updatePausedState(false);
      expect(handle.__getState().active?.key).toBe("a");
      handle.dispose();
    }
  });

  it("toggle_ten_times_no_leak", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    const baseline = countSessionResources(env.store);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    for (let i = 0; i < 10; i++) {
      handle.setEnabled(true);
      handle.__tryDiscover();
      handle.setEnabled(false);
    }
    const after = countSessionResources(env.store);
    expect(after.watchers).toBe(baseline.watchers);
    expect(after.subscribers).toBe(baseline.subscribers);
    expect(handle.__ports.size).toBe(0);
  });

  it("locked_add_unassigned_cell_normalized_on_ready", async () => {
    for (const provider of ["twitch", "youtube"] as const) {
      document.body.innerHTML = "";
      const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
      handle = createAudioLockController({ window, document }) as TestableHandle;
      handle.setEnabled(true);
      handle.__tryDiscover();
      await vi.advanceTimersByTimeAsync(0);
      const cell = addFakeCell(env, {
        key: "n",
        provider,
        muted: "omit",
        readyBeforeInstall: false,
      });
      const sdk = env.sdks.get("n")!;
      await vi.advanceTimersByTimeAsync(16);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sdk.muteCalls).toBe(0);
      expect(env.store.state.multiview.layoutContent.n.muted).toBeUndefined();
      fireReady(cell.$refs.player!);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(0);
      expect(env.store.state.multiview.layoutContent.n.muted).toBe(true);
      sdk.rawMuted = false;
      await handle.__reconcile(handle.__lastBindings.get("n")!.identity);
      expect(sdk.muteCalls).toBeGreaterThanOrEqual(1);
      expect(handle.__getState().active?.key).toBe("a");
      expect(handle.__getState().mode).not.toBe("degraded");
      handle.dispose();
    }
  });

  it("preset_replace_bootstraps_merge_keeps_active_silence_stays", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "youtube", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);

    applyPreset(
      env,
      [
        { key: "x", provider: "twitch", muted: "omit" },
        { key: "y", provider: "youtube", muted: "omit" },
      ],
      { merge: false },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(["bootstrap", "silence"]).toContain(handle.__getState().selection);

    // silence stays
    handle.__setState({
      ...handle.__getState(),
      selection: "silence",
      active: null,
      mode: "waiting-for-choice",
    });
    applyPreset(
      env,
      [{ key: "z", provider: "twitch", muted: "omit" }],
      { merge: false },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().selection).toBe("silence");
  });

  it("focus_token_requires_muted_to_unmuted_edge", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const idB = handle.__lastBindings.get("b")!.identity;
    // B always false — token without edge
    env.sdks.get("b")!.rawMuted = false;
    handle.__setState({
      ...handle.__getState(),
      intent: {
        identity: idB,
        source: "iframe",
        expiresAt: Date.now() + 2500,
        consumed: false,
      },
      cells: {
        ...handle.__getState().cells,
        b: {
          ...emptyRuntime(),
          lastObservedMuted: false,
        },
      },
    });
    await handle.__reconcile(idB);
    expect(handle.__getState().active?.key).toBe("a");

    // positive: true then false
    handle.__setState({
      ...handle.__getState(),
      active: handle.__lastBindings.get("a")!.identity,
      selection: "selected",
      mode: "locked",
      intent: {
        identity: idB,
        source: "iframe",
        expiresAt: Date.now() + 2500,
        consumed: false,
      },
      cells: {
        b: { ...emptyRuntime(), lastObservedMuted: null, settleUntil: 0 },
      },
    });
    env.sdks.get("b")!.rawMuted = true;
    await handle.__reconcile(idB);
    env.sdks.get("b")!.rawMuted = false;
    await handle.__reconcile(idB);
    expect(handle.__getState().active?.key).toBe("b");
  });

  it("mute_writes_respect_cooldown_and_settle", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const sdk = createTwitchSdk({ muted: false, ignoreMute: true });
    {
      const __p = createFakePlayerComponent("twitch", sdk);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("b", sdk);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    // force rebind
    await vi.advanceTimersByTimeAsync(2000);
    const idB = handle.__lastBindings.get("b")!.identity;
    for (let i = 0; i < 10; i++) {
      await handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sdk.muteCalls).toBeLessThanOrEqual(4);
  });

  it("bfcache_pageshow_revalidates", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    expect(handle.__ports.size).toBeGreaterThan(0);
    window.dispatchEvent(new Event("pagehide"));
    expect(handle.__ports.size).toBe(0);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    handle.__tryDiscover();
    expect(handle.__lastBindings.has("a")).toBe(true);
    void env;
  });

  it("player_rebuild_bumps_generation_and_drops_stale_results", async () => {
    const env = setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    const hang = createTwitchSdk({ hangRead: true, muted: false });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("a")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("a", hang);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(2000);
    const oldId = handle.__lastBindings.get("a")!.identity;
    const stale = handle.__reconcile(oldId);
    replacePlayer(env, "a");
    await vi.advanceTimersByTimeAsync(2000);
    const newId = handle.__lastBindings.get("a")!.identity;
    expect(newId.generation).not.toBe(oldId.generation);
    await vi.advanceTimersByTimeAsync(750);
    await stale;
    expect(handle.__getState().active?.generation).not.toBe(oldId.generation);
  });

  it("mute_did_not_settle_degrades_after_three", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const sdk = createTwitchSdk({ muted: false, ignoreMute: true });
    {
      const __p = createFakePlayerComponent("twitch", sdk);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(2000);
    const idB = handle.__lastBindings.get("b")!.identity;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < 4; i++) {
      await handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(handle.__getState().mode).toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("store_did_not_settle_degrades_at_500ms", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const cellB = env.cells.get("b")!;
    cellB.muteOthers = () => {
      /* do not write store */
    };
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const idB = handle.__lastBindings.get("b")!.identity;
    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    cellB.setMuted(false);
    endPanelDispatch(ev);
    await vi.advanceTimersByTimeAsync(500);
    expect(handle.__getState().mode).toBe("degraded");
    void idB;
  });

  it("selection_settle_ignores_stale_true", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const sdk = createTwitchSdk({ muted: true, settleDelayMs: 800 });
    {
      const __p = createFakePlayerComponent("twitch", sdk);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(2000);
    const idB = handle.__lastBindings.get("b")!.identity;
    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("b")!.setMuted(false);
    endPanelDispatch(ev);
    await flushMicrotasks();
    await handle.__reconcile(idB);
    expect(handle.__getState().selection).not.toBe("silence");
    await vi.advanceTimersByTimeAsync(1500);
    expect(handle.__getState().active?.key).toBe("b");
  });

  it("unassigned_selection_restores_actual_player_audio via first-play", async () => {
    const env = setupEnv([
      { key: "0", provider: "twitch", muted: "omit" },
      { key: "1", provider: "youtube", muted: "omit" },
    ]);
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
    });
    const cell = env.cells.get("0")!;
    const sdk = env.sdks.get("0")!;
    sdk.rawMuted = true;
    const beforeWatch = cell.watcherCalls;
    const id = handle.__lastBindings.get("0")!.identity;
    const r = transition(handle.__getState(), {
      type: "NATIVE_FIRST_PLAY",
      now: 0,
      identity: id,
    });
    handle.__setState(r.state);
    await handle.__applyEffects(r.effects);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().active?.key).toBe("0");
    expect(cell.watcherCalls).toBe(beforeWatch);
  });

  it("unassigned_selection_restores_actual_player_audio via fallback", async () => {
    const env = setupEnv([
      { key: "0", provider: "twitch", muted: "omit" },
      { key: "1", provider: "youtube", muted: "omit" },
    ]);
    for (const c of env.cells.values()) {
      c.editMode = false;
      c.firstPlay = true;
    }
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
    });
    env.cells.get("1")!.updatePausedState(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.__getState().active?.key).toBe("1");
  });

  it("pending_grant_cancelled_by_disable_mute_all_or_new_selection", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: true },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const hang = createTwitchSdk({ hangUnmute: true, muted: true });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("a")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("a", hang);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(2000);
    const idA = handle.__lastBindings.get("a")!.identity;
    const unmuteBefore = hang.unmuteCalls;
    const r = transition(handle.__getState(), {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: idA,
      muted: false,
    });
    handle.__setState(r.state);
    void handle.__applyEffects(r.effects);
    handle.setEnabled(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(hang.unmuteCalls).toBe(unmuteBefore);
    expect(handle.__getState().mode).toBe("disabled");
    void env;
  });

  it("last_command_wins_a_b_a", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: true },
      { key: "b", provider: "twitch", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    const idA = handle.__lastBindings.get("a")!.identity;
    const idB = handle.__lastBindings.get("b")!.identity;
    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("a")!.setMuted(false);
    env.cells.get("b")!.setMuted(false);
    env.cells.get("a")!.setMuted(false);
    endPanelDispatch(ev);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().active?.key).toBe("a");
    void idA;
    void idB;
  });

  it("repeated_enable_single_discovery_loop", async () => {
    setupEnv([{ key: "a", provider: "twitch", muted: false }]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.setEnabled(true);
    handle.__tryDiscover();
    expect(handle.__lastBindings.size).toBeGreaterThan(0);
    handle.setEnabled(false);
    handle.setEnabled(true);
    handle.__tryDiscover();
    expect(handle.__getState().mode).not.toBe("degraded");
  });

  it("no_test_hooks_on_page_handle", async () => {
    const { installAudioLock } = await import(
      "../../src/pages/content/holodex/twitch-audio-lock"
    );
    const page = installAudioLock();
    expect(Object.keys(page).sort()).toEqual(["dispose", "setEnabled"]);
    expect(
      (page as { __reconcile?: unknown }).__reconcile,
    ).toBeUndefined();
    page.dispose();
  });

  it("initial_mute_others_off_has_no_discovery_timeout", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    env.store.state.multiview.muteOthers = false;
    handle = createAudioLockController({ window, document }) as TestableHandle;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cellB = env.cells.get("b")!;
    const muteOthersBefore = cellB.muteOthersCalls.length;
    handle.setEnabled(true);
    await vi.advanceTimersByTimeAsync(122_000);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(warn).not.toHaveBeenCalled();
    // Wrapper fully delegates while Mute Others is off
    cellB.setMuted(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(cellB.muteOthersCalls.length).toBeGreaterThan(muteOthersBefore);
    // Restore snapshot and turn Mute Others on → lock engages
    env.store.state.multiview.layoutContent.a.muted = false;
    env.store.state.multiview.layoutContent.b.muted = true;
    env.sdks.get("b")!.rawMuted = true;
    env.store.commit("multiview/setMuteOthers", true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(handle.__getState().mode).toBe("locked");
    expect(handle.__getState().active?.key).toBe("a");
    expect(handle.__lastBindings.size).toBe(2);
    env.sdks.get("b")!.rawMuted = false;
    await cellB.manualCheckMuted();
    expect(env.sdks.get("b")!.rawMuted).toBe(true);
    warn.mockRestore();
  });

  it("duplicate_enable_keeps_guard_active", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().mode).toBe("locked");
    const epoch = handle.__getState().epoch;
    handle.setEnabled(true);
    handle.setEnabled(true);
    const sdkB = env.sdks.get("b")!;
    sdkB.rawMuted = false;
    await env.cells.get("b")!.manualCheckMuted();
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkB.rawMuted).toBe(true);
    expect(handle.__getState().mode).toBe("locked");
    expect(handle.__getState().active?.key).toBe("a");
    expect(handle.__getState().epoch).toBe(epoch);
  });

  it("duplicate_enable_keeps_degraded_latch", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const hang = createTwitchSdk({ hangRead: true });
    {
      const __p = createFakePlayerComponent("twitch", hang);
      mountPlayerOnCell(env.cells.get("b")!, __p, { readyBeforeInstall: true });
    }
    env.sdks.set("b", hang);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    const idB = handle.__lastBindings.get("b")!.identity;
    for (let i = 0; i < 3; i++) {
      const p = handle.__reconcile(idB);
      await vi.advanceTimersByTimeAsync(750);
      await p;
    }
    expect(handle.__getState().mode).toBe("degraded");
    const setMutedAfterDegrade = env.cells.get("b")!.setMuted;
    handle.setEnabled(true);
    expect(handle.__getState().mode).toBe("degraded");
    expect(env.cells.get("b")!.setMuted).toBe(setMutedAfterDegrade);
  });

  it("ready_sdk_missing_methods_degrades", async () => {
    const env = setupEnv([
      { key: "a", provider: "twitch", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    const cell = env.cells.get("b")!;
    const empty = {} as ReturnType<typeof createTwitchSdk>;
    cell.$refs.player!.player = empty;
    cell.twPlayer = empty;
    env.sdks.set("b", empty);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const origA = env.cells.get("a")!.setMuted;
    const origB = cell.setMuted;
    handle.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().mode).toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      code: "cell-contract-changed",
    });
    // wrappers restored to pre-patch functions
    expect(env.cells.get("a")!.setMuted).toBe(origA);
    expect(cell.setMuted).toBe(origB);
    warn.mockRestore();
  });

  it("upstream_shape_ready_event_binds_and_guards", async () => {
    for (const provider of ["twitch", "youtube"] as const) {
      document.body.innerHTML = "";
      const env = setupEnv([
        { key: "a", provider, muted: false, readyBeforeInstall: false },
        { key: "b", provider, muted: true, readyBeforeInstall: false },
      ]);
      handle = createAudioLockController({ window, document }) as TestableHandle;
      handle.setEnabled(true);
      for (const cell of env.cells.values()) {
        fireReady(cell.$refs.player!);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.__ports.size).toBe(2);
      for (const [, port] of handle.__ports) {
        expect(port.isBound()).toBe(true);
      }
      expect(handle.__getState().active?.key).toBe("a");
      const sdkB = env.sdks.get("b")!;
      sdkB.rawMuted = false;
      await env.cells.get("b")!.manualCheckMuted();
      expect(sdkB.rawMuted).toBe(true);
      expect(handle.__getState().active?.key).toBe("a");
      handle.dispose();
    }
  });

  it("upstream_shape_late_bind_guards", async () => {
    for (const provider of ["twitch", "youtube"] as const) {
      document.body.innerHTML = "";
      const env = setupEnv([
        { key: "a", provider, muted: false, readyBeforeInstall: true },
        { key: "b", provider, muted: true, readyBeforeInstall: true },
      ]);
      handle = createAudioLockController({ window, document }) as TestableHandle;
      handle.setEnabled(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(handle.__ports.size).toBe(2);
      for (const [, port] of handle.__ports) {
        expect(port.isBound()).toBe(true);
      }
      expect(handle.__getState().active?.key).toBe("a");
      const sdkB = env.sdks.get("b")!;
      sdkB.rawMuted = false;
      await env.cells.get("b")!.manualCheckMuted();
      expect(sdkB.rawMuted).toBe(true);
      expect(handle.__getState().active?.key).toBe("a");
      handle.dispose();
    }
  });
});

function emptyRuntime() {
  return {
    readInFlight: false,
    muteInFlight: false,
    lastMuteAt: 0,
    consecutiveFailures: 0,
    lastGuardMuteAt: 0,
    settleUntil: 0,
    ownMuteGeneration: null as number | null,
    lastObservedMuted: null as boolean | null,
    unsettledMuteCount: 0,
  };
}
