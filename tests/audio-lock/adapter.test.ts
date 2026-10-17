import { afterEach, describe, expect, it, vi } from "vitest";
import { createHolodexAdapter } from "../../src/pages/content/holodex/audio-lock/holodex-adapter";
import {
  createFakeMultiviewRoot,
  createFakePlayerComponent,
  createFakeStore,
  createFakeVideoCell,
  createTwitchSdk,
} from "./fixtures";

describe("createHolodexAdapter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("succeeds when component name is random but shape matches", () => {
    const store = createFakeStore({
      cells: [{ key: "1", provider: "twitch", muted: "omit" }],
    });
    const sdk = createTwitchSdk({ muted: true });
    const player = createFakePlayerComponent("twitch", sdk);
    const cell = createFakeVideoCell({
      store,
      key: "1",
      provider: "twitch",
      player,
      name: "TotallyNotVideoCell",
    });
    createFakeMultiviewRoot(store, [cell]);
    window.history.pushState({}, "", "/multiview");

    const reports: string[] = [];
    const adapter = createHolodexAdapter(window, document, (c) => reports.push(c));
    const result = adapter.discover();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].identity.key).toBe("1");
    }
    expect(reports).toEqual([]);
    adapter.dispose();
  });

  it("accepts undefined muted; rejects null muted", () => {
    const storeOk = createFakeStore({
      cells: [{ key: "1", provider: "youtube", muted: "omit" }],
    });
    const cellOk = createFakeVideoCell({
      store: storeOk,
      key: "1",
      provider: "youtube",
      player: createFakePlayerComponent("youtube", null, false),
    });
    createFakeMultiviewRoot(storeOk, [cellOk]);
    window.history.pushState({}, "", "/multiview");
    const adapter = createHolodexAdapter(window, document, () => undefined);
    expect(adapter.discover().ok).toBe(true);
    adapter.dispose();

    document.body.innerHTML = "";
    const storeBad = createFakeStore({
      cells: [{ key: "1", provider: "youtube", muted: false }],
    });
    storeBad.state.multiview.layoutContent["1"].muted = null as unknown as boolean;
    const cellBad = createFakeVideoCell({
      store: storeBad,
      key: "1",
      provider: "youtube",
    });
    // force null on cell muted via content
    createFakeMultiviewRoot(storeBad, [cellBad]);
    window.history.pushState({}, "", "/multiview");
    const reports: string[] = [];
    const adapter2 = createHolodexAdapter(window, document, (c) => reports.push(c));
    const result = adapter2.discover();
    expect(result.ok).toBe(false);
    adapter2.dispose();
  });

  it("fake VideoCell name with wrong shape does not patch", () => {
    const store = createFakeStore({ muteOthers: true, cells: [] });
    const { root, appEl } = createFakeMultiviewRoot(store, []);
    const fake = {
      $options: { name: "VideoCell" },
      $store: store,
      $children: [],
      $refs: {},
      $el: document.createElement("div"),
      item: { i: "x" },
      // missing methods
    };
    document.body.appendChild(fake.$el);
    (root.$children[0] as { $children: unknown[] }).$children.push(fake);
    (appEl as unknown as { __vue__: unknown }).__vue__ = root;
    window.history.pushState({}, "", "/multiview");

    const adapter = createHolodexAdapter(window, document, () => undefined);
    const result = adapter.discover();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bindings).toHaveLength(0);
    adapter.dispose();
  });

  it("stops without root after bounded discovery (fake timers)", () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    window.history.pushState({}, "", "/multiview");
    const reports: string[] = [];
    const adapter = createHolodexAdapter(window, document, (c) => reports.push(c));
    expect(adapter.discover().ok).toBe(false);
    adapter.dispose();
  });

  it("bounds cyclic children", () => {
    const store = createFakeStore({
      cells: [{ key: "1", provider: "twitch", muted: true }],
    });
    const cell = createFakeVideoCell({
      store,
      key: "1",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk()),
    });
    const { root } = createFakeMultiviewRoot(store, [cell]);
    // create cycle
    (cell as unknown as { $children: unknown[] }).$children = [root];
    root.$children.push(cell as unknown as typeof root);
    window.history.pushState({}, "", "/multiview");
    const adapter = createHolodexAdapter(window, document, () => undefined);
    const result = adapter.discover();
    expect(result.ok).toBe(true);
    adapter.dispose();
  });

  it("rolls back when a method is not writable", () => {
    const store = createFakeStore({
      cells: [{ key: "1", provider: "twitch", muted: true }],
    });
    const cell = createFakeVideoCell({
      store,
      key: "1",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk()),
    });
    createFakeMultiviewRoot(store, [cell]);
    window.history.pushState({}, "", "/multiview");
    Object.defineProperty(cell, "setMuted", {
      value: cell.setMuted,
      writable: false,
      configurable: false,
    });

    const reports: string[] = [];
    const adapter = createHolodexAdapter(window, document, (c) => reports.push(c));
    const found = adapter.discover();
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const origCheck = cell.manualCheckMuted;
    const disposePatch = adapter.patchCell(found.bindings[0], {
      manualCheckMuted() {
        return "wrapped";
      },
      setMuted() {
        return undefined;
      },
      muteOthers() {
        return undefined;
      },
      updatePausedState() {
        return undefined;
      },
    });
    expect(reports).toContain("patch-not-writable");
    expect(cell.manualCheckMuted).toBe(origCheck);
    disposePatch();
    adapter.dispose();
  });

  it("pending-port new cell does not uninstall existing wrappers", () => {
    const store = createFakeStore({
      cells: [
        { key: "a", provider: "youtube", muted: false },
        { key: "b", provider: "twitch", muted: "omit" },
      ],
    });
    const cellA = createFakeVideoCell({
      store,
      key: "a",
      provider: "youtube",
      player: createFakePlayerComponent("youtube", null, false),
    });
    const cellB = createFakeVideoCell({
      store,
      key: "b",
      provider: "twitch",
      player: null,
    });
    createFakeMultiviewRoot(store, [cellA, cellB]);
    window.history.pushState({}, "", "/multiview");
    const adapter = createHolodexAdapter(window, document, () => undefined);
    const found = adapter.discover();
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.bindings.some((b) => b.pendingPort)).toBe(true);

    const unpatchA = adapter.patchCell(found.bindings.find((b) => b.identity.key === "a")!, {
      manualCheckMuted() {
        return "A";
      },
      setMuted: cellA.setMuted,
      muteOthers: cellA.muteOthers,
      updatePausedState: cellA.updatePausedState,
    });
    expect(cellA.manualCheckMuted()).toBe("A");
    // discovering B pending does not clear A
    const found2 = adapter.discover();
    expect(found2.ok).toBe(true);
    expect(cellA.manualCheckMuted()).toBe("A");
    unpatchA();
    adapter.dispose();
  });

  it("does not patch outside multiview path", () => {
    const store = createFakeStore({
      cells: [{ key: "1", provider: "twitch", muted: true }],
    });
    const cell = createFakeVideoCell({
      store,
      key: "1",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk()),
    });
    createFakeMultiviewRoot(store, [cell]);
    window.history.pushState({}, "", "/");
    const adapter = createHolodexAdapter(window, document, () => undefined);
    expect(adapter.discover().ok).toBe(false);
    adapter.dispose();
  });

  it("watchSnapshot updates when muted key added", () => {
    const store = createFakeStore({
      cells: [{ key: "1", provider: "twitch", muted: "omit" }],
    });
    const cell = createFakeVideoCell({
      store,
      key: "1",
      provider: "twitch",
      player: createFakePlayerComponent("twitch", createTwitchSdk()),
    });
    createFakeMultiviewRoot(store, [cell]);
    window.history.pushState({}, "", "/multiview");
    const adapter = createHolodexAdapter(window, document, () => undefined);
    const snaps: unknown[] = [];
    const stop = adapter.watchSnapshot((s) => snaps.push(s));
    expect((snaps[0] as { cells: { assignment: unknown }[] }).cells[0].assignment).toBe(
      undefined,
    );
    store.commit("multiview/setLayoutContentWithKey", {
      id: "1",
      key: "muted",
      value: true,
    });
    expect(
      (snaps.at(-1) as { cells: { assignment: unknown }[] }).cells[0].assignment,
    ).toBe(true);
    stop();
    adapter.dispose();
  });
});
