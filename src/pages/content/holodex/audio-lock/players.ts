import type {
  CellIdentity,
  PlayerPort,
  ReadMuted,
  SelectionGrant,
} from "./contracts";
import { TIMING } from "./contracts";

export type PlayerBinding = {
  identity: CellIdentity;
  /** Verified player component with optional ready hooks and SDK instance. */
  playerComponent: {
    player?: unknown;
    $on?: (event: string, cb: () => void) => void;
    $off?: (event: string, cb: () => void) => void;
    twPlayer?: unknown;
    ytPlayer?: unknown;
  };
  provider: "youtube" | "twitch";
  isReady: () => boolean;
};

type BoundMethods = {
  read: () => unknown;
  mute: () => unknown;
  unmute: () => unknown;
};

const portsByCell = new WeakMap<object, PlayerPort>();

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "access-error" }
> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: "timeout" });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: "access-error" });
      },
    );
  });
}

async function callMaybePromise(fn: () => unknown): Promise<unknown> {
  const result = fn();
  if (result && typeof (result as Promise<unknown>).then === "function") {
    return await (result as Promise<unknown>);
  }
  return result;
}

function bindTwitch(instance: object): BoundMethods | null {
  const rec = instance as Record<string, unknown>;
  const getMuted = rec.getMuted;
  const setMuted = rec.setMuted;
  if (typeof getMuted !== "function" || typeof setMuted !== "function") {
    return null;
  }
  return {
    read: () => (getMuted as (this: object) => unknown).call(instance),
    mute: () => (setMuted as (this: object, v: boolean) => unknown).call(instance, true),
    unmute: () =>
      (setMuted as (this: object, v: boolean) => unknown).call(instance, false),
  };
}

function bindYoutube(instance: object): BoundMethods | null {
  const rec = instance as Record<string, unknown>;
  const isMuted = rec.isMuted;
  const mute = rec.mute;
  const unMute = rec.unMute;
  if (
    typeof isMuted !== "function" ||
    typeof mute !== "function" ||
    typeof unMute !== "function"
  ) {
    return null;
  }
  return {
    read: () => (isMuted as (this: object) => unknown).call(instance),
    mute: () => (mute as (this: object) => unknown).call(instance),
    unmute: () => (unMute as (this: object) => unknown).call(instance),
  };
}

function interpretMuted(value: unknown): ReadMuted {
  if (typeof value !== "boolean") {
    return { kind: "unavailable", reason: "access-error" };
  }
  return { kind: "known", muted: value };
}

export function createPlayerPort(binding: PlayerBinding): PlayerPort | null {
  const cellKey = binding.playerComponent;
  const existing = portsByCell.get(cellKey as object);
  if (existing) return existing;

  let disposed = false;
  let methods: BoundMethods | null = null;
  let boundInstance: object | null = null;
  let readyListener: (() => void) | null = null;
  const usedGrants = new Set<string>();

  const tryBind = (): boolean => {
    if (disposed) return false;
    if (methods) return true;
    if (!binding.isReady()) return false;
    const instance = binding.playerComponent.player;
    if (!instance || typeof instance !== "object") return false;

    if (binding.provider === "twitch") {
      const tw = binding.playerComponent.twPlayer;
      if (tw !== undefined && tw !== instance) return false;
      methods = bindTwitch(instance as object);
    } else {
      const yt = binding.playerComponent.ytPlayer;
      if (yt === undefined && !binding.playerComponent.player) return false;
      methods = bindYoutube(instance as object);
    }
    if (!methods) return false;
    boundInstance = instance as object;
    return true;
  };

  // Late-bind: if already ready, bind now; else wait for Vue ready once.
  if (binding.isReady()) {
    tryBind();
  } else if (typeof binding.playerComponent.$on === "function") {
    readyListener = () => {
      tryBind();
    };
    try {
      binding.playerComponent.$on!("ready", readyListener);
    } catch {
      readyListener = null;
    }
  }

  const port: PlayerPort = {
    async readMuted(): Promise<ReadMuted> {
      if (disposed) return { kind: "unavailable", reason: "access-error" };
      if (!tryBind() || !methods) {
        return { kind: "unavailable", reason: "not-ready" };
      }
      try {
        const raced = await withTimeout(
          callMaybePromise(() => methods!.read()),
          TIMING.READ_TIMEOUT_MS,
        );
        if (!raced.ok) {
          return {
            kind: "unavailable",
            reason: raced.reason === "timeout" ? "timeout" : "access-error",
          };
        }
        return interpretMuted(raced.value);
      } catch {
        return { kind: "unavailable", reason: "access-error" };
      }
    },

    async mute(): Promise<boolean> {
      if (disposed) return false;
      if (!tryBind() || !methods) return false;
      try {
        const raced = await withTimeout(
          callMaybePromise(() => methods!.mute()),
          TIMING.READ_TIMEOUT_MS,
        );
        return raced.ok;
      } catch {
        return false;
      }
    },

    async restoreSelectedAudio(grant: SelectionGrant): Promise<boolean> {
      if (disposed) return false;
      const grantKey = `${grant.identity.key}:${grant.epoch}:${grant.source}`;
      if (usedGrants.has(grantKey)) return false;
      if (
        grant.identity.key !== binding.identity.key ||
        grant.identity.generation !== binding.identity.generation ||
        grant.identity.provider !== binding.identity.provider ||
        grant.identity.contentId !== binding.identity.contentId
      ) {
        return false;
      }
      if (!tryBind() || !methods) return false;
      usedGrants.add(grantKey);
      try {
        const raced = await withTimeout(
          callMaybePromise(() => methods!.unmute()),
          TIMING.READ_TIMEOUT_MS,
        );
        return raced.ok;
      } catch {
        return false;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (readyListener && typeof binding.playerComponent.$off === "function") {
        try {
          binding.playerComponent.$off!("ready", readyListener);
        } catch {
          /* ignore */
        }
      }
      readyListener = null;
      methods = null;
      boundInstance = null;
      usedGrants.clear();
      portsByCell.delete(cellKey as object);
    },
  };

  portsByCell.set(cellKey as object, port);
  void boundInstance;
  return port;
}
