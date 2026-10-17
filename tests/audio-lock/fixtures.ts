/**
 * Minimal fake Vue/store/player factories for audio-lock contract tests.
 * Does not read or copy Holodex source.
 */

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
  throwRead?: boolean;
  dangerousGetter?: boolean;
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
  sdk.getMuted = () => {
    if (opts?.throwRead) throw new Error("boom");
    if (opts?.hangRead) return new Promise(() => undefined);
    return sdk.rawMuted;
  };
  sdk.setMuted = (v: boolean) => {
    if (v) {
      sdk.muteCalls += 1;
      sdk.rawMuted = true;
    } else {
      sdk.unmuteCalls += 1;
      sdk.rawMuted = false;
    }
  };
  return sdk;
}

export function createYoutubeSdk(opts?: {
  muted?: boolean;
  hangRead?: boolean;
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
    sdk.rawMuted = true;
  };
  sdk.unMute = () => {
    sdk.unmuteCalls += 1;
    sdk.rawMuted = false;
  };
  return sdk;
}

export type FakePlayerComponent = {
  player: FakeSdk | null;
  twPlayer?: FakeSdk | null;
  ytPlayer?: FakeSdk | null;
  ready: boolean;
  listeners: Record<string, Array<() => void>>;
  $on: (event: string, cb: () => void) => void;
  $off: (event: string, cb: () => void) => void;
  isMuted: () => Promise<boolean>;
  setMute: (v: boolean) => Promise<void>;
  updateListeners: () => void;
  muteWatcherCalls: number;
  lastMuteProp: boolean;
};

export function createFakePlayerComponent(
  provider: "youtube" | "twitch",
  sdk: FakeSdk | null,
  ready = true,
): FakePlayerComponent {
  const comp: FakePlayerComponent = {
    player: sdk,
    ready,
    listeners: {},
    muteWatcherCalls: 0,
    lastMuteProp: false,
    $on(event, cb) {
      (comp.listeners[event] ??= []).push(cb);
    },
    $off(event, cb) {
      comp.listeners[event] = (comp.listeners[event] ?? []).filter((x) => x !== cb);
    },
    async isMuted() {
      if (!sdk) throw new Error("not ready");
      if (provider === "twitch") return !!(await sdk.getMuted?.());
      return !!(await sdk.isMuted?.());
    },
    async setMute(v: boolean) {
      if (!sdk) throw new Error("not ready");
      if (provider === "twitch") await sdk.setMuted?.(v);
      else if (v) await sdk.mute?.();
      else await sdk.unMute?.();
    },
    updateListeners() {
      // emits @mute via cell — tests wire separately
    },
  };
  if (provider === "twitch") comp.twPlayer = sdk;
  else comp.ytPlayer = sdk;
  return comp;
}

export function fireReady(comp: FakePlayerComponent): void {
  comp.ready = true;
  for (const cb of comp.listeners.ready ?? []) cb();
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
};

export function createFakeVideoCell(opts: {
  store: FakeStore;
  key: string;
  provider: "youtube" | "twitch";
  player?: FakePlayerComponent | null;
  name?: string;
  el?: HTMLElement;
}): FakeVideoCell {
  const content = opts.store.state.multiview.layoutContent[opts.key];
  if (!content) throw new Error(`missing content for ${opts.key}`);
  const el = opts.el ?? document.createElement("div");
  el.className = "mv-frame";
  if (!el.isConnected) document.body.appendChild(el);

  const cell: FakeVideoCell = {
    item: { i: opts.key },
    $store: opts.store,
    $el: el,
    $refs: { player: opts.player ?? undefined },
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
    muteOthersCalls: [],
    setMutedCalls: [],
    watcherCalls: 0,
    manualCheckMuted() {
      /* original no-op for tests; controller replaces */
    },
    setMuted(val: boolean) {
      cell.setMutedCalls.push(val);
      const prevProp = effectiveMuteProp(cell.muted);
      if (val === !!cell.muted && cell.muted !== undefined) {
        // VideoCell early return when val === !!this.muted
        // but undefined: !!undefined === false, so setMuted(false) returns early
        return;
      }
      if (cell.muted === undefined && val === false) {
        // U → false: early return without muteOthers (val === !!undefined === false)
        return;
      }
      if (cell.muted === false && val === false) {
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
      void prevProp;
    },
    muteOthers(id: string | number) {
      cell.muteOthersCalls.push(id);
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
        void cell.$refs.player.setMute(prop);
      }
    },
    lastMuteProp: false,
  } as FakeVideoCell & { applyMuteProp: (p: boolean) => void; lastMuteProp: boolean };

  // Fix muted getter early-return semantics to match VideoCell.vue:174
  cell.setMuted = function setMuted(val: boolean) {
    cell.setMutedCalls.push(val);
    // val === !!this.muted → early return (undefined → !!undefined = false)
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
        (cell as unknown as { applyMuteProp: (p: boolean) => void }).applyMuteProp(after);
      }
    }
  };

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

export function createFakeMultiviewRoot(
  store: FakeStore,
  cells: FakeVideoCell[],
): { root: FakeVueRoot; appEl: HTMLElement } {
  const appEl = document.createElement("div");
  appEl.id = "app";
  document.body.appendChild(appEl);

  const multiview: FakeVueRoot = {
    $root: null as unknown as FakeVueRoot,
    $store: store,
    $children: cells,
    $refs: { videoCell: cells, videoRefs: cells },
    $el: document.createElement("div"),
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
  return { root, appEl };
}

export function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

export function createPanelEvent(trusted: boolean): Event {
  // jsdom Event.isTrusted is non-configurable; use a plain stand-in for gate tests.
  let phase = Event.AT_TARGET;
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
