import type {
  CellIdentity,
  MutedAssignment,
  Provider,
  StoreSnapshot,
} from "./contracts";
import { TIMING } from "./contracts";

export type ReportFn = (code: string) => void;

export type CellHandlers = {
  manualCheckMuted: (this: unknown) => unknown;
  setMuted: (this: unknown, value: boolean) => unknown;
  muteOthers: (this: unknown, id: string | number) => unknown;
  updatePausedState: (this: unknown, paused?: boolean) => unknown;
};

export type CellBinding = {
  identity: CellIdentity;
  cell: unknown;
  playerComponent: unknown | null;
  pendingPort: boolean;
  provider: Provider;
};

type VueLike = {
  $root?: VueLike;
  $store?: unknown;
  $children?: VueLike[];
  $refs?: Record<string, unknown>;
  $el?: Element;
  $options?: { name?: string };
  __vue__?: VueLike;
};

type StoreLike = {
  commit: (type: string, payload?: unknown) => void;
  watch: (getter: () => unknown, cb: () => void) => () => void;
  subscribe: (cb: (mutation: { type: string }) => void) => () => void;
  state: {
    multiview: {
      muteOthers: boolean;
      layout: Array<{ i: string | number }>;
      layoutContent: Record<
        string,
        { id?: string; type?: string; video?: string; muted?: unknown }
      >;
    };
  };
};

type RegistryEntry = {
  contentId: string;
  provider: Provider;
  cell: object;
  player: object | null;
  generation: number;
};

function isFunction(v: unknown): v is (...args: never[]) => unknown {
  return typeof v === "function";
}

function isTopFrame(win: Window): boolean {
  try {
    return win.top === win;
  } catch {
    return false;
  }
}

function isMultiviewPath(pathname: string): boolean {
  return /^\/multiview(?:\/|$)/.test(pathname);
}

function providerFromContent(content: {
  video?: string;
  id?: string;
}): Provider | null {
  const video = content.video ?? "";
  if (typeof video === "string" && video.includes("twitch")) return "twitch";
  if (content.id || video) return "youtube";
  return null;
}

function hostnameAllowed(iframe: HTMLIFrameElement, provider: Provider): boolean {
  try {
    const url = new URL(iframe.src);
    if (provider === "twitch") return url.hostname === "player.twitch.tv";
    return (
      url.hostname === "www.youtube.com" ||
      url.hostname === "www.youtube-nocookie.com"
    );
  } catch {
    return false;
  }
}

function mutedAssignment(value: unknown): MutedAssignment | "invalid" {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  return "invalid";
}

export type DiscoverOk = {
  ok: true;
  bindings: CellBinding[];
  store: StoreLike;
  root: VueLike;
  observeTarget: Element;
};

export type HolodexAdapter = {
  discover(): DiscoverOk | { ok: false; code: string };
  patchCell(binding: CellBinding, handlers: CellHandlers): () => void;
  watchSnapshot(
    store: StoreLike,
    onSnapshot: (snapshot: StoreSnapshot) => void,
    onMutation: (type: string) => void,
  ): () => void;
  buildSnapshot(): StoreSnapshot;
  observe(target: Element, onChange: () => void): () => void;
  setStoreMuted(identity: CellIdentity, value: true): void;
  getMuteOthers(): boolean;
  dispose(): void;
};

export function createHolodexAdapter(
  win: Window,
  doc: Document,
  report: ReportFn,
): HolodexAdapter {
  let disposed = false;
  const reported = new Set<string>();
  const warn = (code: string) => {
    if (reported.has(code)) return;
    reported.add(code);
    report(code);
    try {
      console.warn("[Holodex+ AudioLock]", { code, adapterVersion: 1 });
    } catch {
      /* ignore */
    }
  };

  let generationCounter = 1;
  const registry = new Map<string, RegistryEntry>();
  let cachedStore: StoreLike | null = null;
  const installed = new Map<
    string,
    {
      cell: Record<string, unknown>;
      originals: Record<string, unknown>;
    }
  >();

  const identityFor = (
    key: string,
    cell: object,
    content: { id?: string; video?: string },
    player: object | null,
    provider: Provider,
  ): CellIdentity => {
    const contentId = String(content.id ?? content.video ?? key);
    const prev = registry.get(key);
    if (!prev) {
      const generation = generationCounter++;
      registry.set(key, {
        contentId,
        provider,
        cell,
        player,
        generation,
      });
      return { key, contentId, provider, generation };
    }

    const playerChanged =
      prev.player !== null && player !== null && prev.player !== player;
    const bumped =
      prev.contentId !== contentId ||
      prev.provider !== provider ||
      prev.cell !== cell ||
      playerChanged;

    if (bumped) {
      const generation = generationCounter++;
      registry.set(key, {
        contentId,
        provider,
        cell,
        player,
        generation,
      });
      return { key, contentId, provider, generation };
    }

    // null → object does not bump; update player ref
    if (prev.player === null && player !== null) {
      registry.set(key, { ...prev, player });
    }
    return {
      key,
      contentId: prev.contentId,
      provider: prev.provider,
      generation: prev.generation,
    };
  };

  const findVueRoots = (): VueLike[] => {
    const candidates: Element[] = [];
    const app = doc.querySelector("#app");
    const dataApp = doc.querySelector("[data-app]");
    const mv = doc.querySelector(".multiview");
    if (app) candidates.push(app);
    if (dataApp) candidates.push(dataApp);
    if (mv) {
      let el: Element | null = mv;
      while (el) {
        candidates.push(el);
        el = el.parentElement;
      }
    }
    const roots: VueLike[] = [];
    for (const el of candidates) {
      const vm = (el as unknown as { __vue__?: VueLike }).__vue__;
      if (vm?.$root) roots.push(vm.$root);
    }
    if (roots.length) return roots;

    let scanned = 0;
    const all = doc.querySelectorAll("*");
    for (const el of all) {
      if (scanned >= TIMING.MAX_DOM_SCAN) break;
      scanned += 1;
      const vm = (el as unknown as { __vue__?: VueLike }).__vue__;
      if (vm?.$root) {
        roots.push(vm.$root);
        break;
      }
    }
    return roots;
  };

  const validateStore = (store: unknown): store is StoreLike => {
    if (!store || typeof store !== "object") return false;
    const s = store as StoreLike;
    if (!isFunction(s.commit) || !isFunction(s.watch) || !isFunction(s.subscribe)) {
      return false;
    }
    const mv = s.state?.multiview;
    if (!mv || typeof mv.muteOthers !== "boolean") return false;
    if (!Array.isArray(mv.layout) || typeof mv.layoutContent !== "object" || !mv.layoutContent) {
      return false;
    }
    return true;
  };

  const walkChildren = (
    root: VueLike,
    visit: (vm: VueLike) => void,
  ): { ok: true } | { ok: false; code: string } => {
    const seen = new WeakSet<object>();
    const stack: VueLike[] = [root];
    let count = 0;
    try {
      while (stack.length) {
        const vm = stack.pop()!;
        if (seen.has(vm as object)) continue;
        seen.add(vm as object);
        count += 1;
        if (count > TIMING.MAX_INSTANCE_SCAN) {
          return { ok: false, code: "cell-contract-changed" };
        }
        visit(vm);
        const children = vm.$children;
        if (Array.isArray(children)) {
          for (const child of children) stack.push(child);
        }
      }
      return { ok: true };
    } catch {
      return { ok: false, code: "cell-contract-changed" };
    }
  };

  const isVideoCell = (
    vm: VueLike,
    store: StoreLike,
  ): { ok: true; identity: CellIdentity; provider: Provider } | { ok: false } => {
    const cell = vm as unknown as Record<string, unknown>;
    const item = cell.item as { i?: unknown } | undefined;
    if (!item || (typeof item.i !== "string" && typeof item.i !== "number")) {
      return { ok: false };
    }
    if (cell.$store !== store) return { ok: false };
    const key = String(item.i);
    const layoutItem = store.state.multiview.layout.find((l) => String(l.i) === key);
    const content = store.state.multiview.layoutContent[key];
    if (!layoutItem || !content || content.type !== "video") return { ok: false };
    if (cell.cellContent !== content) return { ok: false };
    if (!(cell.$el instanceof Element) || !cell.$el.isConnected) return { ok: false };
    for (const m of [
      "manualCheckMuted",
      "setMuted",
      "muteOthers",
      "updatePausedState",
    ]) {
      if (!isFunction(cell[m])) return { ok: false };
    }
    const muted = mutedAssignment(cell.muted);
    if (muted === "invalid") return { ok: false };
    if (typeof cell.isTwitchVideo !== "boolean") return { ok: false };

    const provider =
      cell.isTwitchVideo === true
        ? "twitch"
        : providerFromContent(content) ?? "youtube";

    const playerRaw = (cell.$refs as { player?: unknown } | undefined)?.player;
    const player =
      playerRaw && typeof playerRaw === "object" ? (playerRaw as object) : null;
    if (player) {
      const p = player as Record<string, unknown>;
      if (!isFunction(p.isMuted) || !isFunction(p.setMute)) return { ok: false };
      const iframe = (cell.$el as Element).querySelector?.("iframe") as
        | HTMLIFrameElement
        | null;
      if (iframe?.src && !hostnameAllowed(iframe, provider)) {
        return { ok: false };
      }
    }

    const identity = identityFor(key, vm as object, content, player, provider);
    return { ok: true, provider: identity.provider, identity };
  };

  const buildSnapshotFromStore = (store: StoreLike): StoreSnapshot => {
    const cells = [];
    for (const item of store.state.multiview.layout) {
      const key = String(item.i);
      const content = store.state.multiview.layoutContent[key];
      if (!content || content.type !== "video") continue;
      const muted = mutedAssignment(content.muted);
      if (muted === "invalid") continue;
      const contentId = String(content.id ?? content.video ?? key);
      const reg = registry.get(key);
      let provider: Provider;
      let generation: number;
      if (reg && reg.contentId === contentId) {
        provider = reg.provider;
        generation = reg.generation;
      } else {
        provider = providerFromContent(content) ?? "youtube";
        generation = reg?.generation ?? 1;
      }
      cells.push({
        identity: { key, contentId, provider, generation },
        assignment: muted,
      });
    }
    return {
      muteOthers: store.state.multiview.muteOthers,
      cells,
    };
  };

  const discover = (): DiscoverOk | { ok: false; code: string } => {
    if (disposed) return { ok: false as const, code: "root-timeout" };
    if (!isTopFrame(win)) return { ok: false as const, code: "root-timeout" };
    if (!isMultiviewPath(win.location.pathname)) {
      return { ok: false as const, code: "root-timeout" };
    }

    const roots = findVueRoots();
    if (!roots.length) return { ok: false as const, code: "root-timeout" };

    for (const root of roots) {
      if (!validateStore(root.$store)) continue;
      const store = root.$store as StoreLike;

      let multiview: VueLike | null = null;
      const walk = walkChildren(root, (vm) => {
        if (vm.$refs?.videoCell || vm.$refs?.videoRefs) {
          multiview = vm;
        }
      });
      if (!walk.ok) {
        warn(walk.code);
        return { ok: false as const, code: walk.code };
      }

      const searchRoot = multiview ?? root;
      const bindings: CellBinding[] = [];
      let contractFailed = false;
      let failCode = "cell-contract-changed";

      const cellWalk = walkChildren(searchRoot, (vm) => {
        if (contractFailed) return;
        const cell = vm as unknown as Record<string, unknown>;
        const looksLike =
          isFunction(cell.manualCheckMuted) &&
          isFunction(cell.setMuted) &&
          cell.item &&
          typeof (cell.item as { i?: unknown }).i !== "undefined";
        if (!looksLike) return;

        const checked = isVideoCell(vm, store);
        if (!checked.ok) {
          if (
            isFunction(cell.manualCheckMuted) &&
            cell.item &&
            store.state.multiview.layoutContent[
              String((cell.item as { i: string | number }).i)
            ]?.type === "video"
          ) {
            contractFailed = true;
            failCode = "cell-contract-changed";
          }
          return;
        }

        const player = (cell.$refs as { player?: unknown } | undefined)?.player ?? null;
        bindings.push({
          identity: checked.identity,
          cell: vm,
          playerComponent: player,
          pendingPort: !player,
          provider: checked.provider,
        });
      });

      if (!cellWalk.ok) {
        warn(cellWalk.code);
        return { ok: false as const, code: cellWalk.code };
      }
      if (contractFailed) {
        warn(failCode);
        return { ok: false as const, code: failCode };
      }

      const mvEl = (multiview as VueLike | null)?.$el;
      const observeTarget =
        mvEl instanceof Element
          ? mvEl
          : root.$el instanceof Element
            ? root.$el
            : doc.documentElement;

      cachedStore = store;
      return {
        ok: true as const,
        bindings,
        store,
        root,
        observeTarget,
      };
    }

    warn("store-shape-changed");
    return { ok: false as const, code: "store-shape-changed" };
  };

  const patchCell = (binding: CellBinding, handlers: CellHandlers): (() => void) => {
    const cell = binding.cell as Record<string, unknown>;
    const key = binding.identity.key;
    const methods = [
      "manualCheckMuted",
      "setMuted",
      "muteOthers",
      "updatePausedState",
    ] as const;
    const originals: Record<string, unknown> = {};
    const installedKeys: string[] = [];

    try {
      for (const name of methods) {
        const desc = Object.getOwnPropertyDescriptor(cell, name);
        if (desc && desc.writable === false && !desc.set) {
          throw new Error("patch-not-writable");
        }
        originals[name] = cell[name];
      }
      cell.manualCheckMuted = handlers.manualCheckMuted;
      cell.setMuted = handlers.setMuted;
      cell.muteOthers = handlers.muteOthers;
      cell.updatePausedState = handlers.updatePausedState;
      for (const name of methods) installedKeys.push(name);
      installed.set(key, { cell, originals });
    } catch {
      for (const name of installedKeys) {
        cell[name] = originals[name];
      }
      warn("patch-not-writable");
      return () => undefined;
    }

    return () => {
      const entry = installed.get(key);
      if (!entry) return;
      for (const name of methods) {
        if (entry.cell[name] === handlers[name]) {
          entry.cell[name] = entry.originals[name];
        }
      }
      installed.delete(key);
    };
  };

  const buildSnapshot = (): StoreSnapshot => {
    if (!cachedStore) {
      return { muteOthers: false, cells: [] };
    }
    return buildSnapshotFromStore(cachedStore);
  };

  const watchSnapshot = (
    store: StoreLike,
    onSnapshot: (snapshot: StoreSnapshot) => void,
    onMutation: (type: string) => void,
  ): (() => void) => {
    cachedStore = store;
    const unwatch = store.watch(
      () => {
        const parts = [String(store.state.multiview.muteOthers)];
        for (const item of store.state.multiview.layout) {
          const key = String(item.i);
          const c = store.state.multiview.layoutContent[key];
          if (!c || c.type !== "video") continue;
          const m = mutedAssignment(c.muted);
          const contentId = String(c.id ?? c.video ?? key);
          const reg = registry.get(key);
          const provider =
            reg && reg.contentId === contentId
              ? reg.provider
              : providerFromContent(c) ?? "youtube";
          const generation = reg?.generation ?? 1;
          parts.push(
            `${key}:${contentId}:${provider}:${generation}:${m === undefined ? "U" : m === true ? "M" : "A"}`,
          );
        }
        return parts.join("|");
      },
      () => {
        onSnapshot(buildSnapshotFromStore(store));
      },
    );

    const unsub = store.subscribe((mutation) => {
      onMutation(mutation.type);
    });

    onSnapshot(buildSnapshotFromStore(store));
    return () => {
      unwatch();
      unsub();
    };
  };

  const observe = (target: Element, onChange: () => void): (() => void) => {
    const MO = (win as unknown as { MutationObserver?: typeof MutationObserver })
      .MutationObserver;
    if (typeof MO !== "function") {
      return () => undefined;
    }
    let observer: MutationObserver | null = new MO(() => onChange());
    try {
      observer.observe(target, { childList: true, subtree: true });
    } catch {
      observer = null;
      return () => undefined;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        observer?.disconnect();
      } catch {
        /* ignore */
      }
      observer = null;
    };
  };

  return {
    discover,
    patchCell,
    watchSnapshot,
    buildSnapshot,
    observe,
    setStoreMuted(identity, value) {
      if (!cachedStore) return;
      try {
        cachedStore.commit("multiview/setLayoutContentWithKey", {
          id: identity.key,
          key: "muted",
          value,
        });
      } catch {
        warn("store-shape-changed");
      }
    },
    getMuteOthers() {
      if (!cachedStore) return false;
      return cachedStore.state.multiview.muteOthers;
    },
    dispose() {
      disposed = true;
      installed.clear();
      registry.clear();
      cachedStore = null;
    },
  };
}
