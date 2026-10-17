import {
  type CellIdentity,
  type DesiredMute,
  type LockEffect,
  type LockEvent,
  type LockState,
  type MutedAssignment,
  type SelectionGrant,
  type StoreCellSnapshot,
  type StoreSnapshot,
  TIMING,
  encodeAssignment,
  identityCore,
  sameIdentity,
} from "./contracts";

function emptyCellRuntime() {
  return {
    readInFlight: false,
    muteInFlight: false,
    lastMuteAt: 0,
    consecutiveFailures: 0,
    lastGuardMuteAt: 0,
    settleUntil: 0,
    ownMuteGeneration: null as number | null,
  };
}

export function createInitialState(): LockState {
  return {
    mode: "disabled",
    selection: "bootstrap",
    active: null,
    epoch: 0,
    intent: null,
    selectionGrant: null,
    extensionEnabled: false,
    muteOthers: false,
    cells: {},
    reportedCodes: {},
  };
}

export function desiredMute(
  state: LockState,
  assignment: MutedAssignment,
  identity: CellIdentity,
): DesiredMute {
  if (
    state.mode === "disabled" ||
    state.mode === "discovering" ||
    state.mode === "degraded"
  ) {
    return "unassigned";
  }

  if (state.selection === "bootstrap") {
    if (assignment === true) return "muted";
    return "unassigned";
  }

  if (state.selection === "silence") {
    return "muted";
  }

  // selected
  if (state.active && sameIdentity(state.active, identity)) {
    return "audible";
  }
  return "muted";
}

function ensureCell(state: LockState, key: string): LockState {
  if (state.cells[key]) return state;
  return {
    ...state,
    cells: { ...state.cells, [key]: emptyCellRuntime() },
  };
}

function clearIntent(state: LockState): LockState {
  return { ...state, intent: null };
}

function clearGrant(state: LockState): LockState {
  return { ...state, selectionGrant: null };
}

function bumpEpoch(state: LockState): LockState {
  return { ...state, epoch: state.epoch + 1 };
}

function withActive(
  state: LockState,
  identity: CellIdentity,
  selection: "bootstrap" | "selected",
  source: "bootstrap" | "explicit",
): { state: LockState; effects: LockEffect[]; grant: SelectionGrant } {
  let next = bumpEpoch(clearIntent(state));
  next = {
    ...next,
    mode: "locked",
    selection: selection === "bootstrap" ? "selected" : selection,
    active: identity,
  };
  // bootstrap first-play also becomes selected after choosing
  next = {
    ...next,
    selection: "selected",
  };
  const grant: SelectionGrant = {
    identity,
    epoch: next.epoch,
    source,
  };
  next = {
    ...next,
    selectionGrant: { grant, consumed: false },
  };
  return { state: next, effects: [], grant };
}

function toSilence(state: LockState): LockState {
  return clearGrant(
    clearIntent({
      ...bumpEpoch(state),
      mode: "waiting-for-choice",
      selection: "silence",
      active: null,
    }),
  );
}

function tokenValid(state: LockState, identity: CellIdentity, now: number): boolean {
  const t = state.intent;
  if (!t || t.consumed) return false;
  if (t.expiresAt < now) return false;
  return sameIdentity(t.identity, identity);
}

function consumeToken(state: LockState): LockState {
  if (!state.intent) return state;
  return {
    ...state,
    intent: { ...state.intent, consumed: true },
  };
}

function findUniqueAudible(snapshot: StoreSnapshot): StoreCellSnapshot | null {
  const audible = snapshot.cells.filter((c) => c.assignment === false);
  if (audible.length === 1) return audible[0];
  return null;
}

function allMuted(snapshot: StoreSnapshot): boolean {
  return (
    snapshot.cells.length > 0 &&
    snapshot.cells.every((c) => c.assignment === true)
  );
}

function applySnapshotSelection(
  state: LockState,
  snapshot: StoreSnapshot,
): { state: LockState; effects: LockEffect[] } {
  if (!snapshot.muteOthers || !state.extensionEnabled) {
    return {
      state: {
        ...state,
        muteOthers: snapshot.muteOthers,
        mode: state.extensionEnabled ? "discovering" : "disabled",
      },
      effects: [],
    };
  }

  let next: LockState = {
    ...state,
    muteOthers: true,
  };

  if (snapshot.cells.length === 0) {
    return {
      state: {
        ...next,
        mode: "waiting-for-choice",
        selection: "bootstrap",
        active: null,
      },
      effects: [],
    };
  }

  if (allMuted(snapshot)) {
    return {
      state: {
        ...next,
        mode: "waiting-for-choice",
        selection: "silence",
        active: null,
      },
      effects: [],
    };
  }

  const unique = findUniqueAudible(snapshot);
  if (unique) {
    next = {
      ...next,
      mode: "locked",
      selection: "selected",
      active: unique.identity,
    };
    const effects: LockEffect[] = [];
    for (const cell of snapshot.cells) {
      if (
        encodeAssignment(cell.assignment) === "U" &&
        !sameIdentity(cell.identity, unique.identity)
      ) {
        effects.push({
          type: "SET_STORE_MUTED",
          identity: cell.identity,
          value: true,
          epoch: next.epoch,
        });
      }
    }
    return { state: next, effects };
  }

  // all U, multiple false, or U+true mix without unique false → bootstrap
  return {
    state: {
      ...next,
      mode: "waiting-for-choice",
      selection: "bootstrap",
      active: null,
    },
    effects: [],
  };
}

export function transition(
  state: LockState,
  event: LockEvent,
): { state: LockState; effects: LockEffect[] } {
  const effects: LockEffect[] = [];

  switch (event.type) {
    case "ENABLE": {
      const next = {
        ...state,
        extensionEnabled: true,
        mode: state.muteOthers ? ("discovering" as const) : ("disabled" as const),
      };
      return { state: next, effects };
    }

    case "DISABLE": {
      const next = clearGrant(
        clearIntent({
          ...bumpEpoch(state),
          extensionEnabled: false,
          mode: "disabled",
          selection: "bootstrap",
          active: null,
        }),
      );
      return { state: next, effects };
    }

    case "DISCOVERED": {
      if (!state.extensionEnabled) return { state, effects };
      const next = {
        ...state,
        muteOthers: event.muteOthers,
        mode: event.muteOthers ? ("waiting-for-choice" as const) : ("disabled" as const),
      };
      return { state: next, effects };
    }

    case "CONTRACT_FAILED": {
      const already = state.reportedCodes[event.code];
      const next: LockState = {
        ...clearGrant(clearIntent(bumpEpoch(state))),
        mode: "degraded",
        active: null,
        selection: "bootstrap",
        reportedCodes: already
          ? state.reportedCodes
          : { ...state.reportedCodes, [event.code]: true },
      };
      if (!already) {
        effects.push({ type: "REPORT_ONCE", code: event.code });
      }
      return { state: next, effects };
    }

    case "STORE_SNAPSHOT": {
      if (!state.extensionEnabled) {
        return {
          state: { ...state, muteOthers: event.snapshot.muteOthers },
          effects,
        };
      }
      if (!event.snapshot.muteOthers) {
        return {
          state: clearGrant(
            clearIntent({
              ...state,
              muteOthers: false,
              mode: "disabled",
              active: null,
              selection: "bootstrap",
            }),
          ),
          effects,
        };
      }
      // If already selected/silence/bootstrap with known policy, only update muteOthers
      // and let layout events drive structural changes. Initial adoption:
      if (
        state.mode === "discovering" ||
        state.mode === "disabled" ||
        (state.mode === "waiting-for-choice" &&
          state.selection === "bootstrap" &&
          !state.active)
      ) {
        return applySnapshotSelection(
          { ...state, muteOthers: true },
          event.snapshot,
        );
      }
      return {
        state: { ...state, muteOthers: true },
        effects,
      };
    }

    case "NATIVE_FIRST_PLAY": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      if (state.mode === "degraded" || state.mode === "disabled") {
        return { state, effects };
      }
      if (state.selection === "silence" || state.selection === "selected") {
        // block unauthorized first play
        return { state, effects };
      }
      if (state.selection === "bootstrap" && !state.active) {
        const { state: next, grant } = withActive(
          state,
          event.identity,
          "selected",
          "bootstrap",
        );
        effects.push({
          type: "CALL_ORIGINAL_MUTE_OTHERS",
          identity: event.identity,
          epoch: grant.epoch,
        });
        return { state: next, effects };
      }
      return { state, effects };
    }

    case "BOOTSTRAP_READY": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      if (state.selection !== "bootstrap" || state.active) return { state, effects };
      const { state: next, grant } = withActive(
        state,
        event.identity,
        "selected",
        "bootstrap",
      );
      effects.push({
        type: "CALL_ORIGINAL_MUTE_OTHERS",
        identity: event.identity,
        epoch: grant.epoch,
      });
      return { state: next, effects };
    }

    case "EXPLICIT_SET_MUTED": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      if (event.muted) {
        if (state.active && sameIdentity(state.active, event.identity)) {
          return { state: toSilence(state), effects: [
            {
              type: "CALL_ORIGINAL_SET_MUTED",
              identity: event.identity,
              muted: true,
              epoch: state.epoch + 1,
            },
          ] };
        }
        effects.push({
          type: "CALL_ORIGINAL_SET_MUTED",
          identity: event.identity,
          muted: true,
          epoch: state.epoch,
        });
        return { state, effects };
      }
      // unmuted → select this cell
      let next = consumeToken(state);
      const chosen = withActive(next, event.identity, "selected", "explicit");
      effects.push({
        type: "CALL_ORIGINAL_SET_MUTED",
        identity: event.identity,
        muted: false,
        epoch: chosen.grant.epoch,
      });
      return { state: chosen.state, effects };
    }

    case "IFRAME_INTENT": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      const next = {
        ...state,
        intent: {
          identity: event.identity,
          source: event.source,
          expiresAt: event.now + TIMING.USER_INTENT_MS,
          consumed: false,
        },
      };
      return { state: next, effects };
    }

    case "OBSERVED_MUTED": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      if (state.mode === "degraded" || state.mode === "disabled") {
        return { state, effects };
      }

      const desired = desiredMute(state, undefined, event.identity);
      // Use assignment unknown for desired from selection only — callers pass
      // observation separately. Recompute with known assignment when silencing:
      void desired;

      if (event.muted) {
        // player reports muted
        if (
          state.selection === "selected" &&
          state.active &&
          sameIdentity(state.active, event.identity)
        ) {
          // pending grant / settle: do not silence yet
          if (
            state.selectionGrant &&
            !state.selectionGrant.consumed &&
            sameIdentity(state.selectionGrant.grant.identity, event.identity)
          ) {
            return { state, effects };
          }
          const runtime = state.cells[event.identity.key];
          if (runtime && runtime.settleUntil > event.now) {
            return { state, effects };
          }
          // active muted → silence
          return {
            state: toSilence(state),
            effects: [
              {
                type: "CALL_ORIGINAL_SET_MUTED",
                identity: event.identity,
                muted: true,
                epoch: state.epoch + 1,
              },
            ],
          };
        }
        return { state, effects };
      }

      // player reports unmuted (false)
      if (event.hasValidToken || tokenValid(state, event.identity, event.now)) {
        let next = consumeToken(state);
        const chosen = withActive(next, event.identity, "selected", "explicit");
        effects.push({
          type: "CALL_ORIGINAL_SET_MUTED",
          identity: event.identity,
          muted: false,
          epoch: chosen.grant.epoch,
        });
        return { state: chosen.state, effects };
      }

      const assignmentForDesired: MutedAssignment =
        state.selection === "bootstrap" ? false : true;
      // For desiredMute, pass the store assignment semantics from selection:
      // bootstrap U/false → unassigned; we treat unauthorized unmute as needing mute
      // only when desired is muted.
      const d = desiredMute(state, assignmentForDesired, event.identity);
      // Override: use selection-aware desired with null assignment for bootstrap check
      const d2 = desiredMute(
        state,
        state.selection === "bootstrap" ? false : undefined,
        event.identity,
      );
      // Plan: bootstrap U/false = unassigned — no MUTE_PLAYER
      // selected non-active / silence = muted → MUTE_PLAYER
      // selected active = audible → no mute
      let want: DesiredMute;
      if (
        state.mode === "disabled" ||
        state.mode === "discovering" ||
        state.mode === "degraded"
      ) {
        want = "unassigned";
      } else if (state.selection === "bootstrap") {
        // observation alone does not know assignment; controller passes via STORE
        // For pure OBSERVED with bootstrap: only mute if we somehow know desired muted.
        // Default: unassigned for false observation under bootstrap.
        want = "unassigned";
      } else if (state.selection === "silence") {
        want = "muted";
      } else if (state.active && sameIdentity(state.active, event.identity)) {
        want = "audible";
      } else {
        want = "muted";
      }
      void d;
      void d2;

      if (want === "muted") {
        effects.push({
          type: "MUTE_PLAYER",
          identity: event.identity,
          epoch: state.epoch,
        });
      }
      return { state, effects };
    }

    case "PLAYER_READY": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      if (state.selection === "selected" && state.active) {
        if (!sameIdentity(state.active, event.identity)) {
          effects.push({
            type: "SET_STORE_MUTED",
            identity: event.identity,
            value: true,
            epoch: state.epoch,
          });
          effects.push({
            type: "MUTE_PLAYER",
            identity: event.identity,
            epoch: state.epoch,
          });
        } else if (
          state.selectionGrant &&
          !state.selectionGrant.consumed &&
          sameIdentity(state.selectionGrant.grant.identity, event.identity)
        ) {
          // grant may restore after ready — controller decides after fresh read
        }
      } else if (state.selection === "silence") {
        effects.push({
          type: "SET_STORE_MUTED",
          identity: event.identity,
          value: true,
          epoch: state.epoch,
        });
        effects.push({
          type: "MUTE_PLAYER",
          identity: event.identity,
          epoch: state.epoch,
        });
      }
      return { state: ensureCell(state, event.identity.key), effects };
    }

    case "LAYOUT_CHANGED": {
      if (!state.extensionEnabled || !state.muteOthers) {
        return { state: { ...state, muteOthers: event.snapshot.muteOthers }, effects };
      }
      let next = state;
      switch (event.kind) {
        case "reorder":
          return { state, effects };
        case "add": {
          // keep active/selection; normalize new cells via PLAYER_READY
          return { state, effects };
        }
        case "remove-active":
        case "replace-active":
          return { state: toSilence(state), effects };
        case "merge-preset": {
          if (event.preservedActive) {
            next = {
              ...state,
              active: event.preservedActive,
              selection: "selected",
              mode: "locked",
            };
            return { state: clearGrant(next), effects };
          }
          // fallthrough to preset
        }
        // eslint-disable-next-line no-fallthrough
        case "preset": {
          if (state.selection === "silence") {
            return {
              state: {
                ...toSilence(state),
                selection: "silence",
                mode: "waiting-for-choice",
              },
              effects,
            };
          }
          // new bootstrap
          next = clearGrant(
            clearIntent({
              ...bumpEpoch(state),
              mode: "waiting-for-choice",
              selection: "bootstrap",
              active: null,
            }),
          );
          return applySnapshotSelection(next, event.snapshot);
        }
        default:
          return { state, effects };
      }
    }

    case "CELL_REMOVED": {
      if (state.active && identityCore(state.active) === identityCore(event.identity)) {
        return { state: toSilence(state), effects };
      }
      const { [event.identity.key]: _removed, ...rest } = state.cells;
      return { state: { ...state, cells: rest }, effects };
    }

    case "TOKEN_EXPIRED": {
      if (!state.intent) return { state, effects };
      if (state.intent.expiresAt <= event.now) {
        return { state: clearIntent(state), effects };
      }
      return { state, effects };
    }

    case "SETTLE_EXPIRED": {
      if (
        state.selection === "selected" &&
        state.active &&
        sameIdentity(state.active, event.identity) &&
        event.stillMuted
      ) {
        return {
          state: toSilence(state),
          effects: [{ type: "REPORT_ONCE", code: "restore-failed" }],
        };
      }
      return { state, effects };
    }

    case "STORE_DID_NOT_SETTLE": {
      const code = "store-did-not-settle";
      const already = state.reportedCodes[code];
      const next: LockState = {
        ...clearGrant(clearIntent(bumpEpoch(state))),
        mode: "degraded",
        reportedCodes: already
          ? state.reportedCodes
          : { ...state.reportedCodes, [code]: true },
      };
      if (!already) effects.push({ type: "REPORT_ONCE", code });
      return { state: next, effects };
    }

    default:
      return { state, effects };
  }
}

/** Poll observation helper used by tests and controller. */
export function pollObservation(
  state: LockState,
  identity: CellIdentity,
  assignment: MutedAssignment,
  playerMuted: boolean,
  now: number,
  hasValidToken = false,
): { state: LockState; effects: LockEffect[]; desired: DesiredMute } {
  const desired = desiredMute(state, assignment, identity);
  if (
    state.mode === "disabled" ||
    state.mode === "discovering" ||
    state.mode === "degraded" ||
    !state.extensionEnabled ||
    !state.muteOthers
  ) {
    return { state, effects: [], desired };
  }

  if (playerMuted) {
    const result = transition(state, {
      type: "OBSERVED_MUTED",
      now,
      identity,
      muted: true,
      hasValidToken,
    });
    return { ...result, desired };
  }

  // unmuted
  if (hasValidToken || tokenValid(state, identity, now)) {
    const result = transition(state, {
      type: "OBSERVED_MUTED",
      now,
      identity,
      muted: false,
      hasValidToken: true,
    });
    return { ...result, desired };
  }

  if (desired === "muted") {
    return {
      state,
      effects: [
        { type: "MUTE_PLAYER", identity, epoch: state.epoch },
      ],
      desired,
    };
  }

  if (desired === "audible") {
    // may restore via grant — controller handles after fresh read
    return { state, effects: [], desired };
  }

  // unassigned — no MUTE_PLAYER
  return { state, effects: [], desired };
}
