import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTwitchPlayerGuard,
  installTwitchStateListener,
  isTwitchStateFresh,
  isVueObserved,
  postTwitchSetMuted,
  readTwitchIframeState,
  TWITCH_PLAYER_ORIGIN,
} from "../../src/pages/content/holodex/audio-lock/twitch-embed";

type TwitchWin = Window & { Twitch?: unknown };

function saveTwitchDescriptor(): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(window, "Twitch");
}

function restoreTwitchDescriptor(desc: PropertyDescriptor | undefined): void {
  try {
    delete (window as TwitchWin).Twitch;
  } catch {
    /* ignore */
  }
  if (desc) {
    Object.defineProperty(window, "Twitch", desc);
  }
}

function dispatchTwitchState(
  iframe: HTMLIFrameElement,
  params: Record<string, unknown>,
  overrides?: Partial<MessageEventInit>,
): void {
  const event = new MessageEvent("message", {
    origin: TWITCH_PLAYER_ORIGIN,
    data: {
      namespace: "twitch-embed-player-proxy",
      eventName: "UPDATE_STATE",
      params,
    },
    ...overrides,
  });
  Object.defineProperty(event, "source", {
    value: overrides?.source ?? iframe.contentWindow,
    configurable: true,
  });
  window.dispatchEvent(event);
}

describe("twitch-embed", () => {
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = saveTwitchDescriptor();
    try {
      delete (window as TwitchWin).Twitch;
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    restoreTwitchDescriptor(saved);
    document.body.innerHTML = "";
  });

  it("guard_wraps_twitch_assigned_after_install", () => {
    const FakeCtor = vi.fn(function (this: { opts: unknown }, _el: string, opts: unknown) {
      this.opts = opts;
    });
    installTwitchPlayerGuard(window, () => true);
    (window as TwitchWin).Twitch = { Player: FakeCtor };
    const Twitch = (window as TwitchWin).Twitch as {
      Player: new (...a: unknown[]) => { opts: unknown };
    };
    const inst = new Twitch.Player("el", { channel: "c" });
    expect(FakeCtor).toHaveBeenCalledTimes(1);
    expect(inst.opts).toEqual({ channel: "c", muted: true });
  });

  it("guard_wraps_existing_twitch_global", () => {
    const FakeCtor = vi.fn(function (this: { opts: unknown }, _el: string, opts: unknown) {
      this.opts = opts;
    });
    (window as TwitchWin).Twitch = { Player: FakeCtor };
    installTwitchPlayerGuard(window, () => true);
    installTwitchPlayerGuard(window, () => true);
    const Twitch = (window as TwitchWin).Twitch as { Player: new (...a: unknown[]) => { opts: unknown } };
    new Twitch.Player("el", { channel: "c" });
    expect(FakeCtor).toHaveBeenCalledTimes(1);
    expect(FakeCtor.mock.calls[0][1]).toEqual({ channel: "c", muted: true });
  });

  it("guard_defaults_muted_true_only_when_lock_may_apply", () => {
    const FakeCtor = vi.fn(function (this: { opts: unknown }, _el: string, opts: unknown) {
      this.opts = opts;
    });
    installTwitchPlayerGuard(window, () => false);
    (window as TwitchWin).Twitch = { Player: FakeCtor };
    const Twitch = (window as TwitchWin).Twitch as { Player: new (...a: unknown[]) => { opts: unknown } };
    const inst = new Twitch.Player("el", { channel: "c" });
    expect(inst.opts).toEqual({ channel: "c" });
    expect("muted" in (inst.opts as object)).toBe(false);
  });

  it("guard_keeps_explicit_muted_option", () => {
    const FakeCtor = vi.fn(function (this: { opts: unknown }, _el: string, opts: unknown) {
      this.opts = opts;
    });
    installTwitchPlayerGuard(window, () => true);
    (window as TwitchWin).Twitch = { Player: FakeCtor };
    const Twitch = (window as TwitchWin).Twitch as { Player: new (...a: unknown[]) => { opts: unknown } };
    const inst = new Twitch.Player("el", { channel: "c", muted: false });
    expect(inst.opts).toEqual({ channel: "c", muted: false });
  });

  it("guard_marks_instance_v_skip_non_enumerable", () => {
    function FakeCtor(this: Record<string, unknown>) {
      this.x = 1;
    }
    installTwitchPlayerGuard(window, () => true);
    (window as TwitchWin).Twitch = { Player: FakeCtor };
    const Twitch = (window as TwitchWin).Twitch as { Player: new (...a: unknown[]) => object };
    const inst = new Twitch.Player("el", { channel: "c" }) as { __v_skip?: boolean };
    expect(inst.__v_skip).toBe(true);
    expect(Object.keys(inst)).not.toContain("__v_skip");
  });

  it("guard_preserves_statics_prototype_and_instanceof", () => {
    class Base {
      static READY = "ready";
    }
    class P extends Base {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor(..._args: unknown[]) {
        super();
      }
    }
    installTwitchPlayerGuard(window, () => true);
    (window as TwitchWin).Twitch = { Player: P };
    const Twitch = (window as TwitchWin).Twitch as {
      Player: typeof P & { READY: string };
    };
    expect(Twitch.Player.READY).toBe("ready");
    const inst = new Twitch.Player("el", { channel: "c" });
    expect(inst instanceof Twitch.Player).toBe(true);
    expect(Object.getPrototypeOf(inst)).toBe(P.prototype);
  });

  it("twitch_state_fresh_tracks_player_state_replacement", () => {
    function FakeCtor(this: { _s: object; getPlayerState: () => object }) {
      this._s = { muted: false };
      this.getPlayerState = () => this._s;
    }
    installTwitchPlayerGuard(window, () => true);
    (window as TwitchWin).Twitch = { Player: FakeCtor };
    const Twitch = (window as TwitchWin).Twitch as {
      Player: new (...a: unknown[]) => { _s: object; getPlayerState: () => object };
    };
    const inst = new Twitch.Player("el", { channel: "c" });
    expect(isTwitchStateFresh(inst)).toBe(false);
    inst._s = { muted: true };
    expect(isTwitchStateFresh(inst)).toBe(true);

    const unguarded = {
      _s: { muted: false },
      getPlayerState() {
        return this._s;
      },
    };
    expect(isTwitchStateFresh(unguarded)).toBe(null);
  });

  it("post_set_muted_uses_twitch_proxy_message_format", () => {
    const iframe = document.createElement("iframe");
    iframe.src = "https://player.twitch.tv/?channel=x";
    document.body.appendChild(iframe);
    const spy = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: spy },
      configurable: true,
    });
    expect(postTwitchSetMuted(iframe, true)).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      {
        eventName: 10,
        params: true,
        namespace: "twitch-embed-player-proxy",
      },
      "https://player.twitch.tv",
    );

    const yt = document.createElement("iframe");
    yt.src = "https://www.youtube.com/embed/x";
    document.body.appendChild(yt);
    const ytSpy = vi.fn();
    Object.defineProperty(yt, "contentWindow", {
      value: { postMessage: ytSpy },
      configurable: true,
    });
    expect(postTwitchSetMuted(yt, true)).toBe(false);
    expect(ytSpy).not.toHaveBeenCalled();
    expect(postTwitchSetMuted(null, true)).toBe(false);
  });

  it("is_vue_observed_detects_ob_on_instance_or_inner_player", () => {
    const withOb = {};
    Object.defineProperty(withOb, "__ob__", { value: {}, configurable: true });
    expect(isVueObserved(withOb)).toBe(true);

    const inner = {};
    Object.defineProperty(inner, "__ob__", { value: {}, configurable: true });
    const outer = {
      getPlayer() {
        return inner;
      },
    };
    expect(isVueObserved(outer)).toBe(true);

    expect(isVueObserved({})).toBe(false);

    const throws = {
      getPlayer() {
        throw new Error("blocked");
      },
    };
    expect(isVueObserved(throws)).toBe(true);
  });

  it("twitch_state_listener_accepts_valid_update_state", () => {
    const now = vi.fn(() => 1000);
    installTwitchStateListener(window, now);
    installTwitchStateListener(window, now);

    const iframe = document.createElement("iframe");
    iframe.src = "https://player.twitch.tv/?channel=a";
    document.body.appendChild(iframe);
    const other = document.createElement("iframe");
    other.src = "https://player.twitch.tv/?channel=b";
    document.body.appendChild(other);

    dispatchTwitchState(iframe, { muted: true, volume: 0.5 });
    expect(readTwitchIframeState(iframe)).toEqual({
      muted: true,
      volume: 0.5,
      receivedAt: 1000,
    });
    now.mockReturnValue(2000);
    dispatchTwitchState(iframe, { currentTime: 3 });
    expect(readTwitchIframeState(iframe)).toEqual({
      muted: true,
      volume: 0.5,
      receivedAt: 2000,
    });
    expect(readTwitchIframeState(other)).toBe(null);
  });

  it("twitch_state_listener_rejects_untrusted_messages", () => {
    installTwitchStateListener(window, () => 1);
    const iframe = document.createElement("iframe");
    iframe.src = "https://player.twitch.tv/?channel=a";
    document.body.appendChild(iframe);
    const other = document.createElement("iframe");
    other.src = "https://www.youtube.com/embed/x";
    document.body.appendChild(other);

    const cases: Array<() => void> = [
      () =>
        dispatchTwitchState(iframe, { muted: true }, { origin: "https://evil.example" }),
      () =>
        dispatchTwitchState(iframe, { muted: true }, { source: window as unknown as MessageEventSource }),
      () =>
        dispatchTwitchState(iframe, { muted: true }, {
          source: other.contentWindow as unknown as MessageEventSource,
        }),
      () => {
        const event = new MessageEvent("message", {
          origin: TWITCH_PLAYER_ORIGIN,
          data: {
            namespace: "wrong",
            eventName: "UPDATE_STATE",
            params: { muted: true },
          },
        });
        Object.defineProperty(event, "source", {
          value: iframe.contentWindow,
          configurable: true,
        });
        window.dispatchEvent(event);
      },
      () => {
        const event = new MessageEvent("message", {
          origin: TWITCH_PLAYER_ORIGIN,
          data: {
            namespace: "twitch-embed-player-proxy",
            eventName: "OTHER",
            params: { muted: true },
          },
        });
        Object.defineProperty(event, "source", {
          value: iframe.contentWindow,
          configurable: true,
        });
        window.dispatchEvent(event);
      },
      () =>
        dispatchTwitchState(iframe, null as unknown as Record<string, unknown>),
      () => dispatchTwitchState(iframe, { muted: "yes" }),
      () => {
        const event = new MessageEvent("message", {
          origin: TWITCH_PLAYER_ORIGIN,
          data: "string",
        });
        Object.defineProperty(event, "source", {
          value: iframe.contentWindow,
          configurable: true,
        });
        window.dispatchEvent(event);
      },
    ];

    for (const send of cases) {
      send();
      expect(readTwitchIframeState(iframe)).toBe(null);
    }
  });
});
