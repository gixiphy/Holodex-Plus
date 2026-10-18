/**
 * Minimal fake Vue/store/player factories for audio-lock contract tests.
 * Does not read or copy Holodex source.
 *
 * Upstream shape (.ref/holodex @ 8c6d0da) — keep in sync:
 * - PlayerMixin.ts:27-35 — data() only player/retryForMengen/updateTimer (no ready boolean)
 * - PlayerMixin.ts:43-48 / :46 — READY via this.$emit("ready", player)
 * - TwitchPlayer.vue:40-43, :86 — player starts {}; SDK instance assigned before READY
 * - TwitchPlayer.vue:92-95 — SDK "ready" → playerReady(this.player); emit arg is component.player
 * - TwitchPlayer.vue:116-122 — isMuted→getMuted, setMute→setMuted
 * - YoutubePlayer.vue:53-67 — wrapper player assigned before READY
 * - YoutubePlayer.vue:69 — READY arg is e.target (raw YT.Player), not component.player
 * - YoutubePlayer.vue:104-107, :117-119 — setMute/mute/unMute, isMuted
 * - YoutubePlayer.vue:1-3 / TwitchPlayer.vue:1-3 — embed iframe inside component $el
 * - VideoCell.vue:11-25, :27-49 — ref="player", @ready="onReady"; YouTube :key rebuilds
 * - VideoCell.vue:79-80 — ytPlayer/twPlayer on VideoCell, not player component
 * - VideoCell.vue:210-216 — onReady assigns twPlayer/ytPlayer
 * - VideoCell.vue:134-139 — cellContent change nulls the other provider's ref only
 *
 * This file's player component must NOT have ready, twPlayer, or ytPlayer fields;
 * SDK refs live only on FakeVideoCell.
 */

import { vi } from "vitest";
import { installTwitchStateListener } from "../../src/pages/content/holodex/audio-lock/twitch-embed";

export type FakeContent = {
  id: string;
  type: "video" | "text";
  video?: string;
  muted?: boolean;
};

export type FakeLayoutItem = { i: string | number; x?: number; y?: number };

export type FakeStore = {
  state: {
    multiview: {
      muteOthers: boolean;
      layout: FakeLayoutItem[];
      layoutContent: Record<string, FakeContent>;
      editMode?: boolean;
    };
  };
  commit: (type: string, payload?: unknown) => void;
  watch: (
    getter: () => unknown,
    cb: () => void,
  ) => () => void;
  subscribe: (cb: (mutation: { type: string }) => void) => () => void;
  _watchers: Array<() => void>;
  _subscribers: Array<(mutation: { type: string }) => void>;
  _muteOthersTimer: ReturnType<typeof setTimeout> | null;
};

export function createFakeStore(opts?: {
  muteOthers?: boolean;
  cells?: Array<{
    key: string;
    provider: "youtube" | "twitch";
    contentId?: string;
    muted?: boolean | "omit";
  }>;
}): FakeStore {
  const layout: FakeLayoutItem[] = [];
  const layoutContent: Record<string, FakeContent> = {};
  for (const cell of opts?.cells ?? []) {
    layout.push({ i: cell.key });
    const content: FakeContent = {
      id: cell.contentId ?? `id-${cell.key}`,
      type: "video",
      video: cell.provider === "twitch" ? `twitch/${cell.key}` : `yt-${cell.key}`,
    };
    if (cell.muted !== "omit" && cell.muted !== undefined) {
      content.muted = cell.muted;
    }
    // omit muted field entirely when muted === "omit" or undefined with omit semantics
    if (cell.muted === "omit") {
      // leave muted undefined by not setting
    } else if (cell.muted !== undefined) {
      content.muted = cell.muted;
    }
    layoutContent[cell.key] = content;
  }

  const store: FakeStore = {
    state: {
      multiview: {
        muteOthers: opts?.muteOthers ?? true,
        layout,
        layoutContent,
        editMode: false,
      },
    },
    _watchers: [],
    _subscribers: [],
    _muteOthersTimer: null,
    commit(type: string, payload?: unknown) {
      if (type === "multiview/setLayoutContentWithKey") {
        const p = payload as { id: string; key: string; value: unknown };
        const content = store.state.multiview.layoutContent[p.id];
        if (content && p.key === "muted") {
          (content as FakeContent).muted = p.value as boolean;
        }
      }
      if (type === "multiview/setMuteOthers") {
        store.state.multiview.muteOthers = !!payload;
      }
      if (type === "multiview/setLayout") {
        store.state.multiview.layout = payload as FakeLayoutItem[];
      }
      if (type === "multiview/setLayoutContent") {
        store.state.multiview.layoutContent = payload as Record<string, FakeContent>;
      }
      if (type === "multiview/removeLayoutItem") {
        const key = String(payload);
        store.state.multiview.layout = store.state.multiview.layout.filter(
          (l) => String(l.i) !== key,
        );
        delete store.state.multiview.layoutContent[key];
      }
      if (type === "multiview/setLayoutContentById") {
        const p = payload as { id: string; content: FakeContent };
        store.state.multiview.layoutContent[p.id] = p.content;
        if (!store.state.multiview.layout.some((l) => String(l.i) === p.id)) {
          store.state.multiview.layout.push({ i: p.id });
        }
      }
      for (const sub of [...store._subscribers]) sub({ type });
      for (const w of [...store._watchers]) w();
    },
    watch(getter, cb) {
      const wrap = () => {
        getter();
        cb();
      };
      store._watchers.push(wrap);
      return () => {
        store._watchers = store._watchers.filter((w) => w !== wrap);
      };
    },
    subscribe(cb) {
      store._subscribers.push(cb);
      return () => {
        store._subscribers = store._subscribers.filter((s) => s !== cb);
      };
    },
  };
  return store;
}

/** Holodex Boolean mute prop: undefined → false */
export function effectiveMuteProp(assignment: boolean | undefined): boolean {
  return assignment === undefined ? false : assignment;
}

export type FakeSdk = {
  getMuted?: () => boolean | Promise<boolean>;
  setMuted?: (v: boolean) => void | Promise<void>;
  isMuted?: () => boolean | Promise<boolean>;
  mute?: () => void | Promise<void>;
  unMute?: () => void | Promise<void>;
  _embedWindow?: unknown;
  rawMuted: boolean;
  muteCalls: number;
  unmuteCalls: number;
};

export function createTwitchSdk(opts?: {
  muted?: boolean;
  hangRead?: boolean;
  hangUnmute?: boolean;
  throwRead?: boolean;
  dangerousGetter?: boolean;
  settleDelayMs?: number;
  ignoreMute?: boolean;
  brokenByVue?: boolean;
}): FakeSdk {
  const sdk: FakeSdk = {
    rawMuted: opts?.muted ?? true,
    muteCalls: 0,
    unmuteCalls: 0,
  };
  if (opts?.dangerousGetter) {
    Object.defineProperty(sdk, "_embedWindow", {
      get() {
        throw new Error("SecurityError: cross-origin");
      },
      configurable: true,
    });
  }
  if (opts?.brokenByVue) {
    Object.defineProperty(sdk, "__ob__", {
      value: {},
      enumerable: false,
      configurable: true,
    });
  }
  sdk.getMuted = () => {
    if (opts?.brokenByVue) return false;
    if (opts?.throwRead) throw new Error("boom");
    if (opts?.hangRead) return new Promise(() => undefined);
    return sdk.rawMuted;
  };
  sdk.setMuted = (v: boolean) => {
    if (v) {
      sdk.muteCalls += 1;
      if (opts?.brokenByVue) {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      }
      if (opts?.ignoreMute) return;
      if (opts?.settleDelayMs) {
        setTimeout(() => {
          sdk.rawMuted = true;
        }, opts.settleDelayMs);
        return;
      }
      sdk.rawMuted = true;
    } else {
      if (opts?.brokenByVue) {
        sdk.unmuteCalls += 1;
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      }
      if (opts?.hangUnmute) return new Promise(() => undefined) as unknown as void;
      sdk.unmuteCalls += 1;
      if (opts?.ignoreMute) return;
      if (opts?.settleDelayMs) {
        setTimeout(() => {
          sdk.rawMuted = false;
        }, opts.settleDelayMs);
        return;
      }
      sdk.rawMuted = false;
    }
  };
  return sdk;
}

/** Simulate a Twitch iframe UPDATE_STATE postMessage (test-only string constants). */
export function postTwitchUpdateState(
  iframe: HTMLIFrameElement,
  params: Record<string, unknown>,
): void {
  installTwitchStateListener(window, () => Date.now());
  const event = new MessageEvent("message", {
    origin: "https://player.twitch.tv",
    data: {
      namespace: "twitch-embed-player-proxy",
      eventName: "UPDATE_STATE",
      params,
    },
  });
  Object.defineProperty(event, "source", {
    value: iframe.contentWindow,
    configurable: true,
  });
  window.dispatchEvent(event);
}

export function createYoutubeSdk(opts?: {
  muted?: boolean;
  hangRead?: boolean;
  settleDelayMs?: number;
  ignoreMute?: boolean;
}): FakeSdk {
  const sdk: FakeSdk = {
    rawMuted: opts?.muted ?? true,
    muteCalls: 0,
    unmuteCalls: 0,
  };
  sdk.isMuted = () => {
    if (opts?.hangRead) return new Promise(() => undefined);
    return sdk.rawMuted;
  };
  sdk.mute = () => {
    sdk.muteCalls += 1;
    if (opts?.ignoreMute) return;
    if (opts?.settleDelayMs) {
      setTimeout(() => {
        sdk.rawMuted = true;
      }, opts.settleDelayMs);
      return;
    }
    sdk.rawMuted = true;
  };
  sdk.unMute = () => {
    sdk.unmuteCalls += 1;
    if (opts?.ignoreMute) return;
    if (opts?.settleDelayMs) {
      setTimeout(() => {
        sdk.rawMuted = false;
      }, opts.settleDelayMs);
      return;
    }
    sdk.rawMuted = false;
  };
  return sdk;
}

export type FakeYtRaw = {
  getIframe(): HTMLIFrameElement;
};

const youtubeRaws = new WeakMap<FakePlayerComponent, FakeYtRaw>();

export function youtubeRawFor(comp: FakePlayerComponent): FakeYtRaw | null {
  return youtubeRaws.get(comp) ?? null;
}

export type FakePlayerComponent = {
  player: FakeSdk | Record<string, never> | null;
  $el: HTMLElement;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  $on: (event: string, cb: (...args: unknown[]) => void) => void;
  $off: (event: string, cb: (...args: unknown[]) => void) => void;
  isMuted: () => Promise<boolean>;
  setMute: (v: boolean) => Promise<void>;
  updateListeners: () => void;
  muteWatcherCalls: number;
  lastMuteProp: boolean;
  /** test-only: which provider this component fakes */
  __provider: "youtube" | "twitch";
};

export function createFakePlayerComponent(
  provider: "youtube" | "twitch",
  sdk: FakeSdk | null,
  opts?: { sdkLoaded?: boolean; elementId?: string },
): FakePlayerComponent {
  const elementId = opts?.elementId ?? `player-${Math.random().toString(36).slice(2)}`;
  const $el = document.createElement("div");
  $el.id = elementId;
  const iframe = document.createElement("iframe");
  if (provider === "twitch") {
    iframe.src = `https://player.twitch.tv/?channel=${elementId}&parent=localhost`;
  } else {
    iframe.src = `https://www.youtube.com/embed/${elementId}`;
  }
  $el.appendChild(iframe);

  let player: FakeSdk | Record<string, never> | null;
  if (provider === "twitch") {
    // TwitchPlayer.vue:40-43 / :86 — {} until script loads; then SDK before READY
    player = opts?.sdkLoaded === false ? {} : sdk;
  } else {
    // YoutubePlayer.vue:53-67 — wrapper exists before READY
    player = sdk;
  }

  const comp: FakePlayerComponent = {
    player,
    $el,
    listeners: {},
    muteWatcherCalls: 0,
    lastMuteProp: false,
    __provider: provider,
    $on(event, cb) {
      (comp.listeners[event] ??= []).push(cb);
    },
    $off(event, cb) {
      comp.listeners[event] = (comp.listeners[event] ?? []).filter((x) => x !== cb);
    },
    async isMuted() {
      if (!sdk || typeof sdk !== "object" || !("rawMuted" in sdk)) {
        throw new Error("not ready");
      }
      if (provider === "twitch") return !!(await sdk.getMuted?.());
      return !!(await sdk.isMuted?.());
    },
    async setMute(v: boolean) {
      if (!sdk || typeof sdk !== "object" || !("rawMuted" in sdk)) {
        throw new Error("not ready");
      }
      if (provider === "twitch") await sdk.setMuted?.(v);
      else if (v) await sdk.mute?.();
      else await sdk.unMute?.();
    },
    updateListeners() {
      // emits @mute via cell — tests wire separately
    },
  };

  if (provider === "youtube") {
    const raw: FakeYtRaw = {
      getIframe() {
        return iframe;
      },
    };
    youtubeRaws.set(comp, raw);
  }

  return comp;
}

/** PlayerMixin.ts:46 — emit ready with Twitch=component.player / YouTube=raw e.target */
export function fireReady(comp: FakePlayerComponent): void {
  const arg =
    comp.__provider === "youtube" ? youtubeRawFor(comp) : comp.player;
  for (const cb of [...(comp.listeners.ready ?? [])]) {
    cb(arg);
  }
}

export type FakeVideoCell = {
  item: { i: string | number };
  $store: FakeStore;
  $el: HTMLElement;
  $refs: { player?: FakePlayerComponent };
  $options: { name: string };
  cellContent: FakeContent;
  muted: boolean | undefined;
  isTwitchVideo: boolean;
  firstPlay: boolean;
  editMode: boolean;
  /** VideoCell.vue:79-80 */
  twPlayer: unknown | null;
  ytPlayer: unknown | null;
  onReady: (player: unknown) => void;
  manualCheckMuted: (...args: unknown[]) => unknown;
  setMuted: (val: boolean) => void;
  muteOthers: (id: string | number) => void;
  updatePausedState: (paused?: boolean) => void;
  __orig?: {
    manualCheckMuted: FakeVideoCell["manualCheckMuted"];
    setMuted: FakeVideoCell["setMuted"];
    muteOthers: FakeVideoCell["muteOthers"];
    updatePausedState: FakeVideoCell["updatePausedState"];
  };
  muteOthersCalls: Array<string | number>;
  setMutedCalls: boolean[];
  watcherCalls: number;
  lastMuteProp: boolean;
  applyMuteProp: (prop: boolean) => void;
  nativeCheckCalls: number;
};

/** Wire player $on("ready") like VideoCell template @ready; optionally fire READY. */
export function mountPlayerOnCell(
  cell: FakeVideoCell,
  player: FakePlayerComponent,
  opts?: { readyBeforeInstall?: boolean },
): void {
  const prev = cell.$refs.player;
  if (prev?.$el && prev.$el !== player.$el && prev.$el.parentElement === cell.$el) {
    prev.$el.remove();
  }
  cell.$refs.player = player;
  if (player.$el.parentElement !== cell.$el) {
    cell.$el.appendChild(player.$el);
  }
  player.$on("ready", (p: unknown) => {
    cell.onReady(p);
  });
  if (opts?.readyBeforeInstall !== false) {
    fireReady(player);
  }
}

export function createFakeVideoCell(opts: {
  store: FakeStore;
  key: string;
  provider: "youtube" | "twitch";
  player?: FakePlayerComponent | null;
  name?: string;
  el?: HTMLElement;
  parentEl?: HTMLElement;
  readyBeforeInstall?: boolean;
  nativeCheckMuted?: boolean;
}): FakeVideoCell {
  const content = opts.store.state.multiview.layoutContent[opts.key];
  if (!content) throw new Error(`missing content for ${opts.key}`);
  const el = opts.el ?? document.createElement("div");
  el.className = "mv-frame";
  if (opts.parentEl) {
    if (!el.isConnected) opts.parentEl.appendChild(el);
  } else if (!el.isConnected) {
    document.body.appendChild(el);
  }

  const cell: FakeVideoCell = {
    item: { i: opts.key },
    $store: opts.store,
    $el: el,
    $refs: {},
    $options: { name: opts.name ?? `Cell_${Math.random().toString(36).slice(2)}` },
    cellContent: content,
    get muted() {
      return opts.store.state.multiview.layoutContent[opts.key]?.muted;
    },
    set muted(v: boolean | undefined) {
      const c = opts.store.state.multiview.layoutContent[opts.key];
      if (c) c.muted = v;
    },
    isTwitchVideo: opts.provider === "twitch",
    firstPlay: true,
    editMode: false,
    twPlayer: null,
    ytPlayer: null,
    onReady(player: unknown) {
      // VideoCell.vue:210-216
      if (player && cell.isTwitchVideo) {
        cell.twPlayer = player;
      } else if (player) {
        cell.ytPlayer = player;
      }
    },
    muteOthersCalls: [],
    setMutedCalls: [],
    watcherCalls: 0,
    nativeCheckCalls: 0,
    manualCheckMuted() {
      if (!opts.nativeCheckMuted) return;
      cell.nativeCheckCalls += 1;
      const player = cell.$refs.player;
      if (!player) return;
      return (async () => {
        let value: boolean;
        try {
          value = !!(await player.isMuted());
        } catch {
          return;
        }
        cell.setMuted(!!value);
      })();
    },
    setMuted(val: boolean) {
      cell.setMutedCalls.push(val);
      // VideoCell.vue:174 — val === !!this.muted early return (undefined → false)
      if (val === !!cell.muted) {
        return;
      }
      if (!val) {
        cell.muteOthers(cell.item.i);
      }
      const c = opts.store.state.multiview.layoutContent[opts.key];
      if (c) {
        const before = effectiveMuteProp(c.muted);
        c.muted = val;
        const after = effectiveMuteProp(c.muted);
        if (before !== after) {
          cell.watcherCalls += 1;
          cell.applyMuteProp(after);
        }
      }
    },
    muteOthers(id: string | number) {
      if (Array.isArray(cell.muteOthersCalls)) {
        cell.muteOthersCalls.push(id);
      }
      // trailing debounce 0
      if (opts.store._muteOthersTimer) clearTimeout(opts.store._muteOthersTimer);
      opts.store._muteOthersTimer = setTimeout(() => {
        opts.store._muteOthersTimer = null;
        for (const key of Object.keys(opts.store.state.multiview.layoutContent)) {
          const c = opts.store.state.multiview.layoutContent[key];
          if (c.type !== "video") continue;
          const before = effectiveMuteProp(c.muted);
          c.muted = String(key) !== String(id);
          const after = effectiveMuteProp(c.muted);
          if (before !== after) {
            // find cell watchers via store notify
          }
        }
        for (const sub of [...opts.store._subscribers]) {
          sub({ type: "multiview/muteOthers" });
        }
        for (const w of [...opts.store._watchers]) w();
      }, 0);
    },
    updatePausedState(paused = false) {
      if (cell.firstPlay === true && !paused && cell.editMode !== paused) {
        // native would call muteOthers — tests wrap to detect first-play
        if (!paused) {
          cell.muteOthers(cell.item.i);
        }
        cell.firstPlay = false;
      }
      cell.editMode = paused;
    },
    applyMuteProp(prop: boolean) {
      cell.lastMuteProp = prop;
      if (cell.$refs.player) {
        try {
          const result = cell.$refs.player.setMute(prop) as unknown;
          if (result && typeof (result as Promise<unknown>).then === "function") {
            void (result as Promise<unknown>).catch(() => undefined);
          }
        } catch {
          /* Vue watcher errorHandler swallows */
        }
      }
    },
    lastMuteProp: false,
  };

  if (opts.player) {
    mountPlayerOnCell(cell, opts.player, {
      readyBeforeInstall: opts.readyBeforeInstall,
    });
  }

  cell.__orig = {
    manualCheckMuted: cell.manualCheckMuted.bind(cell),
    setMuted: cell.setMuted.bind(cell),
    muteOthers: cell.muteOthers.bind(cell),
    updatePausedState: cell.updatePausedState.bind(cell),
  };

  return cell;
}

export type FakeVueRoot = {
  $root: FakeVueRoot;
  $store: FakeStore;
  $children: unknown[];
  $refs: Record<string, unknown>;
  $el: HTMLElement;
  $options: { name?: string };
  __vue__?: FakeVueRoot;
};

export type FakeEnv = {
  store: FakeStore;
  root: FakeVueRoot;
  appEl: HTMLElement;
  multiview: FakeVueRoot;
  cells: Map<string, FakeVideoCell>;
  sdks: Map<string, FakeSdk>;
};

export function createFakeMultiviewRoot(
  store: FakeStore,
  cells: FakeVideoCell[],
): { root: FakeVueRoot; appEl: HTMLElement; multiview: FakeVueRoot } {
  let appEl = document.getElementById("app") as HTMLElement | null;
  if (!appEl) {
    appEl = document.createElement("div");
    appEl.id = "app";
    document.body.appendChild(appEl);
  }

  const mvEl = document.createElement("div");
  mvEl.className = "multiview";
  appEl.appendChild(mvEl);

  for (const cell of cells) {
    if (cell.$el.parentElement !== mvEl) mvEl.appendChild(cell.$el);
  }

  const multiview: FakeVueRoot = {
    $root: null as unknown as FakeVueRoot,
    $store: store,
    $children: cells,
    $refs: { videoCell: cells, videoRefs: cells },
    $el: mvEl,
    $options: { name: "MultiView" },
  };
  multiview.$root = multiview;

  const root: FakeVueRoot = {
    $root: null as unknown as FakeVueRoot,
    $store: store,
    $children: [multiview],
    $refs: {},
    $el: appEl,
    $options: { name: "App" },
  };
  root.$root = root;
  (appEl as unknown as { __vue__: FakeVueRoot }).__vue__ = root;
  return { root, appEl, multiview };
}

export function addFakeCell(
  env: FakeEnv,
  opts: {
    key: string;
    provider: "youtube" | "twitch";
    muted?: boolean | "omit";
    readyBeforeInstall?: boolean;
    contentId?: string;
  },
): FakeVideoCell {
  const content: FakeContent = {
    id: opts.contentId ?? `id-${opts.key}`,
    type: "video",
    video: opts.provider === "twitch" ? `twitch/${opts.key}` : `yt-${opts.key}`,
  };
  if (opts.muted !== "omit" && opts.muted !== undefined) {
    content.muted = opts.muted;
  }
  env.store.state.multiview.layoutContent[opts.key] = content;
  if (!env.store.state.multiview.layout.some((l) => String(l.i) === opts.key)) {
    env.store.state.multiview.layout.push({ i: opts.key });
  }
  const sdk =
    opts.provider === "twitch"
      ? createTwitchSdk({ muted: opts.muted === true })
      : createYoutubeSdk({ muted: opts.muted === true });
  const player = createFakePlayerComponent(opts.provider, sdk);
  const cell = createFakeVideoCell({
    store: env.store,
    key: opts.key,
    provider: opts.provider,
    player,
    parentEl: env.multiview.$el,
    readyBeforeInstall: opts.readyBeforeInstall,
  });
  env.multiview.$children.push(cell);
  (env.multiview.$refs.videoCell as FakeVideoCell[]).push(cell);
  env.cells.set(opts.key, cell);
  env.sdks.set(opts.key, sdk);
  env.store.commit("multiview/setLayoutContentById", {
    id: opts.key,
    content,
  });
  return cell;
}

export function removeFakeCell(env: FakeEnv, key: string): void {
  const cell = env.cells.get(key);
  if (cell?.$el.parentElement) cell.$el.remove();
  env.multiview.$children = env.multiview.$children.filter(
    (c) => (c as FakeVideoCell).item?.i !== key && c !== cell,
  );
  const refs = env.multiview.$refs.videoCell as FakeVideoCell[];
  env.multiview.$refs.videoCell = refs.filter((c) => String(c.item.i) !== key);
  env.cells.delete(key);
  env.sdks.delete(key);
  env.store.commit("multiview/removeLayoutItem", key);
}

export function replaceCellContent(
  env: FakeEnv,
  key: string,
  opts: { provider: "youtube" | "twitch"; contentId: string },
): void {
  const cell = env.cells.get(key);
  if (!cell) throw new Error(`no cell ${key}`);
  const prevProvider = cell.isTwitchVideo ? "twitch" : "youtube";
  const sameProvider = prevProvider === opts.provider;
  const content: FakeContent = {
    id: opts.contentId,
    type: "video",
    video:
      opts.provider === "twitch" ? `twitch/${opts.contentId}` : `yt-${opts.contentId}`,
    muted: env.store.state.multiview.layoutContent[key]?.muted,
  };
  env.store.state.multiview.layoutContent[key] = content;
  cell.cellContent = content;
  cell.isTwitchVideo = opts.provider === "twitch";
  // VideoCell.vue:134-139 — only null the *other* provider's ref
  if (!sameProvider) {
    if (opts.provider === "youtube") cell.twPlayer = null;
    else cell.ytPlayer = null;
  }
  const sdk =
    opts.provider === "twitch"
      ? createTwitchSdk({ muted: false })
      : createYoutubeSdk({ muted: false });
  const player = createFakePlayerComponent(opts.provider, sdk, {
    elementId: opts.contentId,
  });
  // YouTube same-provider (:key rebuild): new component, leave stale ytPlayer, no READY yet
  const readyBeforeInstall = !(sameProvider && opts.provider === "youtube");
  mountPlayerOnCell(cell, player, { readyBeforeInstall });
  env.sdks.set(key, sdk);
  env.store.commit("multiview/setLayoutContentById", { id: key, content });
}

export function replacePlayer(env: FakeEnv, key: string): FakePlayerComponent {
  const cell = env.cells.get(key);
  if (!cell) throw new Error(`no cell ${key}`);
  const provider = cell.isTwitchVideo ? "twitch" : "youtube";
  const sdk =
    provider === "twitch"
      ? createTwitchSdk({ muted: cell.$refs.player ? false : true })
      : createYoutubeSdk({ muted: false });
  const player = createFakePlayerComponent(provider, sdk);
  // New component; do not clear cell.twPlayer/ytPlayer before READY (onReady updates them)
  mountPlayerOnCell(cell, player, { readyBeforeInstall: true });
  env.sdks.set(key, sdk);
  return player;
}

export function applyPreset(
  env: FakeEnv,
  cells: Array<{
    key: string;
    provider: "youtube" | "twitch";
    muted?: boolean | "omit";
    contentId?: string;
  }>,
  opts: { merge: boolean },
): void {
  void opts;
  const layout: FakeLayoutItem[] = cells.map((c) => ({ i: c.key }));
  const layoutContent: Record<string, FakeContent> = {};
  for (const c of cells) {
    layoutContent[c.key] = {
      id: c.contentId ?? `id-${c.key}`,
      type: "video",
      video: c.provider === "twitch" ? `twitch/${c.key}` : `yt-${c.key}`,
      ...(c.muted !== "omit" && c.muted !== undefined ? { muted: c.muted } : {}),
    };
  }
  env.store.commit("multiview/setLayoutContent", layoutContent);
  env.store.commit("multiview/setLayout", layout);
}

export function countSessionResources(store: FakeStore): {
  watchers: number;
  subscribers: number;
  timers: number;
} {
  return {
    watchers: store._watchers.length,
    subscribers: store._subscribers.length,
    timers: typeof vi !== "undefined" ? vi.getTimerCount() : 0,
  };
}

export function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

export function createPanelEvent(trusted: boolean): Event {
  // jsdom Event.isTrusted is non-configurable; use a plain stand-in for gate tests.
  let phase: number = Event.AT_TARGET;
  const event = {
    type: "click",
    bubbles: true,
    cancelable: true,
    get isTrusted() {
      return trusted;
    },
    get eventPhase() {
      return phase;
    },
    set eventPhase(v: number) {
      phase = v;
    },
  };
  return event as unknown as Event;
}

/**
 * Simulate a cross-origin iframe click: activeElement becomes the iframe and
 * the top-level window receives blur. Prefer iframe.focus(); if jsdom does not
 * stick focus (or it would fire focusin), spy document.activeElement instead.
 */
export function focusIframeAndBlurWindow(iframe: HTMLIFrameElement): void {
  // Always spy: jsdom focus on iframe is unreliable and may dispatch focusin.
  vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe);
  window.dispatchEvent(new Event("blur"));
}

/** Focus is already inside a child frame; the next click only moves activeElement. */
export function moveFocusToIframeWithoutBlur(iframe: HTMLIFrameElement): void {
  vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe);
}

/**
 * Simulate clicking a non-focusable blank region: activeElement returns to body
 * and only window focus fires (no focusin). Avoid element.focus()/blur() because
 * jsdom may dispatch focusin for those; only spy activeElement + window focus.
 */
export function returnFocusToPageWithoutFocusIn(): void {
  vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
  window.dispatchEvent(new Event("focus"));
}
