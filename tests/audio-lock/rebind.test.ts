import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPanelDispatch,
  createAudioLockController,
  endPanelDispatch,
  type TestableHandle,
} from "../../src/pages/content/holodex/audio-lock/controller";
import { TIMING } from "../../src/pages/content/holodex/audio-lock/contracts";
import {
  createFakeMultiviewRoot,
  createFakePlayerComponent,
  createFakeStore,
  createFakeVideoCell,
  createPanelEvent,
  createTwitchSdk,
  createYoutubeSdk,
  fireReady,
  flushMicrotasks,
  replaceCellContent,
  type FakeEnv,
  type FakePlayerComponent,
  type FakeVideoCell,
} from "./fixtures";

describe("rebind", () => {
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

  async function lateBindEnv(): Promise<{
    store: ReturnType<typeof createFakeStore>;
    cellA: FakeVideoCell;
    cellB: FakeVideoCell;
    ytSdk: ReturnType<typeof createYoutubeSdk>;
    twSdk: ReturnType<typeof createTwitchSdk>;
    ytPlayer: FakePlayerComponent;
    twPlayer: FakePlayerComponent;
    multiview: ReturnType<typeof createFakeMultiviewRoot>["multiview"];
  }> {
    const store = createFakeStore({ muteOthers: true, cells: [] });
    const { multiview } = createFakeMultiviewRoot(store, []);
    window.history.pushState({}, "", "/multiview");
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);

    store.commit("multiview/setLayoutContent", {
      a: { id: "yt1", type: "video", video: "yt-a", muted: false },
      b: { id: "tw1", type: "video", video: "twitch/b", muted: true },
    });
    store.commit("multiview/setLayout", [{ i: "a" }, { i: "b" }]);
    await vi.advanceTimersByTimeAsync(0);

    const ytSdk = createYoutubeSdk({ muted: false });
    const twSdk = createTwitchSdk({ muted: true });
    const ytPlayer = createFakePlayerComponent("youtube", ytSdk);
    const twPlayer = createFakePlayerComponent("twitch", twSdk);
    const cellA = createFakeVideoCell({
      store,
      key: "a",
      provider: "youtube",
      player: ytPlayer,
      parentEl: multiview.$el,
      readyBeforeInstall: false,
    });
    const cellB = createFakeVideoCell({
      store,
      key: "b",
      provider: "twitch",
      player: twPlayer,
      parentEl: multiview.$el,
      readyBeforeInstall: false,
    });
    multiview.$children.push(cellA, cellB);
    (multiview.$refs.videoCell as FakeVideoCell[]).push(cellA, cellB);
    await vi.advanceTimersByTimeAsync(20);

    fireReady(ytPlayer);
    fireReady(twPlayer);
    await vi.advanceTimersByTimeAsync(3000);

    return { store, cellA, cellB, ytSdk, twSdk, ytPlayer, twPlayer, multiview };
  }

  it("late_bind_keeps_snapshot_selected_youtube_audible", async () => {
    const { store, ytSdk } = await lateBindEnv();
    expect(store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(store.state.multiview.layoutContent.b.muted).toBe(true);
    expect(handle.__getState().active).toEqual(
      handle.__lastBindings.get("a")!.identity,
    );
    expect(ytSdk.muteCalls).toBe(0);
  });

  it("same_content_remount_keeps_active", async () => {
    const env = setupEnv([
      { key: "a", provider: "youtube", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().active?.key).toBe("a");

    const cellA = env.cells.get("a")!;
    cellA.$el.remove();
    const ytSdk = createYoutubeSdk({ muted: false });
    const ytPlayer = createFakePlayerComponent("youtube", ytSdk);
    const neu = createFakeVideoCell({
      store: env.store,
      key: "a",
      provider: "youtube",
      player: ytPlayer,
      parentEl: env.multiview.$el,
      readyBeforeInstall: false,
    });
    const cellB = env.cells.get("b")!;
    env.multiview.$children = [neu, cellB];
    env.multiview.$refs.videoCell = [neu, cellB];
    env.cells.set("a", neu);
    env.sdks.set("a", ytSdk);

    await vi.advanceTimersByTimeAsync(20);
    fireReady(ytPlayer);
    await vi.advanceTimersByTimeAsync(3000);

    expect(env.store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(handle.__getState().selection).toBe("selected");
    expect(handle.__getState().active!.generation).toBe(
      handle.__lastBindings.get("a")!.identity.generation,
    );
  });

  it("active_content_change_still_enters_silence", async () => {
    const env = setupEnv([
      { key: "a", provider: "youtube", muted: false },
      { key: "b", provider: "twitch", muted: true },
    ]);
    handle = createAudioLockController({ window, document }) as TestableHandle;
    handle.setEnabled(true);
    handle.__tryDiscover();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.__getState().active?.key).toBe("a");

    replaceCellContent(env, "a", { provider: "youtube", contentId: "yt-other" });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    expect(handle.__getState().selection).toBe("silence");
    expect(handle.__getState().active).toBeNull();
  });

  it("late_bind_rebound_does_not_degrade", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await lateBindEnv();
    await vi.advanceTimersByTimeAsync(TIMING.STORE_SETTLE_MS + TIMING.HEARTBEAT_MS);
    expect(handle.__getState().mode).toBe("locked");
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).includes("[Holodex+ AudioLock]"),
      ),
    ).toBe(false);
    warn.mockRestore();
  });

  it("late_bind_then_twitch_first_play_cannot_steal", async () => {
    const { store, cellB } = await lateBindEnv();
    cellB.firstPlay = true;
    cellB.updatePausedState(false);
    cellB.setMuted(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.state.multiview.layoutContent.a.muted).toBe(false);
    expect(handle.__getState().active!.key).toBe("a");
  });

  it("late_bind_panel_unmute_twitch_switches", async () => {
    const { store, cellB } = await lateBindEnv();
    const ev = createPanelEvent(true);
    beginPanelDispatch(ev, true);
    await flushMicrotasks();
    cellB.setMuted(false);
    endPanelDispatch(ev);
    await vi.advanceTimersByTimeAsync(3000);
    expect(handle.__getState().active!.key).toBe("b");
    expect(store.state.multiview.layoutContent.a.muted).toBe(true);
    expect(store.state.multiview.layoutContent.b.muted).toBe(false);
  });
});
