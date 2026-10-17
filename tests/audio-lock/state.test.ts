import { describe, expect, it } from "vitest";
import type { CellIdentity, LockState } from "../../src/pages/content/holodex/audio-lock/contracts";
import { TIMING } from "../../src/pages/content/holodex/audio-lock/contracts";
import {
  createInitialState,
  desiredMute,
  pollObservation,
  transition,
} from "../../src/pages/content/holodex/audio-lock/state";

function id(
  key: string,
  provider: "youtube" | "twitch" = "twitch",
  contentId = `c-${key}`,
  generation = 1,
): CellIdentity {
  return { key, contentId, provider, generation };
}

function enabledLocked(active: CellIdentity): LockState {
  return {
    ...createInitialState(),
    extensionEnabled: true,
    muteOthers: true,
    mode: "locked",
    selection: "selected",
    active,
    epoch: 1,
  };
}

function enabledBootstrap(): LockState {
  return {
    ...createInitialState(),
    extensionEnabled: true,
    muteOthers: true,
    mode: "waiting-for-choice",
    selection: "bootstrap",
    active: null,
    epoch: 0,
  };
}

describe("desiredMute", () => {
  it("returns unassigned when disabled/discovering/degraded", () => {
    const identity = id("a");
    for (const mode of ["disabled", "discovering", "degraded"] as const) {
      const state: LockState = {
        ...createInitialState(),
        mode,
        selection: "selected",
        active: identity,
      };
      expect(desiredMute(state, false, identity)).toBe("unassigned");
    }
  });

  it("bootstrap: U and false are unassigned; true is muted", () => {
    const state = enabledBootstrap();
    const a = id("a");
    expect(desiredMute(state, undefined, a)).toBe("unassigned");
    expect(desiredMute(state, false, a)).toBe("unassigned");
    expect(desiredMute(state, true, a)).toBe("muted");
  });

  it("selected: active audible, others muted", () => {
    const a = id("a");
    const b = id("b");
    const state = enabledLocked(a);
    expect(desiredMute(state, false, a)).toBe("audible");
    expect(desiredMute(state, true, b)).toBe("muted");
  });

  it("silence: all muted", () => {
    const state: LockState = {
      ...enabledBootstrap(),
      selection: "silence",
      mode: "waiting-for-choice",
    };
    expect(desiredMute(state, false, id("a"))).toBe("muted");
  });
});

describe("transition table", () => {
  it("disabled produces no effects on observations", () => {
    const state = createInitialState();
    const { effects } = transition(state, {
      type: "OBSERVED_MUTED",
      now: 0,
      identity: id("b"),
      muted: false,
      hasValidToken: false,
    });
    expect(effects).toEqual([]);
  });

  it("locked A: unauthorized B false only MUTE_PLAYER(B)", () => {
    const a = id("a", "youtube");
    const b = id("b", "twitch");
    const state = enabledLocked(a);
    const { state: next, effects, desired } = pollObservation(
      state,
      b,
      true,
      false,
      1000,
      false,
    );
    expect(desired).toBe("muted");
    expect(effects).toEqual([
      { type: "MUTE_PLAYER", identity: b, epoch: state.epoch },
    ]);
    expect(next.active).toEqual(a);
  });

  it("token B false produces one CALL_ORIGINAL_SET_MUTED(B,false)", () => {
    const a = id("a");
    const b = id("b");
    let state = enabledLocked(a);
    state = {
      ...state,
      intent: {
        identity: b,
        source: "iframe",
        expiresAt: 1000 + TIMING.USER_INTENT_MS,
        consumed: false,
      },
    };
    const { state: next, effects } = transition(state, {
      type: "OBSERVED_MUTED",
      now: 1000,
      identity: b,
      muted: false,
      hasValidToken: true,
    });
    expect(effects).toEqual([
      {
        type: "CALL_ORIGINAL_SET_MUTED",
        identity: b,
        muted: false,
        epoch: next.epoch,
      },
    ]);
    expect(next.active).toEqual(b);
    expect(next.selection).toBe("selected");
    expect(next.intent).toBeNull();
  });

  it("token expires after 2500ms and does not authorize", () => {
    const a = id("a");
    const b = id("b");
    let state = enabledLocked(a);
    state = {
      ...state,
      intent: {
        identity: b,
        source: "iframe",
        expiresAt: 1000 + TIMING.USER_INTENT_MS,
        consumed: false,
      },
    };
    const { effects } = pollObservation(
      state,
      b,
      true,
      false,
      1000 + TIMING.USER_INTENT_MS + 1,
      false,
    );
    expect(effects).toEqual([
      { type: "MUTE_PLAYER", identity: b, epoch: state.epoch },
    ]);
  });

  it("all mute → silence with active=null", () => {
    const a = id("a");
    const state = enabledLocked(a);
    const { state: next } = transition(state, {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: a,
      muted: true,
    });
    expect(next.active).toBeNull();
    expect(next.selection).toBe("silence");
    expect(next.mode).toBe("waiting-for-choice");
  });

  it("stale epoch effects are for current epoch only after bump", () => {
    const a = id("a");
    const state = enabledLocked(a);
    const before = state.epoch;
    const { state: next } = transition(state, { type: "DISABLE", now: 0 });
    expect(next.epoch).toBe(before + 1);
    expect(next.mode).toBe("disabled");
  });

  it("four U bootstrap: first NATIVE_FIRST_PLAY calls muteOthers once; second blocked", () => {
    const cells = [id("0"), id("1"), id("2"), id("3")];
    const state = enabledBootstrap();
    const first = transition(state, {
      type: "NATIVE_FIRST_PLAY",
      now: 0,
      identity: cells[0],
    });
    expect(first.effects).toEqual([
      {
        type: "CALL_ORIGINAL_MUTE_OTHERS",
        identity: cells[0],
        epoch: first.state.epoch,
      },
    ]);
    expect(first.state.active).toEqual(cells[0]);
    expect(first.state.selection).toBe("selected");

    const second = transition(first.state, {
      type: "NATIVE_FIRST_PLAY",
      now: 1,
      identity: cells[1],
    });
    expect(second.effects).toEqual([]);
    expect(second.state.active).toEqual(cells[0]);
  });

  it("bootstrap_poll_does_not_mute_unassigned_or_false_cells", () => {
    const state = enabledBootstrap();
    const u = id("u");
    const f = id("f");
    const t = id("t");

    const pollU = pollObservation(state, u, undefined, false, 0);
    expect(pollU.desired).toBe("unassigned");
    expect(pollU.effects.some((e) => e.type === "MUTE_PLAYER")).toBe(false);

    const pollF = pollObservation(state, f, false, false, 0);
    expect(pollF.desired).toBe("unassigned");
    expect(pollF.effects.some((e) => e.type === "MUTE_PLAYER")).toBe(false);

    const pollT = pollObservation(state, t, true, false, 0);
    expect(pollT.desired).toBe("muted");
    expect(pollT.effects).toEqual([
      { type: "MUTE_PLAYER", identity: t, epoch: state.epoch },
    ]);
  });

  it("explicit panel unmute selects B", () => {
    const a = id("a");
    const b = id("b");
    const state = enabledLocked(a);
    const { state: next, effects } = transition(state, {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: b,
      muted: false,
    });
    expect(next.active).toEqual(b);
    expect(effects[0]).toMatchObject({
      type: "CALL_ORIGINAL_SET_MUTED",
      identity: b,
      muted: false,
    });
    expect(next.selectionGrant?.grant.source).toBe("explicit");
  });

  it("silence blocks bootstrap first play", () => {
    const state: LockState = {
      ...enabledBootstrap(),
      selection: "silence",
      active: null,
    };
    const { effects, state: next } = transition(state, {
      type: "NATIVE_FIRST_PLAY",
      now: 0,
      identity: id("x"),
    });
    expect(effects).toEqual([]);
    expect(next.selection).toBe("silence");
  });

  it("initial unique false becomes selected", () => {
    const a = id("a");
    const b = id("b");
    const state = {
      ...createInitialState(),
      extensionEnabled: true,
      muteOthers: true,
      mode: "discovering" as const,
    };
    const { state: next, effects } = transition(state, {
      type: "STORE_SNAPSHOT",
      now: 0,
      snapshot: {
        muteOthers: true,
        cells: [
          { identity: a, assignment: false },
          { identity: b, assignment: undefined },
        ],
      },
    });
    expect(next.selection).toBe("selected");
    expect(next.active).toEqual(a);
    expect(effects).toContainEqual({
      type: "SET_STORE_MUTED",
      identity: b,
      value: true,
      epoch: next.epoch,
    });
  });

  it("grant cleared on silence", () => {
    const a = id("a");
    let state = enabledLocked(a);
    state = {
      ...state,
      selectionGrant: {
        grant: { identity: a, epoch: 1, source: "explicit" },
        consumed: false,
      },
    };
    const { state: next } = transition(state, {
      type: "EXPLICIT_SET_MUTED",
      now: 0,
      identity: a,
      muted: true,
    });
    expect(next.selectionGrant).toBeNull();
  });
});
