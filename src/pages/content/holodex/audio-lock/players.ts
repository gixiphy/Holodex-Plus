import type {
  CellIdentity,
  PlayerPort,
  ReadMuted,
  SelectionGrant,
} from "./contracts";
import { TIMING } from "./contracts";
import {
  isTwitchStateFresh,
  isVueObserved,
  postTwitchSetMuted,
  readTwitchIframeState,
} from "./twitch-embed";

export type PlayerBinding = {
  identity: CellIdentity;
  /** Parent VideoCell: holds twPlayer/ytPlayer (VideoCell.vue:79-80, :210-216). */
  cell: { twPlayer?: unknown; ytPlayer?: unknown };
  /** $refs.player: TwitchPlayer/YoutubePlayer (PlayerMixin). */
  playerComponent: {
    player?: unknown;
    $el?: Element;
    $on?: (event: string, cb: (...args: unknown[]) => void) => void;
    $off?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  provider: "youtube" | "twitch";
  onReady?: () => void;
  onContractMismatch?: () => void;
};

export type BoundPlayerPort = PlayerPort & { isBound(): boolean };

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

/**
 * Vue 2.7 observes Twitch.Player when Holodex stores it in reactive data.
 * Reading `_embedWindow` then throws SecurityError via isRef(), so SDK
 * getMuted/setMuted are unusable. Prefer iframe UPDATE_STATE / postMessage.
 */
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

function twitchIframe(
  binding: PlayerBinding,
): HTMLIFrameElement | null {
  try {
    const el = binding.playerComponent.$el;
    if (!el || typeof el.querySelector !== "function") return null;
    return el.querySelector("iframe");
  } catch {
    return null;
  }
}

/**
 * Late-bind when READY fired before our $on (VideoCell.vue:79-80, :210-216).
 * Twitch: cell.twPlayer === playerComponent.player (TwitchPlayer.vue:94).
 * YouTube: cell.ytPlayer.getIframe() contained in current component $el
 * (rejects stale ytPlayer after :key rebuild — VideoCell.vue:30, :134-139).
 */
function lateBindReady(binding: PlayerBinding): boolean {
  const { cell, playerComponent, provider } = binding;
  if (provider === "twitch") {
    const tw = cell.twPlayer;
    return (
      typeof tw === "object" &&
      tw !== null &&
      tw === playerComponent.player
    );
  }
  try {
    const yt = cell.ytPlayer as { getIframe?: () => Element } | null | undefined;
    if (!yt || typeof yt !== "object") return false;
    if (typeof yt.getIframe !== "function") return false;
    const iframe = yt.getIframe();
    const el = playerComponent.$el;
    if (!el || typeof el.contains !== "function") return false;
    return el.contains(iframe);
  } catch {
    return false;
  }
}

export function createPlayerPort(binding: PlayerBinding): BoundPlayerPort | null {
  const cellKey = binding.playerComponent;
  const existing = portsByCell.get(cellKey as object);
  if (existing) return existing as BoundPlayerPort;

  let disposed = false;
  let methods: BoundMethods | null = null;
  let boundInstance: object | null = null;
  let readySignal = false;
  let mismatched = false;
  let iframeChannel = false;
  let mismatchReported = false;
  let readyListener: ((...args: unknown[]) => void) | null = null;
  let onReadyFired = false;
  const usedGrants = new Set<string>();

  const fireOnReadyOnce = () => {
    if (onReadyFired || disposed) return;
    onReadyFired = true;
    if (!binding.onReady) return;
    queueMicrotask(() => {
      if (disposed) return;
      try {
        binding.onReady?.();
      } catch {
        /* ignore */
      }
    });
  };

  const reportMismatchOnce = () => {
    if (mismatchReported || disposed) return;
    mismatchReported = true;
    if (!binding.onContractMismatch) return;
    queueMicrotask(() => {
      if (disposed) return;
      try {
        binding.onContractMismatch?.();
      } catch {
        /* ignore */
      }
    });
  };

  const tryBind = (): boolean => {
    if (disposed || mismatched) return false;
    if (methods || iframeChannel) return true;
    if (!(readySignal || lateBindReady(binding))) return false;
    const instance = binding.playerComponent.player;
    if (!instance || typeof instance !== "object") return false;

    if (binding.provider === "twitch") {
      methods = bindTwitch(instance as object);
      if (!methods) {
        reportMismatchOnce();
        iframeChannel = true;
        boundInstance = instance as object;
        fireOnReadyOnce();
        return true;
      }
    } else {
      methods = bindYoutube(instance as object);
      if (!methods) {
        mismatched = true;
        reportMismatchOnce();
        return false;
      }
    }
    boundInstance = instance as object;
    fireOnReadyOnce();
    return true;
  };

  const useIframeChannel = (): boolean => {
    if (iframeChannel) return true;
    if (!boundInstance) return false;
    return isVueObserved(boundInstance);
  };

  const readViaIframe = (): ReadMuted => {
    const state = readTwitchIframeState(twitchIframe(binding));
    if (!state) {
      return { kind: "unavailable", reason: "untrusted" };
    }
    return { kind: "known", muted: state.muted };
  };

  if (!tryBind() && typeof binding.playerComponent.$on === "function") {
    readyListener = () => {
      readySignal = true;
      tryBind();
    };
    try {
      binding.playerComponent.$on!("ready", readyListener);
    } catch {
      readyListener = null;
    }
  }

  const port: BoundPlayerPort = {
    isBound(): boolean {
      return (methods !== null || iframeChannel) && !disposed;
    },

    async readMuted(): Promise<ReadMuted> {
      if (disposed) return { kind: "unavailable", reason: "access-error" };
      if (mismatched) {
        return { kind: "unavailable", reason: "access-error" };
      }
      if (!tryBind()) {
        return { kind: "unavailable", reason: "not-ready" };
      }
      if (binding.provider === "twitch" && useIframeChannel()) {
        return readViaIframe();
      }
      if (!methods) {
        return { kind: "unavailable", reason: "not-ready" };
      }
      if (
        binding.provider === "twitch" &&
        boundInstance &&
        isTwitchStateFresh(boundInstance) === false
      ) {
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
      if (!tryBind()) return false;
      if (binding.provider === "twitch" && useIframeChannel()) {
        return postTwitchSetMuted(twitchIframe(binding), true);
      }
      if (!methods) return false;
      if (binding.provider === "twitch") {
        let started: unknown;
        try {
          started = methods.mute();
        } catch {
          return postTwitchSetMuted(twitchIframe(binding), true);
        }
        try {
          const raced = await withTimeout(
            callMaybePromise(() => started),
            TIMING.READ_TIMEOUT_MS,
          );
          return raced.ok;
        } catch {
          return false;
        }
      }
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
      if (!tryBind()) return false;
      usedGrants.add(grantKey);
      if (binding.provider === "twitch" && useIframeChannel()) {
        return postTwitchSetMuted(twitchIframe(binding), false);
      }
      if (!methods) return false;
      if (binding.provider === "twitch") {
        let started: unknown;
        try {
          started = methods.unmute();
        } catch {
          return postTwitchSetMuted(twitchIframe(binding), false);
        }
        try {
          const raced = await withTimeout(
            callMaybePromise(() => started),
            TIMING.READ_TIMEOUT_MS,
          );
          return raced.ok;
        } catch {
          return false;
        }
      }
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
      iframeChannel = false;
      usedGrants.clear();
      portsByCell.delete(cellKey as object);
    },
  };

  portsByCell.set(cellKey as object, port);
  void boundInstance;
  return port;
}
