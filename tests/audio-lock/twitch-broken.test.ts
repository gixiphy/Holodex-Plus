import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPanelDispatch,
  createAudioLockController,
  endPanelDispatch,
  type TestableHandle,
} from "../../src/pages/content/holodex/audio-lock/controller";
import {
  createFakeMultiviewRoot,
  createFakePlayerComponent,
  createFakeStore,
  createFakeVideoCell,
  createPanelEvent,
  createTwitchSdk,
  createYoutubeSdk,
  flushMicrotasks,
  focusIframeAndBlurWindow,
  moveFocusToIframeWithoutBlur,
  postTwitchUpdateState,
  returnFocusToPageWithoutFocusIn,
  type FakeEnv,
  type FakeSdk,
  type FakeVideoCell,
} from "./fixtures";
import { installTwitchStateListener } from "../../src/pages/content/holodex/audio-lock/twitch-embed";

function setupBrokenEnv(opts?: {
  twitchBroken?: boolean;
  twitchIgnoreMute?: boolean;
  twitchMuted?: boolean;
  missingMethods?: boolean;
  healthyTwitch?: boolean;
  readyNever?: boolean;
  twitchPlaceholder?: boolean;
}): FakeEnv & { postSpies: Map<string, ReturnType<typeof vi.fn>> } {
  const store = createFakeStore({
    muteOthers: true,
    cells: [
      { key: "a", provider: "youtube", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ],
  });
  const ytSdk = createYoutubeSdk({ muted: false });
  let twSdk: FakeSdk;
  if (opts?.missingMethods) {
    twSdk = {} as FakeSdk;
    twSdk.rawMuted = false;
    twSdk.muteCalls = 0;
    twSdk.unmuteCalls = 0;
  } else if (opts?.healthyTwitch) {
    twSdk = createTwitchSdk({
      muted: opts.twitchMuted ?? false,
      ignoreMute: opts.twitchIgnoreMute,
    });
  } else {
    twSdk = createTwitchSdk({
      muted: opts?.twitchMuted ?? true,
      brokenByVue: opts?.twitchBroken !== false,
      ignoreMute: opts?.twitchIgnoreMute,
    });
  }
  const ytPlayer = createFakePlayerComponent("youtube", ytSdk);
  const twPlayer = createFakePlayerComponent(
    "twitch",
    twSdk,
    opts?.twitchPlaceholder ? { sdkLoaded: false } : undefined,
  );
  if (opts?.twitchPlaceholder && twPlayer.player && typeof twPlayer.player === "object") {
    Object.defineProperty(twPlayer.player, "__ob__", { value: {} });
  }
  const postSpies = new Map<string, ReturnType<typeof vi.fn>>();
  const twIframe = twPlayer.$el.querySelector("iframe") as HTMLIFrameElement;
  const spy = vi.fn();
  const cw = { postMessage: spy };
  Object.defineProperty(twIframe, "contentWindow", {
    value: cw,
    configurable: true,
  });
  postSpies.set("b", spy);

  const cellA = createFakeVideoCell({
    store,
    key: "a",
    provider: "youtube",
    player: ytPlayer,
    nativeCheckMuted: true,
  });
  const cellB = createFakeVideoCell({
    store,
    key: "b",
    provider: "twitch",
    player: twPlayer,
    nativeCheckMuted: true,
    readyBeforeInstall: opts?.readyNever ? false : undefined,
  });
  if (opts?.missingMethods) {
    cellB.$refs.player!.player = twSdk;
    cellB.twPlayer = twSdk;
  }
  const { root, appEl, multiview } = createFakeMultiviewRoot(store, [
    cellA,
    cellB,
  ]);
  window.history.pushState({}, "", "/multiview");
  const cells = new Map<string, FakeVideoCell>([
    ["a", cellA],
    ["b", cellB],
  ]);
  const sdks = new Map<string, FakeSdk>([
    ["a", ytSdk],
    ["b", twSdk],
  ]);
  return { store, root, appEl, multiview, cells, sdks, postSpies };
}

async function pollSeconds(
  env: FakeEnv,
  handle: TestableHandle,
  seconds: number,
): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    await env.cells.get("a")!.manualCheckMuted();
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
  }
  void handle;
}

function triggerIframeIntent(cell: FakeVideoCell): void {
  const iframe = cell.$el.querySelector("iframe");
  if (!iframe) throw new Error("no iframe");
  iframe.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

function makeHandle(): TestableHandle {
  return createAudioLockController({
    window,
    document,
    isTrusted: () => true,
  }) as TestableHandle;
}

describe("twitch broken SDK / no-degrade", () => {
  let handle: TestableHandle;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    installTwitchStateListener(window, () => Date.now());
  });

  afterEach(() => {
    handle?.dispose();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("broken_twitch_poll_never_degrades_or_warns", async () => {
    const env = setupBrokenEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    await pollSeconds(env, handle, 20);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(0);
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(env.sdks.get("a")!.muteCalls).toBe(0);
    warn.mockRestore();
  });

  it("broken_twitch_never_calls_native_manualCheckMuted", async () => {
    const env = setupBrokenEnv();
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const patchedB = env.cells.get("b")!.manualCheckMuted;
    await pollSeconds(env, handle, 20);
    expect(env.cells.get("a")!.nativeCheckCalls).toBe(0);
    expect(env.cells.get("b")!.nativeCheckCalls).toBe(0);
    expect(env.cells.get("b")!.manualCheckMuted).toBe(patchedB);
  });

  it("untrusted_twitch_is_muted_once_per_selection", async () => {
    const env = setupBrokenEnv();
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    await pollSeconds(env, handle, 20);
    const spy = env.postSpies.get("b")!;
    const mutePosts = () =>
      spy.mock.calls.filter((c) => c[0]?.params === true).length;
    expect(mutePosts()).toBe(1);

    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("a")!.setMuted(false);
    endPanelDispatch(ev);
    await flushMicrotasks();
    await pollSeconds(env, handle, 3);
    expect(mutePosts()).toBe(2);
  });

  it("untrusted_failed_post_is_retried_after_cooldown", async () => {
    const env = setupBrokenEnv();
    const spy = env.postSpies.get("b")!;
    let calls = 0;
    spy.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("post failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2000);
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();
    expect(calls).toBeGreaterThanOrEqual(2);
    await pollSeconds(env, handle, 20);
    // calls includes the first throw; successful posts = calls - 1
    expect(calls - 1).toBe(1);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(0);
    expect(env.cells.get("b")!.nativeCheckCalls).toBe(0);
    warn.mockRestore();

    // iframe temporarily missing
    const env2 = setupBrokenEnv();
    const cellB = env2.cells.get("b")!;
    const iframe = cellB.$el.querySelector("iframe")!;
    iframe.remove();
    handle?.dispose();
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    await cellB.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    cellB.$refs.player!.$el.appendChild(iframe);
    const spy2 = env2.postSpies.get("b")!;
    spy2.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    await cellB.manualCheckMuted();
    await flushMicrotasks();
    expect(
      spy2.mock.calls.filter((c) => c[0]?.params === true).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("iframe_state_mute_not_applied_keeps_retrying_until_confirmed", async () => {
    const env = setupBrokenEnv();
    // Make b active first
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("b")!.identity,
      epoch: 1,
    });
    const iframe = env.cells
      .get("b")!
      .$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(iframe, { muted: false });

    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("a")!.setMuted(false);
    endPanelDispatch(ev);
    await flushMicrotasks();

    const spy = env.postSpies.get("b")!;
    for (let i = 0; i < 3; i++) {
      postTwitchUpdateState(iframe, { muted: false });
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    const beforeConfirm = spy.mock.calls.filter((c) => c[0]?.params === true)
      .length;
    expect(beforeConfirm).toBeGreaterThanOrEqual(2);

    postTwitchUpdateState(iframe, { muted: true });
    for (let i = 0; i < 5; i++) {
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    const after = spy.mock.calls.filter((c) => c[0]?.params === true).length;
    expect(after).toBe(beforeConfirm);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
  });

  it("broken_twitch_user_unmute_in_iframe_switches_then_reverse", async () => {
    const env = setupBrokenEnv();
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const iframe = env.cells
      .get("b")!
      .$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(iframe, { muted: true });
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();
    // Expire settle so unmute edge can claim selection
    await vi.advanceTimersByTimeAsync(1600);

    const spy = env.postSpies.get("b")!;
    spy.mockClear();
    triggerIframeIntent(env.cells.get("b")!);
    await vi.advanceTimersByTimeAsync(0);
    postTwitchUpdateState(iframe, { muted: false });
    for (let i = 0; i < 2; i++) {
      await env.cells.get("a")!.manualCheckMuted();
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(handle.__getState().active?.key).toBe("b");
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(true);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(false);
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBe(0);

    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("a")!.setMuted(false);
    endPanelDispatch(ev);
    await flushMicrotasks();
    for (let i = 0; i < 2; i++) {
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(
      spy.mock.calls.filter((c) => c[0]?.params === true).length,
    ).toBeGreaterThanOrEqual(1);
    expect(handle.__getState().active?.key).toBe("a");
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(true);

    const afterMute = spy.mock.calls.filter((c) => c[0]?.params === true)
      .length;
    postTwitchUpdateState(iframe, { muted: true });
    for (let i = 0; i < 5; i++) {
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBe(
      afterMute,
    );
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(env.cells.get("b")!.nativeCheckCalls).toBe(0);

    // Negative: unmuted without intent → re-mute, active unchanged
    handle.__setState({
      ...handle.__getState(),
      active: handle.__lastBindings.get("a")!.identity,
      intent: null,
    });
    spy.mockClear();
    postTwitchUpdateState(iframe, { muted: false });
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      spy.mock.calls.filter((c) => c[0]?.params === true).length,
    ).toBeGreaterThanOrEqual(1);
    expect(handle.__getState().active?.key).toBe("a");
  });

  it("twitch_missing_sdk_methods_never_falls_back_to_native", async () => {
    const env = setupBrokenEnv({ missingMethods: true, twitchBroken: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mappedMuteOthers = env.cells.get("a")!.__orig!.muteOthers;
    const muteOthersCallsBefore = env.cells.get("a")!.muteOthersCalls.length;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const patchedA = env.cells.get("a")!.manualCheckMuted;
    const patchedB = env.cells.get("b")!.manualCheckMuted;
    const patchedSetA = env.cells.get("a")!.setMuted;
    const patchedSetB = env.cells.get("b")!.setMuted;
    const patchedMOA = env.cells.get("a")!.muteOthers;
    const patchedMOB = env.cells.get("b")!.muteOthers;
    await pollSeconds(env, handle, 20);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      code: "twitch-sdk-contract-changed",
    });
    expect(env.cells.get("a")!.manualCheckMuted).toBe(patchedA);
    expect(env.cells.get("b")!.manualCheckMuted).toBe(patchedB);
    expect(env.cells.get("a")!.setMuted).toBe(patchedSetA);
    expect(env.cells.get("b")!.setMuted).toBe(patchedSetB);
    expect(env.cells.get("a")!.muteOthers).toBe(patchedMOA);
    expect(env.cells.get("b")!.muteOthers).toBe(patchedMOB);
    expect(env.cells.get("a")!.nativeCheckCalls).toBe(0);
    expect(env.cells.get("b")!.nativeCheckCalls).toBe(0);
    expect(env.cells.get("a")!.muteOthersCalls.length).toBe(
      muteOthersCallsBefore,
    );
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(
      env.postSpies.get("b")!.mock.calls.filter((c) => c[0]?.params === true)
        .length,
    ).toBeGreaterThanOrEqual(1);
    void mappedMuteOthers;
    warn.mockRestore();
  });

  it("reverse_switch_panel_mutes_broken_twitch_within_2s", async () => {
    const env = setupBrokenEnv();
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("b")!.identity,
      epoch: 1,
    });
    const spy = env.postSpies.get("b")!;
    spy.mockClear();
    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("a")!.setMuted(false);
    endPanelDispatch(ev);
    await flushMicrotasks();
    for (let i = 0; i < 2; i++) {
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(
      spy.mock.calls.filter((c) => c[0]?.params === true).length,
    ).toBeGreaterThanOrEqual(1);
    expect(handle.__getState().active?.key).toBe("a");
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(true);
    expect(handle.__getState().mode).not.toBe("degraded");
  });

  it("reverse_switch_panel_mutes_healthy_twitch_within_2s", async () => {
    const env = setupBrokenEnv({
      healthyTwitch: true,
      twitchMuted: false,
      twitchBroken: false,
    });
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    env.sdks.get("b")!.rawMuted = false;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("b")!.identity,
      epoch: 1,
    });
    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    env.cells.get("a")!.setMuted(false);
    endPanelDispatch(ev);
    await flushMicrotasks();
    for (let i = 0; i < 2; i++) {
      await env.cells.get("a")!.manualCheckMuted();
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(env.sdks.get("b")!.rawMuted).toBe(true);
    expect(env.sdks.get("a")!.rawMuted).toBe(false);
  });

  it("reverse_switch_youtube_iframe_intent_mutes_twitch", async () => {
    const env = setupBrokenEnv({
      healthyTwitch: true,
      twitchMuted: false,
      twitchBroken: false,
    });
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    env.sdks.get("b")!.rawMuted = false;
    env.sdks.get("a")!.rawMuted = true;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("b")!.identity,
      epoch: 1,
    });
    // Establish lastObservedMuted=true on YouTube while Twitch is active
    env.sdks.get("a")!.rawMuted = true;
    await env.cells.get("a")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1600);
    triggerIframeIntent(env.cells.get("a")!);
    await vi.advanceTimersByTimeAsync(0);
    env.sdks.get("a")!.rawMuted = false;
    for (let i = 0; i < 2; i++) {
      await env.cells.get("a")!.manualCheckMuted();
      await env.cells.get("b")!.manualCheckMuted();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(handle.__getState().active?.key).toBe("a");
    expect(env.sdks.get("b")!.rawMuted).toBe(true);
  });

  it("twitch_first_play_does_not_claim_bootstrap_when_youtube_present", async () => {
    const store = createFakeStore({
      muteOthers: true,
      cells: [
        { key: "0", provider: "twitch", muted: "omit" },
        { key: "1", provider: "youtube", muted: "omit" },
      ],
    });
    const twSdk = createTwitchSdk({ muted: false });
    const ytSdk = createYoutubeSdk({ muted: false });
    const cell0 = createFakeVideoCell({
      store,
      key: "0",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", twSdk),
    });
    const cell1 = createFakeVideoCell({
      store,
      key: "1",
      provider: "youtube",
      player: createFakePlayerComponent("youtube", ytSdk),
    });
    createFakeMultiviewRoot(store, [cell0, cell1]);
    window.history.pushState({}, "", "/multiview");
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "waiting-for-choice",
      selection: "bootstrap",
      active: null,
      epoch: 0,
    });
    cell0.editMode = true;
    cell1.editMode = true;
    const mappedCalls = cell0.muteOthersCalls.length;
    cell0.updatePausedState(false);
    await flushMicrotasks();
    expect(handle.__getState().active).toBe(null);
    expect(cell0.muteOthersCalls.length).toBe(mappedCalls);
    expect(cell0.firstPlay).toBe(false);
    cell1.updatePausedState(false);
    await flushMicrotasks();
    expect(handle.__getState().active?.key).toBe("1");
  });

  it("bootstrap_fallback_prefers_non_twitch_cell", async () => {
    const store = createFakeStore({
      muteOthers: true,
      cells: [
        { key: "0", provider: "twitch", muted: "omit" },
        { key: "1", provider: "youtube", muted: "omit" },
      ],
    });
    const cell0 = createFakeVideoCell({
      store,
      key: "0",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk({ muted: false })),
    });
    const cell1 = createFakeVideoCell({
      store,
      key: "1",
      provider: "youtube",
      player: createFakePlayerComponent("youtube", createYoutubeSdk({ muted: false })),
    });
    cell0.editMode = false;
    cell0.firstPlay = false; // already played / playing
    cell1.editMode = true; // paused
    cell1.firstPlay = true;
    createFakeMultiviewRoot(store, [cell0, cell1]);
    window.history.pushState({}, "", "/multiview");
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "waiting-for-choice",
      selection: "bootstrap",
      active: null,
      epoch: 0,
    });
    // Mark twitch as playing via pausedByKey path
    cell0.updatePausedState(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.__getState().active).toBe(null);
    cell1.editMode = false;
    cell1.updatePausedState(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handle.__getState().active?.key).toBe("1");
  });

  it("twitch_only_layout_bootstrap_unchanged", async () => {
    const store = createFakeStore({
      muteOthers: true,
      cells: [
        { key: "0", provider: "twitch", muted: "omit" },
        { key: "1", provider: "twitch", muted: "omit" },
      ],
    });
    const cell0 = createFakeVideoCell({
      store,
      key: "0",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk({ muted: false })),
    });
    const cell1 = createFakeVideoCell({
      store,
      key: "1",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk({ muted: false })),
    });
    createFakeMultiviewRoot(store, [cell0, cell1]);
    window.history.pushState({}, "", "/multiview");
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "waiting-for-choice",
      selection: "bootstrap",
      active: null,
      epoch: 0,
    });
    cell0.editMode = true;
    cell0.updatePausedState(false);
    await flushMicrotasks();
    expect(handle.__getState().active?.key).toBe("0");
  });

  it("healthy_twitch_ignoring_mute_does_not_degrade", async () => {
    const env = setupBrokenEnv({
      healthyTwitch: true,
      twitchMuted: false,
      twitchIgnoreMute: true,
      twitchBroken: false,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    await pollSeconds(env, handle, 20);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(0);
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(env.sdks.get("b")!.muteCalls).toBeGreaterThanOrEqual(3);
    warn.mockRestore();
  });

  it("same_iframe_second_click_after_blank_click_switches_to_twitch", async () => {
    const env = setupBrokenEnv({ healthyTwitch: true, twitchBroken: false, twitchMuted: true });
    env.sdks.get("b")!.rawMuted = true;
    let focusInCount = 0;
    const onFocusIn = () => {
      focusInCount += 1;
    };
    window.addEventListener("focusin", onFocusIn);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("a")!.identity,
      epoch: 1,
      intent: null,
    });
    const iframe = env.cells
      .get("b")!
      .$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(iframe, { muted: true });
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();

    focusIframeAndBlurWindow(iframe);
    await vi.advanceTimersByTimeAsync(0);
    returnFocusToPageWithoutFocusIn();
    expect(focusInCount).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);

    const spy = env.postSpies.get("b")!;
    spy.mockClear();
    const muteCallsBefore = env.sdks.get("b")!.muteCalls;
    focusIframeAndBlurWindow(iframe);
    await vi.advanceTimersByTimeAsync(0);
    env.sdks.get("b")!.rawMuted = false;
    postTwitchUpdateState(iframe, { muted: false });
    await pollSeconds(env, handle, 2);

    expect(handle.__getState().active?.key).toBe("b");
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(true);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(false);
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBe(0);
    expect(env.sdks.get("b")!.muteCalls).toBe(muteCallsBefore);
    expect(focusInCount).toBe(0);
    window.removeEventListener("focusin", onFocusIn);
  });

  it("same_iframe_second_click_broken_twitch_switches", async () => {
    const env = setupBrokenEnv();
    let focusInCount = 0;
    const onFocusIn = () => {
      focusInCount += 1;
    };
    window.addEventListener("focusin", onFocusIn);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("a")!.identity,
      epoch: 1,
      intent: null,
    });
    const iframe = env.cells
      .get("b")!
      .$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(iframe, { muted: true });
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();

    focusIframeAndBlurWindow(iframe);
    await vi.advanceTimersByTimeAsync(0);
    returnFocusToPageWithoutFocusIn();
    expect(focusInCount).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);

    const spy = env.postSpies.get("b")!;
    spy.mockClear();
    focusIframeAndBlurWindow(iframe);
    await vi.advanceTimersByTimeAsync(0);
    postTwitchUpdateState(iframe, { muted: false });
    await pollSeconds(env, handle, 2);

    expect(handle.__getState().active?.key).toBe("b");
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(true);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(false);
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBe(0);
    expect(focusInCount).toBe(0);
    window.removeEventListener("focusin", onFocusIn);
  });

  it("repeated_blur_intent_still_expires_after_2500ms", async () => {
    const env = setupBrokenEnv({ healthyTwitch: true, twitchBroken: false, twitchMuted: true });
    env.sdks.get("b")!.rawMuted = true;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("a")!.identity,
      epoch: 1,
      intent: null,
    });
    const iframe = env.cells
      .get("b")!
      .$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(iframe, { muted: true });
    await env.cells.get("b")!.manualCheckMuted();
    await flushMicrotasks();

    focusIframeAndBlurWindow(iframe);
    await vi.advanceTimersByTimeAsync(0);
    returnFocusToPageWithoutFocusIn();
    focusIframeAndBlurWindow(iframe);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2600);

    const spy = env.postSpies.get("b")!;
    spy.mockClear();
    const muteCallsBefore = env.sdks.get("b")!.muteCalls;
    env.sdks.get("b")!.rawMuted = false;
    postTwitchUpdateState(iframe, { muted: false });
    await pollSeconds(env, handle, 2);

    expect(handle.__getState().active?.key).toBe("a");
    expect(env.store.state.multiview.layoutContent.a.muted).not.toBe(true);
    const remuteViaPost =
      spy.mock.calls.filter((c) => c[0]?.params === true).length;
    const remuteViaSdk = env.sdks.get("b")!.muteCalls - muteCallsBefore;
    expect(remuteViaPost + remuteViaSdk).toBeGreaterThanOrEqual(1);
  });

  const DEGRADED_CODES = [
    "player-unavailable",
    "player-mute-did-not-settle",
    "store-did-not-settle",
    "restore-failed",
    "cell-contract-changed",
  ];

  function lockOnTwitch(handle: TestableHandle): void {
    handle.__setState({
      ...handle.__getState(),
      mode: "locked",
      selection: "selected",
      active: handle.__lastBindings.get("b")!.identity,
      epoch: 1,
      intent: null,
    });
  }

  it("iframe_to_iframe_focus_reverse_switch_healthy_twitch", async () => {
    const env = setupBrokenEnv({
      healthyTwitch: true,
      twitchBroken: false,
      twitchMuted: false,
    });
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    env.sdks.get("a")!.rawMuted = true;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    lockOnTwitch(handle);
    await env.cells.get("a")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1600);

    const twIframe = env.cells.get("b")!.$el.querySelector("iframe") as HTMLIFrameElement;
    const ytIframe = env.cells.get("a")!.$el.querySelector("iframe") as HTMLIFrameElement;
    focusIframeAndBlurWindow(twIframe);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    let blurCount = 0;
    let focusInCount = 0;
    const onBlur = () => {
      blurCount += 1;
    };
    const onFocusIn = () => {
      focusInCount += 1;
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focusin", onFocusIn);
    moveFocusToIframeWithoutBlur(ytIframe);
    expect(blurCount).toBe(0);
    expect(focusInCount).toBe(0);

    const muteCallsBefore = env.sdks.get("a")!.muteCalls;
    env.sdks.get("a")!.rawMuted = false;
    await pollSeconds(env, handle, 2);

    expect(handle.__getState().active?.key).toBe("a");
    expect(env.sdks.get("b")!.rawMuted).toBe(true);
    expect(env.sdks.get("a")!.rawMuted).toBe(false);
    expect(env.sdks.get("a")!.muteCalls).toBe(muteCallsBefore);
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(true);
    expect(blurCount).toBe(0);
    expect(focusInCount).toBe(0);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focusin", onFocusIn);
  });

  it("iframe_to_iframe_focus_reverse_switch_broken_twitch", async () => {
    const env = setupBrokenEnv();
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    env.sdks.get("a")!.rawMuted = true;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    lockOnTwitch(handle);
    await env.cells.get("a")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1600);

    const twIframe = env.cells.get("b")!.$el.querySelector("iframe") as HTMLIFrameElement;
    const ytIframe = env.cells.get("a")!.$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(twIframe, { muted: false });
    focusIframeAndBlurWindow(twIframe);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    let blurCount = 0;
    let focusInCount = 0;
    const onBlur = () => {
      blurCount += 1;
    };
    const onFocusIn = () => {
      focusInCount += 1;
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focusin", onFocusIn);
    moveFocusToIframeWithoutBlur(ytIframe);
    expect(blurCount).toBe(0);
    expect(focusInCount).toBe(0);

    const spy = env.postSpies.get("b")!;
    spy.mockClear();
    spy.mockImplementation((payload: { params?: boolean }) => {
      if (payload?.params === true) postTwitchUpdateState(twIframe, { muted: true });
    });
    const muteCallsBefore = env.sdks.get("a")!.muteCalls;
    env.sdks.get("a")!.rawMuted = false;
    await pollSeconds(env, handle, 2);

    expect(handle.__getState().active?.key).toBe("a");
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBeGreaterThanOrEqual(1);
    expect(env.sdks.get("a")!.rawMuted).toBe(false);
    expect(env.sdks.get("a")!.muteCalls).toBe(muteCallsBefore);
    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(env.store.state.multiview.layoutContent.b.muted).toBe(true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focusin", onFocusIn);
  });

  it("focused_iframe_poll_does_not_refresh_same_cell_intent", async () => {
    const env = setupBrokenEnv({
      healthyTwitch: true,
      twitchBroken: false,
      twitchMuted: false,
    });
    env.store.state.multiview.layoutContent.a.muted = true;
    env.store.state.multiview.layoutContent.b.muted = false;
    env.sdks.get("a")!.rawMuted = true;
    env.sdks.get("b")!.rawMuted = false;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    lockOnTwitch(handle);
    await env.cells.get("a")!.manualCheckMuted();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1600);

    const ytIframe = env.cells.get("a")!.$el.querySelector("iframe") as HTMLIFrameElement;
    moveFocusToIframeWithoutBlur(ytIframe);
    await pollSeconds(env, handle, 3);
    const muteCallsBefore = env.sdks.get("a")!.muteCalls;
    const twitchMutedBefore = env.sdks.get("b")!.rawMuted;
    env.sdks.get("a")!.rawMuted = false;
    await pollSeconds(env, handle, 2);

    expect(handle.__getState().active?.key).toBe("b");
    expect(
      env.sdks.get("a")!.muteCalls > muteCallsBefore || env.sdks.get("a")!.rawMuted === true,
    ).toBe(true);
    expect(env.sdks.get("b")!.rawMuted).toBe(twitchMutedBefore);
  });

  it("focused_iframe_poll_ignored_when_hidden_or_preexisting", async () => {
    const hidden = setupBrokenEnv({
      healthyTwitch: true,
      twitchBroken: false,
      twitchMuted: false,
    });
    hidden.sdks.get("a")!.rawMuted = true;
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    lockOnTwitch(handle);
    await hidden.cells.get("a")!.manualCheckMuted();
    await flushMicrotasks();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const hiddenYt = hidden.cells.get("a")!.$el.querySelector("iframe") as HTMLIFrameElement;
    moveFocusToIframeWithoutBlur(hiddenYt);
    hidden.sdks.get("a")!.rawMuted = false;
    await pollSeconds(hidden, handle, 2);
    expect(handle.__getState().active?.key).toBe("b");
    expect(hidden.sdks.get("a")!.rawMuted).toBe(true);
    handle.dispose();

    const preexisting = setupBrokenEnv({
      healthyTwitch: true,
      twitchBroken: false,
      twitchMuted: false,
    });
    preexisting.sdks.get("a")!.rawMuted = true;
    const preYt = preexisting.cells.get("a")!.$el.querySelector("iframe") as HTMLIFrameElement;
    moveFocusToIframeWithoutBlur(preYt);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    lockOnTwitch(handle);
    await preexisting.cells.get("a")!.manualCheckMuted();
    await flushMicrotasks();
    preexisting.sdks.get("a")!.rawMuted = false;
    await pollSeconds(preexisting, handle, 2);
    expect(handle.__getState().active?.key).toBe("b");
    expect(preexisting.sdks.get("a")!.rawMuted).toBe(true);
  });

  it("broken_twitch_without_ready_event_binds_via_iframe_channel", async () => {
    const env = setupBrokenEnv({ readyNever: true, twitchMuted: false });
    env.store.state.multiview.layoutContent.a.muted = false;
    delete env.store.state.multiview.layoutContent.b.muted;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    const twIframe = env.cells.get("b")!.$el.querySelector("iframe") as HTMLIFrameElement;
    postTwitchUpdateState(twIframe, { muted: false });
    await pollSeconds(env, handle, 3);
    const spy = env.postSpies.get("b")!;
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBeGreaterThanOrEqual(1);
    expect(handle.__getState().mode).not.toBe("degraded");
    const warned = warn.mock.calls.map((call) => JSON.stringify(call));
    expect(warned.some((text) => DEGRADED_CODES.some((code) => text.includes(code)))).toBe(false);
    expect(env.store.state.multiview.layoutContent.a.muted).not.toBe(true);
    warn.mockRestore();
  });

  it("twitch_placeholder_player_without_ready_is_not_bound", async () => {
    const env = setupBrokenEnv({ readyNever: true, twitchPlaceholder: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    handle = makeHandle();
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    await pollSeconds(env, handle, 3);
    const spy = env.postSpies.get("b")!;
    expect(spy.mock.calls.filter((c) => c[0]?.params === true).length).toBe(0);
    expect(handle.__getState().mode).not.toBe("degraded");
    expect(warn).toHaveBeenCalledTimes(0);
    warn.mockRestore();
  });
});
