/**
 * Twitch embed knowledge for audio lock.
 *
 * postMessage format from player.twitch.tv/js/embed/v1.js:
 * - `_sendCommand(e, t)` posts `{ eventName, params, namespace: "twitch-embed-player-proxy" }`
 * - SetMuted enum value is `10`
 * - `_handleResponses` accepts `eventName: "UPDATE_STATE"` and merges `params`
 *
 * Verified against fix-5 live scenario g on a real player.twitch.tv iframe.
 */

export const TWITCH_PLAYER_ORIGIN = "https://player.twitch.tv";

const TWITCH_EMBED_NAMESPACE = "twitch-embed-player-proxy";
const TWITCH_UPDATE_STATE = "UPDATE_STATE";
const TWITCH_SET_MUTED = 10;

const wrappedPlayers = new WeakSet<object>();
const initialPlayerState = new WeakMap<object, unknown>();

type TwitchIframeState = {
  muted: boolean;
  volume: number | null;
  receivedAt: number;
};

const iframeStates = new WeakMap<object, TwitchIframeState>();
let stateListenerInstalled = false;
let guardWarned = false;

function wrapPlayerCtor(
  OriginalPlayer: new (...args: unknown[]) => object,
  shouldDefaultMute: () => boolean,
): new (...args: unknown[]) => object {
  if (wrappedPlayers.has(OriginalPlayer as unknown as object)) {
    return OriginalPlayer;
  }

  const Wrapped = new Proxy(OriginalPlayer, {
    construct(target, args, newTarget) {
      const nextArgs = args.slice() as unknown[];
      const opts =
        nextArgs[1] && typeof nextArgs[1] === "object"
          ? { ...(nextArgs[1] as Record<string, unknown>) }
          : {};
      if (opts.muted === undefined && shouldDefaultMute()) {
        opts.muted = true;
      }
      nextArgs[1] = opts;
      const inst = Reflect.construct(target, nextArgs, newTarget) as object;
      try {
        Object.defineProperty(inst, "__v_skip", {
          value: true,
          configurable: true,
        });
      } catch {
        /* ignore */
      }
      try {
        const getState = (inst as { getPlayerState?: () => unknown }).getPlayerState;
        if (typeof getState === "function") {
          initialPlayerState.set(inst, getState.call(inst));
        }
      } catch {
        /* ignore */
      }
      return inst;
    },
  });

  wrappedPlayers.add(OriginalPlayer as unknown as object);
  wrappedPlayers.add(Wrapped as unknown as object);
  return Wrapped as unknown as new (...args: unknown[]) => object;
}

function wrapTwitchGlobal(
  value: unknown,
  shouldDefaultMute: () => boolean,
): unknown {
  if (!value || typeof value !== "object") return value;
  const rec = value as { Player?: unknown };
  if (typeof rec.Player !== "function") return value;
  const Player = rec.Player as new (...args: unknown[]) => object;
  if (wrappedPlayers.has(Player as unknown as object)) return value;
  const wrapped = wrapPlayerCtor(Player, shouldDefaultMute);
  try {
    rec.Player = wrapped;
    return value;
  } catch {
    return { ...rec, Player: wrapped };
  }
}

export function installTwitchPlayerGuard(
  win: Window,
  shouldDefaultMute: () => boolean,
): void {
  const existing = (win as Window & { Twitch?: unknown }).Twitch;
  if (existing) {
    try {
      (win as Window & { Twitch?: unknown }).Twitch = wrapTwitchGlobal(
        existing,
        shouldDefaultMute,
      );
    } catch {
      /* ignore */
    }
    return;
  }

  let held: unknown;
  try {
    Object.defineProperty(win, "Twitch", {
      configurable: true,
      enumerable: true,
      get() {
        return held;
      },
      set(value: unknown) {
        held = wrapTwitchGlobal(value, shouldDefaultMute);
      },
    });
  } catch {
    if (!guardWarned) {
      guardWarned = true;
      try {
        console.warn("[Holodex+ AudioLock]", {
          code: "twitch-guard-unavailable",
          adapterVersion: 1,
        });
      } catch {
        /* ignore */
      }
    }
  }
}

export function isVueObserved(instance: object): boolean {
  try {
    if (Object.prototype.hasOwnProperty.call(instance, "__ob__")) {
      return true;
    }
    const getPlayer = (instance as { getPlayer?: () => unknown }).getPlayer;
    if (typeof getPlayer === "function") {
      try {
        const inner = getPlayer.call(instance);
        if (
          inner &&
          typeof inner === "object" &&
          Object.prototype.hasOwnProperty.call(inner, "__ob__")
        ) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function isTwitchStateFresh(instance: object): boolean | null {
  try {
    const getState = (instance as { getPlayerState?: () => unknown })
      .getPlayerState;
    if (typeof getState !== "function") return true;
    if (!initialPlayerState.has(instance)) return null;
    return getState.call(instance) !== initialPlayerState.get(instance);
  } catch {
    return false;
  }
}

export function postTwitchSetMuted(
  iframe: HTMLIFrameElement | null | undefined,
  muted: boolean,
): boolean {
  if (!iframe) return false;
  try {
    const origin = new URL(iframe.src).origin;
    if (origin !== TWITCH_PLAYER_ORIGIN) return false;
    const cw = iframe.contentWindow;
    if (!cw) return false;
    cw.postMessage(
      {
        eventName: TWITCH_SET_MUTED,
        params: muted,
        namespace: TWITCH_EMBED_NAMESPACE,
      },
      TWITCH_PLAYER_ORIGIN,
    );
    return true;
  } catch {
    return false;
  }
}

export function installTwitchStateListener(
  win: Window,
  now: () => number,
): void {
  if (stateListenerInstalled) return;
  stateListenerInstalled = true;
  win.addEventListener("message", (event: MessageEvent) => {
    try {
      if (event.origin !== TWITCH_PLAYER_ORIGIN) return;
      if (!event.source || typeof event.source !== "object") return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const rec = data as Record<string, unknown>;
      if (rec.namespace !== TWITCH_EMBED_NAMESPACE) return;
      if (rec.eventName !== TWITCH_UPDATE_STATE) return;
      if (!rec.params || typeof rec.params !== "object") return;
      const params = rec.params as Record<string, unknown>;
      const prev = iframeStates.get(event.source as object);
      const muted =
        typeof params.muted === "boolean" ? params.muted : prev?.muted;
      if (typeof muted !== "boolean") return;
      const volume =
        typeof params.volume === "number" && Number.isFinite(params.volume)
          ? params.volume
          : (prev?.volume ?? null);
      iframeStates.set(event.source as object, {
        muted,
        volume,
        receivedAt: now(),
      });
    } catch {
      /* ignore */
    }
  });
}

export function readTwitchIframeState(
  iframe: HTMLIFrameElement | null | undefined,
): { muted: boolean; volume: number | null; receivedAt: number } | null {
  if (!iframe) return null;
  try {
    if (new URL(iframe.src).origin !== TWITCH_PLAYER_ORIGIN) return null;
    const cw = iframe.contentWindow;
    if (!cw) return null;
    return iframeStates.get(cw) ?? null;
  } catch {
    return null;
  }
}
