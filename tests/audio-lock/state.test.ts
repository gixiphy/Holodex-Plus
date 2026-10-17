import { describe, expect, it } from "vitest";
import type {
  CellIdentity,
  LockState,
  StoreSnapshot,
} from "../../src/pages/content/holodex/audio-lock/contracts";
import { TIMING } from "../../src/pages/content/holodex/audio-lock/contracts";
import {
  classifyLayout,
  createInitialState,
  desiredMute,
  emptyCellRuntime,
  pollObservation,
  storeConverged,
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

function snap(
  cells: Array<{ identity: CellIdentity; assignment?: boolean }>,
): StoreSnapshot {
  return {
    muteOthers: true,
    cells: cells.map((c) => ({
      identity: c.identity,
      assignment: c.assignment,
    })),
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
      assignment: true,
      origin: "poll",
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
    state = patchObserved(state, b.key, true);
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
      assignment: true,
      origin: "poll",
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
    state = patchObserved(state, b.key, true);
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
    expect(first.state.cells[cells[0].key]?.settleUntil).toBe(TIMING.SETTLE_MS);

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

  it("focus_token_requires_muted_to_unmuted_edge", () => {
    const a = id("a");
    const b = id("b");
    for (const prev of [false, null] as const) {
      let state = enabledLocked(a);
      state = patchObserved(state, b.key, prev);
      state = {
        ...state,
        intent: {
          identity: b,
          source: "iframe",
          expiresAt: 5000,
          consumed: false,
        },
      };
      const { state: next, effects } = transition(state, {
        type: "OBSERVED_MUTED",
        now: 1000,
        identity: b,
        muted: false,
        assignment: true,
        origin: "poll",
      });
      expect(next.active).toEqual(a);
      expect(effects).toContainEqual({
        type: "MUTE_PLAYER",
        identity: b,
        epoch: state.epoch,
      });
      expect(next.intent?.consumed).toBe(false);
    }
  });

  it("token_edge_selects_once", () => {
    const a = id("a");
    const b = id("b");
    let state = enabledLocked(a);
    state = {
      ...state,
      intent: {
        identity: b,
        source: "iframe",
        expiresAt: 10_000,
        consumed: false,
      },
    };
    const t1 = transition(state, {
      type: "OBSERVED_MUTED",
      now: 1000,
      identity: b,
      muted: true,
      assignment: true,
      origin: "poll",
    });
    const t2 = transition(t1.state, {
      type: "OBSERVED_MUTED",
      now: 1100,
      identity: b,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    expect(
      t2.effects.filter(
        (e) => e.type === "CALL_ORIGINAL_SET_MUTED" && e.muted === false,
      ),
    ).toHaveLength(1);
    expect(t2.state.active).toEqual(b);

    // second true→false within settle: no re-authorize (token consumed; settle active)
    const t3 = transition(t2.state, {
      type: "OBSERVED_MUTED",
      now: 1200,
      identity: a,
      muted: true,
      assignment: true,
      origin: "poll",
    });
    // re-issue token for b after settle window on a different timeline
    let after = {
      ...t2.state,
      intent: {
        identity: b,
        source: "iframe" as const,
        expiresAt: 20_000,
        consumed: false,
      },
      cells: {
        ...t2.state.cells,
        [b.key]: {
          ...(t2.state.cells[b.key] ?? emptyCellRuntime()),
          settleUntil: 0,
          lastObservedMuted: true as boolean | null,
        },
      },
    };
    // active is b; observing b true then false with new token should not select again
    // (already active) — use a as active again for second edge authorization attempt
    after = {
      ...enabledLocked(a),
      intent: {
        identity: b,
        source: "iframe",
        expiresAt: 20_000,
        consumed: false,
      },
      cells: {
        [b.key]: {
          ...emptyCellRuntime(),
          lastObservedMuted: true,
          settleUntil: 0,
        },
      },
      epoch: 5,
    };
    const edge1 = transition(after, {
      type: "OBSERVED_MUTED",
      now: 2000,
      identity: b,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    expect(edge1.state.active).toEqual(b);
    const edge2State = {
      ...edge1.state,
      intent: {
        identity: b,
        source: "iframe" as const,
        expiresAt: 30_000,
        consumed: false,
      },
      cells: {
        ...edge1.state.cells,
        [b.key]: {
          ...(edge1.state.cells[b.key] ?? emptyCellRuntime()),
          lastObservedMuted: true,
          settleUntil: 0,
        },
      },
      // reset active to a to see if token would re-select b
      active: a,
      selection: "selected" as const,
      mode: "locked" as const,
    };
    const edge2 = transition(edge2State, {
      type: "OBSERVED_MUTED",
      now: 3000,
      identity: b,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    // token was for same generation edge — plan: second true→false no longer authorizes
    // because first consumption already happened; with fresh token it WOULD authorize again
    // Plan text: "接著第二次 true→false 不再授權" means same token / same intent window
    void t3;
    // Re-read plan: after first edge select, second true→false does not authorize.
    // Using the same intent that was consumed:
    let once = enabledLocked(a);
    once = {
      ...once,
      intent: {
        identity: b,
        source: "iframe",
        expiresAt: 10_000,
        consumed: false,
      },
      cells: {
        [b.key]: { ...emptyCellRuntime(), lastObservedMuted: null },
      },
    };
    once = transition(once, {
      type: "OBSERVED_MUTED",
      now: 100,
      identity: b,
      muted: true,
      assignment: true,
      origin: "poll",
    }).state;
    const select = transition(once, {
      type: "OBSERVED_MUTED",
      now: 200,
      identity: b,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    expect(
      select.effects.filter(
        (e) => e.type === "CALL_ORIGINAL_SET_MUTED" && e.muted === false,
      ),
    ).toHaveLength(1);
    // force active back and try second edge with consumed token
    const second = transition(
      {
        ...select.state,
        active: a,
        selection: "selected",
        mode: "locked",
        cells: {
          ...select.state.cells,
          [b.key]: {
            ...(select.state.cells[b.key] ?? emptyCellRuntime()),
            lastObservedMuted: true,
            settleUntil: 0,
          },
        },
      },
      {
        type: "OBSERVED_MUTED",
        now: 300,
        identity: b,
        muted: false,
        assignment: true,
        origin: "poll",
      },
    );
    expect(
      second.effects.filter(
        (e) => e.type === "CALL_ORIGINAL_SET_MUTED" && e.muted === false,
      ),
    ).toHaveLength(0);
    void edge2;
  });

  it("refresh_mute_true_is_observation_only_in_bootstrap", () => {
    const state = enabledBootstrap();
    const { state: next, effects } = transition(state, {
      type: "OBSERVED_MUTED",
      now: 0,
      identity: id("a"),
      muted: true,
      assignment: undefined,
      origin: "refresh",
    });
    expect(effects).toEqual([]);
    expect(next.selection).toBe("bootstrap");
  });

  it("refresh_mute_true_respects_grant_and_settle", () => {
    const a = id("a");
    let state = enabledLocked(a);
    state = {
      ...state,
      selectionGrant: {
        grant: { identity: a, epoch: 1, source: "explicit" },
        consumed: false,
      },
      cells: {
        [a.key]: { ...emptyCellRuntime(), settleUntil: 0, lastObservedMuted: false },
      },
    };
    const withGrant = transition(state, {
      type: "OBSERVED_MUTED",
      now: 1000,
      identity: a,
      muted: true,
      assignment: false,
      origin: "refresh",
    });
    expect(withGrant.state.selection).toBe("selected");
    expect(withGrant.effects).toEqual([]);

    const settling = transition(
      {
        ...enabledLocked(a),
        cells: {
          [a.key]: {
            ...emptyCellRuntime(),
            settleUntil: 2000,
            lastObservedMuted: false,
          },
        },
      },
      {
        type: "OBSERVED_MUTED",
        now: 1000,
        identity: a,
        muted: true,
        assignment: false,
        origin: "refresh",
      },
    );
    expect(settling.state.selection).toBe("selected");

    const silence = transition(
      {
        ...enabledLocked(a),
        cells: {
          [a.key]: {
            ...emptyCellRuntime(),
            settleUntil: 0,
            lastObservedMuted: false,
          },
        },
      },
      {
        type: "OBSERVED_MUTED",
        now: 1000,
        identity: a,
        muted: true,
        assignment: false,
        origin: "refresh",
      },
    );
    expect(silence.state.selection).toBe("silence");
    expect(silence.effects).toContainEqual(
      expect.objectContaining({
        type: "CALL_ORIGINAL_SET_MUTED",
        muted: true,
      }),
    );
  });

  it("observed_false_uses_assignment_in_bootstrap", () => {
    const state = enabledBootstrap();
    const a = id("a");
    const mutedAssign = transition(state, {
      type: "OBSERVED_MUTED",
      now: 0,
      identity: a,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    expect(mutedAssign.effects).toEqual([
      { type: "MUTE_PLAYER", identity: a, epoch: state.epoch },
    ]);
    for (const assignment of [undefined, false] as const) {
      const r = transition(state, {
        type: "OBSERVED_MUTED",
        now: 0,
        identity: a,
        muted: false,
        assignment,
        origin: "poll",
      });
      expect(r.effects).toEqual([]);
    }
  });

  it("mute_settle_and_unsettled_count", () => {
    const a = id("a");
    const b = id("b");
    let state = enabledLocked(a);
    state = transition(state, {
      type: "MUTE_SENT",
      now: 1000,
      identity: b,
    }).state;
    const during = transition(state, {
      type: "OBSERVED_MUTED",
      now: 1000 + 500,
      identity: b,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    expect(during.effects).toEqual([]);

    // three MUTE_SENT then still false → degrade
    state = enabledLocked(a);
    for (let i = 0; i < 3; i++) {
      state = transition(state, {
        type: "MUTE_SENT",
        now: 2000 + i * 2000,
        identity: b,
      }).state;
      // expire settle between
      state = {
        ...state,
        cells: {
          ...state.cells,
          [b.key]: {
            ...state.cells[b.key]!,
            settleUntil: 0,
          },
        },
      };
    }
    const deg = transition(state, {
      type: "OBSERVED_MUTED",
      now: 10_000,
      identity: b,
      muted: false,
      assignment: true,
      origin: "poll",
    });
    expect(deg.state.mode).toBe("degraded");
    expect(deg.effects).toContainEqual({
      type: "REPORT_ONCE",
      code: "player-mute-did-not-settle",
    });

    // reading true resets count
    state = enabledLocked(a);
    state = transition(state, { type: "MUTE_SENT", now: 0, identity: b }).state;
    state = transition(state, { type: "MUTE_SENT", now: 2000, identity: b }).state;
    state = {
      ...state,
      cells: {
        ...state.cells,
        [b.key]: { ...state.cells[b.key]!, settleUntil: 0 },
      },
    };
    state = transition(state, {
      type: "OBSERVED_MUTED",
      now: 5000,
      identity: b,
      muted: true,
      assignment: true,
      origin: "poll",
    }).state;
    expect(state.cells[b.key]?.unsettledMuteCount).toBe(0);
  });

  it("player_ready_normalizes_only_unassigned", () => {
    const a = id("a");
    const b = id("b");
    const state = enabledLocked(a);
    const u = transition(state, {
      type: "PLAYER_READY",
      now: 0,
      identity: b,
      assignment: undefined,
    });
    expect(u.effects).toEqual([
      {
        type: "SET_STORE_MUTED",
        identity: b,
        value: true,
        epoch: state.epoch,
      },
    ]);
    expect(u.effects.some((e) => e.type === "MUTE_PLAYER")).toBe(false);

    const t = transition(state, {
      type: "PLAYER_READY",
      now: 0,
      identity: b,
      assignment: true,
    });
    expect(t.effects).toEqual([]);
  });

  it("discovered_keeps_degraded_and_locked", () => {
    const degraded: LockState = {
      ...createInitialState(),
      extensionEnabled: true,
      muteOthers: true,
      mode: "degraded",
      reportedCodes: { "player-unavailable": true },
    };
    expect(
      transition(degraded, { type: "DISCOVERED", now: 0, muteOthers: true }).state
        .mode,
    ).toBe("degraded");

    const a = id("a");
    const locked = enabledLocked(a);
    const kept = transition(locked, {
      type: "DISCOVERED",
      now: 0,
      muteOthers: true,
    });
    expect(kept.state.mode).toBe("locked");
    expect(kept.state.active).toEqual(a);

    const reset = transition(degraded, { type: "RESET_DEGRADED", now: 1 });
    expect(reset.state.mode).toBe("discovering");
    expect(reset.state.reportedCodes["player-unavailable"]).toBe(true);

    // degraded clears only after disable then re-enable (not duplicate ENABLE)
    const disabled = transition(degraded, { type: "DISABLE", now: 2 });
    const enable = transition(disabled.state, { type: "ENABLE", now: 3 });
    expect(enable.state.mode).toBe("discovering");
  });

  it("enable_is_idempotent_when_already_enabled", () => {
    const a = id("a");
    const cases: LockState[] = [
      enabledLocked(a),
      enabledBootstrap(),
      {
        ...createInitialState(),
        extensionEnabled: true,
        muteOthers: true,
        mode: "degraded",
        reportedCodes: { "player-unavailable": true },
        epoch: 3,
        active: a,
        selection: "selected",
      },
    ];
    for (const state of cases) {
      const result = transition(state, { type: "ENABLE", now: 99 });
      expect(result.state).toEqual(state);
      expect(result.effects).toEqual([]);
    }
  });

  it("classifyLayout_add_reorder_remove_replace", () => {
    const a = id("a");
    const b = id("b");
    const c = id("c");
    const prev = snap([
      { identity: a, assignment: false },
      { identity: b, assignment: true },
    ]);
    const added = classifyLayout(
      prev,
      snap([
        { identity: a, assignment: false },
        { identity: b, assignment: true },
        { identity: c, assignment: undefined },
      ]),
      new Set(),
      a,
    );
    expect(added.kind).toBe("add");
    expect(added.added.map((x) => x.key)).toContain("c");

    const reordered = classifyLayout(
      prev,
      snap([
        { identity: b, assignment: true },
        { identity: a, assignment: false },
      ]),
      new Set(),
      a,
    );
    expect(reordered.kind).toBe("reorder");

    const none = classifyLayout(prev, prev, new Set(), a);
    expect(none.kind).toBe("none");

    const removeActive = classifyLayout(
      prev,
      snap([{ identity: b, assignment: true }]),
      new Set(),
      a,
    );
    expect(removeActive.kind).toBe("remove-active");

    const replaced = id("a", "youtube", "new-a", 2);
    const replaceActive = classifyLayout(
      prev,
      snap([
        { identity: replaced, assignment: false },
        { identity: b, assignment: true },
      ]),
      new Set(),
      a,
    );
    expect(replaceActive.kind).toBe("replace-active");

    const dropB = classifyLayout(
      prev,
      snap([{ identity: a, assignment: false }]),
      new Set(),
      a,
    );
    expect(dropB.removed.some((r) => r.key === "b")).toBe(true);
    expect(dropB.kind).toBe("add");
  });

  it("classifyLayout_preset_and_merge", () => {
    const a = id("a", "twitch", "c-a", 1);
    const a2 = id("a", "twitch", "c-a", 9);
    const b = id("b");
    const prev = snap([
      { identity: a, assignment: false },
      { identity: b, assignment: true },
    ]);
    const merge = classifyLayout(
      prev,
      snap([
        { identity: a2, assignment: false },
        { identity: id("c"), assignment: undefined },
      ]),
      new Set(["multiview/setLayout", "multiview/setLayoutContent"]),
      a,
    );
    expect(merge.kind).toBe("merge-preset");
    expect(merge.preservedActive?.generation).toBe(9);

    const preset = classifyLayout(
      prev,
      snap([{ identity: id("x"), assignment: undefined }]),
      new Set(["multiview/setLayoutContent"]),
      a,
    );
    expect(preset.kind).toBe("preset");
    expect(preset.preservedActive).toBeNull();
  });

  it("storeConverged_allows_pending_unassigned", () => {
    const a = id("a");
    const b = id("b");
    const c = id("c");
    const snapshot = snap([
      { identity: a, assignment: false },
      { identity: b, assignment: true },
      { identity: c, assignment: undefined },
    ]);
    expect(storeConverged(snapshot, a, new Set(["c"]))).toBe(true);
    expect(storeConverged(snapshot, a, new Set())).toBe(false);
    const bad = snap([
      { identity: a, assignment: false },
      { identity: b, assignment: false },
    ]);
    expect(storeConverged(bad, a, new Set())).toBe(false);
  });
});

function patchObserved(
  state: LockState,
  key: string,
  lastObservedMuted: boolean | null,
): LockState {
  return {
    ...state,
    cells: {
      ...state.cells,
      [key]: {
        ...(state.cells[key] ?? emptyCellRuntime()),
        lastObservedMuted,
      },
    },
  };
}
