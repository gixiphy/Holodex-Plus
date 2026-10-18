import {
  type CellIdentity,
  type CellRuntime,
  type DesiredMute,
  type LayoutClassification,
  type LockEffect,
  type LockEvent,
  type LockState,
  type MutedAssignment,
  type SelectionGrant,
  type StoreCellSnapshot,
  type StoreSnapshot,
  TIMING,
  encodeAssignment,
  failuresDegrade,
  identityCore,
  sameIdentity,
} from "./contracts";

export function emptyCellRuntime(): CellRuntime {
  return {
    readInFlight: false,
    muteInFlight: false,
    lastMuteAt: 0,
    consecutiveFailures: 0,
    lastGuardMuteAt: 0,
    settleUntil: 0,
    ownMuteGeneration: null,
    lastObservedMuted: null,
    unsettledMuteCount: 0,
    lastMuteEpoch: null,
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

function patchCell(
  state: LockState,
  key: string,
  patch: Partial<CellRuntime>,
): LockState {
  const base = state.cells[key] ?? emptyCellRuntime();
  return {
    ...state,
    cells: { ...state.cells, [key]: { ...base, ...patch } },
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
  source: "bootstrap" | "explicit",
  now: number,
): { state: LockState; effects: LockEffect[]; grant: SelectionGrant } {
  let next = bumpEpoch(clearIntent(state));
  next = {
    ...next,
    mode: "locked",
    selection: "selected",
    active: identity,
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
  next = patchCell(next, identity.key, {
    settleUntil: now + TIMING.SETTLE_MS,
    lastObservedMuted: null,
  });
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

function resetFromDegraded(state: LockState): LockState {
  return {
    ...bumpEpoch(state),
    mode: "discovering",
    selection: "bootstrap",
    active: null,
    intent: null,
    selectionGrant: null,
  };
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

export function classifyLayout(
  prev: StoreSnapshot | null,
  next: StoreSnapshot,
  mutationTypes: ReadonlySet<string>,
  active: CellIdentity | null,
): LayoutClassification {
  const empty: LayoutClassification = {
    kind: "none",
    added: [],
    removed: [],
    preservedActive: null,
  };

  const nextByKey = new Map(next.cells.map((c) => [c.identity.key, c]));
  const prevByKey = new Map((prev?.cells ?? []).map((c) => [c.identity.key, c]));

  const added: CellIdentity[] = [];
  const removed: CellIdentity[] = [];
  for (const [key, cell] of nextByKey) {
    if (!prevByKey.has(key)) added.push(cell.identity);
  }
  for (const [key, cell] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(cell.identity);
  }
  // content/provider change on existing key → remove old + add new
  for (const [key, nextCell] of nextByKey) {
    const prevCell = prevByKey.get(key);
    if (!prevCell) continue;
    if (identityCore(prevCell.identity) !== identityCore(nextCell.identity)) {
      if (!removed.some((r) => r.key === key)) removed.push(prevCell.identity);
      if (!added.some((a) => a.key === key)) added.push(nextCell.identity);
    }
  }

  const isPreset =
    mutationTypes.has("multiview/setLayout") ||
    mutationTypes.has("multiview/setLayoutContent");

  if (isPreset) {
    if (active) {
      const match = next.cells.find(
        (c) => identityCore(c.identity) === identityCore(active),
      );
      if (match) {
        return {
          kind: "merge-preset",
          added,
          removed,
          preservedActive: match.identity,
        };
      }
    }
    return { kind: "preset", added, removed, preservedActive: null };
  }

  if (active) {
    const still = nextByKey.get(active.key);
    if (!still) {
      return { kind: "remove-active", added, removed, preservedActive: null };
    }
    if (identityCore(still.identity) !== identityCore(active)) {
      return { kind: "replace-active", added, removed, preservedActive: null };
    }
  }

  if (!prev) {
    if (added.length) return { kind: "add", added, removed, preservedActive: null };
    return empty;
  }

  const prevKeys = [...prevByKey.keys()].sort().join(",");
  const nextKeys = [...nextByKey.keys()].sort().join(",");
  const coresEqual =
    prev.cells.length === next.cells.length &&
    prev.cells.every((pc) => {
      const nc = nextByKey.get(pc.identity.key);
      return nc && identityCore(pc.identity) === identityCore(nc.identity);
    });

  if (prevKeys === nextKeys && coresEqual) {
    const sameOrder = prev.cells.every(
      (pc, i) => pc.identity.key === next.cells[i]?.identity.key,
    );
    if (sameOrder) return { ...empty, kind: "none" };
    return { kind: "reorder", added: [], removed: [], preservedActive: null };
  }

  if (added.length && removed.length === 0) {
    return { kind: "add", added, removed, preservedActive: null };
  }

  if (added.length || removed.length) {
    return { kind: "add", added, removed, preservedActive: null };
  }

  return empty;
}

export function storeConverged(
  snapshot: StoreSnapshot,
  active: CellIdentity | null,
  pendingKeys: ReadonlySet<string>,
): boolean {
  if (!active) return false;
  const activeCell = snapshot.cells.find((c) => sameIdentity(c.identity, active));
  if (!activeCell || activeCell.assignment !== false) return false;
  for (const cell of snapshot.cells) {
    if (sameIdentity(cell.identity, active)) continue;
    if (pendingKeys.has(cell.identity.key)) {
      if (cell.assignment !== undefined && cell.assignment !== true) return false;
      continue;
    }
    if (cell.assignment !== true) return false;
  }
  return true;
}

export function transition(
  state: LockState,
  event: LockEvent,
): { state: LockState; effects: LockEffect[] } {
  const effects: LockEffect[] = [];

  switch (event.type) {
    case "ENABLE": {
      // Idempotent when already enabled — do not bounce live sessions into discovering.
      if (state.extensionEnabled === true) {
        return { state, effects: [] };
      }
      let next = {
        ...state,
        extensionEnabled: true,
      };
      if (state.mode === "degraded") {
        next = {
          ...resetFromDegraded(next),
          extensionEnabled: true,
          muteOthers: state.muteOthers,
        };
      } else {
        next = {
          ...next,
          mode: state.muteOthers ? ("discovering" as const) : ("disabled" as const),
        };
      }
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

    case "RESET_DEGRADED": {
      if (state.mode !== "degraded") return { state, effects };
      return { state: resetFromDegraded(state), effects };
    }

    case "DISCOVERED": {
      if (!state.extensionEnabled) return { state, effects };
      if (state.mode === "degraded") return { state, effects };
      if (state.mode === "locked") {
        return {
          state: { ...state, muteOthers: event.muteOthers },
          effects,
        };
      }
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
        return { state, effects };
      }
      if (state.selection === "bootstrap" && !state.active) {
        const { state: next, grant } = withActive(
          state,
          event.identity,
          "bootstrap",
          event.now,
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
        "bootstrap",
        event.now,
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
        effects.push({
          type: "CALL_ORIGINAL_SET_MUTED",
          identity: event.identity,
          muted: true,
          epoch: state.epoch,
        });
        return { state, effects };
      }
      const next = consumeToken(state);
      const chosen = withActive(next, event.identity, "explicit", event.now);
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

    case "MUTE_SENT": {
      const runtime = state.cells[event.identity.key] ?? emptyCellRuntime();
      if (event.ok === false) {
        return {
          state: patchCell(state, event.identity.key, {
            lastMuteAt: event.now,
          }),
          effects,
        };
      }
      return {
        state: patchCell(state, event.identity.key, {
          lastMuteAt: event.now,
          settleUntil: event.now + TIMING.SETTLE_MS,
          ownMuteGeneration: event.identity.generation,
          unsettledMuteCount: runtime.unsettledMuteCount + 1,
          lastMuteEpoch: state.epoch,
        }),
        effects,
      };
    }

    case "UNTRUSTED_POLL": {
      if (!state.extensionEnabled || !state.muteOthers) {
        return { state, effects };
      }
      if (state.mode === "degraded" || state.mode === "disabled") {
        return { state, effects };
      }
      const want = desiredMute(state, event.assignment, event.identity);
      if (want !== "muted") return { state, effects };
      const runtime = state.cells[event.identity.key] ?? emptyCellRuntime();
      if (runtime.lastMuteEpoch === state.epoch) return { state, effects };
      effects.push({
        type: "MUTE_PLAYER",
        identity: event.identity,
        epoch: state.epoch,
      });
      return { state, effects };
    }

    case "OBSERVED_MUTED": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      if (state.mode === "degraded" || state.mode === "disabled") {
        return { state, effects };
      }

      const key = event.identity.key;
      let next = ensureCell(state, key);
      const prev = next.cells[key]?.lastObservedMuted ?? null;
      const unsettledPatch: Partial<CellRuntime> = {
        lastObservedMuted: event.muted,
      };
      if (event.muted === true) {
        unsettledPatch.unsettledMuteCount = 0;
      }
      next = patchCell(next, key, unsettledPatch);
      const runtime = next.cells[key]!;

      if (event.muted === true) {
        // bootstrap: observation only
        if (next.selection === "bootstrap") {
          return { state: next, effects };
        }
        if (
          next.selection === "selected" &&
          next.active &&
          sameIdentity(next.active, event.identity)
        ) {
          const hasGrant =
            next.selectionGrant &&
            !next.selectionGrant.consumed &&
            sameIdentity(next.selectionGrant.grant.identity, event.identity);
          if (hasGrant || runtime.settleUntil > event.now) {
            return { state: next, effects };
          }
          return {
            state: toSilence(next),
            effects: [
              {
                type: "CALL_ORIGINAL_SET_MUTED",
                identity: event.identity,
                muted: true,
                epoch: next.epoch + 1,
              },
            ],
          };
        }
        return { state: next, effects };
      }

      // muted === false
      if (
        tokenValid(next, event.identity, event.now) &&
        prev === true &&
        runtime.settleUntil <= event.now
      ) {
        const consumed = consumeToken(next);
        const chosen = withActive(consumed, event.identity, "explicit", event.now);
        effects.push({
          type: "CALL_ORIGINAL_SET_MUTED",
          identity: event.identity,
          muted: false,
          epoch: chosen.grant.epoch,
        });
        return { state: chosen.state, effects };
      }

      const want = desiredMute(next, event.assignment, event.identity);
      if (want === "muted") {
        if (runtime.settleUntil > event.now) {
          return { state: next, effects };
        }
        if (
          failuresDegrade(event.identity) &&
          runtime.unsettledMuteCount >= TIMING.MAX_CONSECUTIVE_FAILURES
        ) {
          const code = "player-mute-did-not-settle";
          const already = next.reportedCodes[code];
          const degraded: LockState = {
            ...clearGrant(clearIntent(bumpEpoch(next))),
            mode: "degraded",
            active: null,
            selection: "bootstrap",
            reportedCodes: already
              ? next.reportedCodes
              : { ...next.reportedCodes, [code]: true },
          };
          if (!already) {
            effects.push({ type: "REPORT_ONCE", code });
          }
          return { state: degraded, effects };
        }
        effects.push({
          type: "MUTE_PLAYER",
          identity: event.identity,
          epoch: next.epoch,
        });
      }
      return { state: next, effects };
    }

    case "PLAYER_READY": {
      if (!state.extensionEnabled || !state.muteOthers) return { state, effects };
      const next = {
        ...state,
        cells: {
          ...state.cells,
          [event.identity.key]: emptyCellRuntime(),
        },
      };
      if (state.selection === "selected" && state.active) {
        if (!sameIdentity(state.active, event.identity)) {
          if (event.assignment !== true) {
            effects.push({
              type: "SET_STORE_MUTED",
              identity: event.identity,
              value: true,
              epoch: next.epoch,
            });
          }
        }
      } else if (state.selection === "silence") {
        if (event.assignment !== true) {
          effects.push({
            type: "SET_STORE_MUTED",
            identity: event.identity,
            value: true,
            epoch: next.epoch,
          });
        }
      }
      return { state: next, effects };
    }

    case "LAYOUT_CHANGED": {
      if (!state.extensionEnabled || !state.muteOthers) {
        return { state: { ...state, muteOthers: event.snapshot.muteOthers }, effects };
      }
      let next = state;
      switch (event.kind) {
        case "reorder":
          return { state, effects };
        case "add":
          return { state, effects };
        case "remove-active":
        case "replace-active":
          return { state: toSilence(state), effects };
        case "merge-preset": {
          if (event.preservedActive) {
            next = clearGrant({
              ...bumpEpoch(state),
              active: event.preservedActive,
              selection: "selected",
              mode: "locked",
            });
            return { state: next, effects };
          }
          // fallthrough
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
      const rest = { ...state.cells };
      delete rest[event.identity.key];
      return { state: { ...state, cells: rest }, effects };
    }

    case "BINDING_REBOUND": {
      if (!state.extensionEnabled) return { state, effects: [] };
      let next: LockState = {
        ...state,
        cells: {
          ...state.cells,
          [event.identity.key]: emptyCellRuntime(),
        },
      };
      const active = state.active;
      const canReplace =
        active !== null &&
        active.key === event.identity.key &&
        active.contentId === event.identity.contentId &&
        !sameIdentity(active, event.identity) &&
        sameIdentity(active, event.previous) &&
        (event.reason === "late-bind" ||
          identityCore(event.previous) === identityCore(event.identity));
      if (!canReplace) {
        return { state: next, effects: [] };
      }
      next = bumpEpoch(next);
      next = { ...next, active: event.identity };
      if (next.selectionGrant?.grant.identity.key === event.identity.key) {
        next = { ...next, selectionGrant: null };
      }
      if (next.intent?.identity.key === event.identity.key) {
        next = { ...next, intent: null };
      }
      return { state: next, effects: [] };
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

  const result = transition(state, {
    type: "OBSERVED_MUTED",
    now,
    identity,
    muted: playerMuted,
    assignment,
    origin: "poll",
  });
  return { ...result, desired };
}
