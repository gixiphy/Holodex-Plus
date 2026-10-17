import type {
  AudioLockHandle,
  CellIdentity,
  LockEffect,
  LockState,
  StoreSnapshot,
} from "./contracts";
import { TIMING, failuresDegrade, identityCore, sameIdentity } from "./contracts";
import {
  createHolodexAdapter,
  type CellBinding,
  type HolodexAdapter,
} from "./holodex-adapter";
import {
  createPlayerPort,
  type BoundPlayerPort,
  type PlayerBinding,
} from "./players";
import {
  classifyLayout,
  createInitialState,
  emptyCellRuntime,
  pollObservation,
  storeConverged,
  transition,
} from "./state";

export type ControllerDeps = {
  window: Window;
  document: Document;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  requestAnimationFrame?: typeof requestAnimationFrame;
  isTrusted?: (event: Event) => boolean;
};

type PanelGate = {
  event: Event | null;
  trusted: boolean;
};

const panelGate: PanelGate = { event: null, trusted: false };
let panelClearTimer: ReturnType<typeof setTimeout> | null = null;

export function beginPanelDispatch(event: Event, trusted: boolean): void {
  panelGate.event = event;
  panelGate.trusted = trusted;
}

export function endPanelDispatch(event: Event): void {
  if (panelGate.event === event) {
    panelGate.event = null;
    panelGate.trusted = false;
  }
}

export function hasPanelDispatch(): boolean {
  if (!panelGate.event || !panelGate.trusted) return false;
  if (panelGate.event.eventPhase === Event.NONE) {
    panelGate.event = null;
    panelGate.trusted = false;
    return false;
  }
  return true;
}

function clearPanelIfSameScope(scopeEvent: Event): void {
  if (panelGate.event === scopeEvent) {
    panelGate.event = null;
    panelGate.trusted = false;
  }
}

type Session = {
  stopObserver: () => void;
  stopStore: () => void;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  rafHandle: number | null;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  settleTimers: Map<string, ReturnType<typeof setTimeout>>;
  storeSettleTimer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  store: unknown;
  observeTarget: Element;
};

export function createAudioLockController(deps: ControllerDeps): AudioLockHandle {
  const win = deps.window;
  const doc = deps.document;
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.setTimeout ?? setTimeout.bind(win);
  const cancel = deps.clearTimeout ?? clearTimeout.bind(win);
  const raf =
    deps.requestAnimationFrame ??
    ((fn: FrameRequestCallback) => {
      if (typeof win.requestAnimationFrame === "function") {
        return win.requestAnimationFrame(fn);
      }
      return schedule(() => fn(now()), 16) as unknown as number;
    });
  const cancelRaf =
    typeof win.cancelAnimationFrame === "function"
      ? win.cancelAnimationFrame.bind(win)
      : (h: number) => cancel(h as unknown as ReturnType<typeof setTimeout>);
  const eventTrusted = deps.isTrusted ?? ((e: Event) => e.isTrusted);

  let state: LockState = createInitialState();
  let disposed = false;
  let enabled = false;
  let adapter: HolodexAdapter | null = null;
  const ports = new Map<string, { identity: CellIdentity; port: BoundPlayerPort }>();
  const unpatches = new Map<string, { cell: object; unpatch: () => void }>();
  const lastBindings = new Map<string, CellBinding>();
  const disposers: Array<() => void> = [];
  const inFlightReads = new Map<string, Promise<void>>();
  const pausedByKey = new Map<string, boolean>();
  const firstPlayDepth = { value: 0 };
  const authDepth = { value: 0 };
  const authScope = { mappedMuteOthers: 0 };
  let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let discoveryStarted = 0;
  let session: Session | null = null;
  let prevSnapshot: StoreSnapshot | null = null;
  const pendingMutationTypes = new Set<string>();
  let layoutCoalesceQueued = false;
  let leftMultiview = false;
  let storeSettleTarget: CellIdentity | null = null;
  let storeSettleEpoch = 0;
  let bootstrapFallbackStarted = 0;
  let routeTimer: ReturnType<typeof setTimeout> | null = null;

  const currentAssignment = (key: string) => {
    const binding = lastBindings.get(key);
    return (binding?.cell as { muted?: boolean | undefined } | undefined)?.muted;
  };

  const failSession = (code: string) => {
    const result = transition(state, {
      type: "CONTRACT_FAILED",
      now: now(),
      code,
    });
    state = result.state;
    void applyEffects(result.effects);
    teardownSession();
    if (discoveryTimer) {
      cancel(discoveryTimer);
      discoveryTimer = null;
    }
  };

  const cancelStoreSettle = () => {
    if (session?.storeSettleTimer) {
      cancel(session.storeSettleTimer);
      session.storeSettleTimer = null;
    }
    storeSettleTarget = null;
  };

  const armStoreSettle = (active: CellIdentity | null) => {
    if (!session || !active) return;
    cancelStoreSettle();
    storeSettleTarget = active;
    storeSettleEpoch = state.epoch;
    session.storeSettleTimer = schedule(() => {
      if (!session) return;
      session.storeSettleTimer = null;
      if (
        state.active &&
        sameIdentity(state.active, storeSettleTarget) &&
        state.epoch === storeSettleEpoch
      ) {
        const result = transition(state, {
          type: "STORE_DID_NOT_SETTLE",
          now: now(),
        });
        state = result.state;
        void applyEffects(result.effects);
      }
    }, TIMING.STORE_SETTLE_MS);
  };

  const armSelectionSettle = (identity: CellIdentity) => {
    if (!session) return;
    const prev = session.settleTimers.get(identity.key);
    if (prev) cancel(prev);
    const epoch = state.epoch;
    const timer = schedule(async () => {
      session?.settleTimers.delete(identity.key);
      if (!sameIdentity(state.active, identity) || state.epoch !== epoch) return;
      const entry = ports.get(identity.key);
      if (!entry || !sameIdentity(entry.identity, identity)) return;
      const read = await entry.port.readMuted();
      if (read.kind !== "known") return;
      if (!sameIdentity(state.active, identity) || state.epoch !== epoch) return;
      const result = transition(state, {
        type: "SETTLE_EXPIRED",
        now: now(),
        identity,
        stillMuted: read.muted,
      });
      state = result.state;
      await applyEffects(result.effects);
    }, TIMING.SETTLE_MS);
    session.settleTimers.set(identity.key, timer);
  };

  const onActiveChanged = (prevActive: CellIdentity | null) => {
    if (
      state.selection === "selected" &&
      state.active &&
      !sameIdentity(prevActive, state.active)
    ) {
      armStoreSettle(state.active);
      armSelectionSettle(state.active);
    }
    if (state.selection === "silence" || state.mode === "disabled") {
      cancelStoreSettle();
    }
  };

  const applyEffects = async (effects: LockEffect[]): Promise<void> => {
    const prevActive = state.active;
    for (const effect of effects) {
      if (disposed || !enabled) return;
      if (state.mode === "disabled" || state.mode === "degraded") {
        if (effect.type !== "REPORT_ONCE") continue;
      }
      switch (effect.type) {
        case "REPORT_ONCE":
          try {
            console.warn("[Holodex+ AudioLock]", {
              code: effect.code,
              adapterVersion: 1,
            });
          } catch {
            /* ignore */
          }
          break;
        case "MUTE_PLAYER": {
          if (effect.epoch !== state.epoch) break;
          const entry = ports.get(effect.identity.key);
          if (!entry || !sameIdentity(entry.identity, effect.identity)) break;
          const runtime = state.cells[effect.identity.key] ?? emptyCellRuntime();
          const t = now();
          if (runtime.muteInFlight) break;
          if (t < runtime.lastMuteAt + TIMING.MUTE_COOLDOWN_MS) break;
          if (t < runtime.settleUntil) break;
          state = {
            ...state,
            cells: {
              ...state.cells,
              [effect.identity.key]: { ...runtime, muteInFlight: true },
            },
          };
          try {
            const ok = await entry.port.mute();
            const sent = transition(state, {
              type: "MUTE_SENT",
              now: now(),
              identity: effect.identity,
              ok,
            });
            state = sent.state;
            if (!ok && failuresDegrade(effect.identity)) {
              const key = effect.identity.key;
              const prev = state.cells[key]?.consecutiveFailures ?? 0;
              const failures = prev + 1;
              state = {
                ...state,
                cells: {
                  ...state.cells,
                  [key]: {
                    ...(state.cells[key] ?? emptyCellRuntime()),
                    consecutiveFailures: failures,
                  },
                },
              };
              if (failures >= TIMING.MAX_CONSECUTIVE_FAILURES) {
                failSession("player-unavailable");
              }
            }
          } finally {
            const rt = state.cells[effect.identity.key];
            if (rt) {
              state = {
                ...state,
                cells: {
                  ...state.cells,
                  [effect.identity.key]: { ...rt, muteInFlight: false },
                },
              };
            }
          }
          break;
        }
        case "SET_STORE_MUTED": {
          if (effect.epoch !== state.epoch) break;
          adapter?.setStoreMuted(effect.identity, true);
          break;
        }
        case "CALL_ORIGINAL_MUTE_OTHERS": {
          if (effect.epoch !== state.epoch) break;
          const binding = lastBindings.get(effect.identity.key);
          if (!binding) break;
          authDepth.value += 1;
          try {
            const cell = binding.cell as {
              muteOthers: (id: string | number) => void;
              item: { i: string | number };
            };
            cell.muteOthers(cell.item.i);
          } finally {
            authDepth.value -= 1;
          }
          if (state.active && sameIdentity(state.active, effect.identity)) {
            armStoreSettle(state.active);
            armSelectionSettle(state.active);
          }
          void maybeRestoreGrant(effect.identity);
          break;
        }
        case "CALL_ORIGINAL_SET_MUTED": {
          if (effect.epoch !== state.epoch) break;
          const binding = lastBindings.get(effect.identity.key);
          if (!binding) break;
          authDepth.value += 1;
          const before = authScope.mappedMuteOthers;
          try {
            const cell = binding.cell as {
              setMuted: (v: boolean) => void;
              muteOthers: (id: string | number) => void;
              item: { i: string | number };
            };
            cell.setMuted(effect.muted);
            if (
              effect.muted === false &&
              authScope.mappedMuteOthers === before &&
              state.active &&
              sameIdentity(state.active, effect.identity)
            ) {
              cell.muteOthers(cell.item.i);
            }
          } finally {
            authDepth.value -= 1;
          }
          if (
            effect.muted === false &&
            state.active &&
            sameIdentity(state.active, effect.identity)
          ) {
            armStoreSettle(state.active);
            armSelectionSettle(state.active);
          }
          void maybeRestoreGrant(effect.identity);
          break;
        }
        case "RESTORE_SELECTED_AUDIO": {
          void restoreGrant(effect.grant);
          break;
        }
        default:
          break;
      }
    }
    onActiveChanged(prevActive);
    if (state.mode === "degraded") {
      teardownSession();
      if (discoveryTimer) {
        cancel(discoveryTimer);
        discoveryTimer = null;
      }
    }
  };

  const restoreGrant = async (
    grant: { identity: CellIdentity; epoch: number; source: "bootstrap" | "explicit" },
  ) => {
    const entry = ports.get(grant.identity.key);
    if (!entry || !sameIdentity(entry.identity, grant.identity)) return;
    if (!state.selectionGrant || state.selectionGrant.consumed) return;
    if (state.selectionGrant.grant.epoch !== grant.epoch) return;
    await entry.port.restoreSelectedAudio(grant);
    if (
      state.selectionGrant &&
      state.selectionGrant.grant.epoch === grant.epoch &&
      !state.selectionGrant.consumed
    ) {
      state = {
        ...state,
        selectionGrant: { ...state.selectionGrant, consumed: true },
      };
    }
  };

  const maybeRestoreGrant = (identity: CellIdentity) => {
    schedule(async () => {
      if (!state.selectionGrant || state.selectionGrant.consumed) return;
      if (!sameIdentity(state.selectionGrant.grant.identity, identity)) return;
      if (!sameIdentity(state.active, identity)) return;
      const entry = ports.get(identity.key);
      if (!entry) return;
      const read = await entry.port.readMuted();
      if (read.kind === "unavailable" && read.reason === "untrusted") {
        await restoreGrant(state.selectionGrant.grant);
        return;
      }
      if (read.kind !== "known") return;
      if (!sameIdentity(state.active, identity)) return;
      if (!state.selectionGrant || state.selectionGrant.consumed) return;
      if (read.muted) {
        await restoreGrant(state.selectionGrant.grant);
      } else {
        state = {
          ...state,
          selectionGrant: { ...state.selectionGrant, consumed: true },
        };
      }
    }, 0);
  };

  const cancelFallback = () => {
    if (session?.fallbackTimer) {
      cancel(session.fallbackTimer);
      session.fallbackTimer = null;
    }
  };

  const hasNonTwitchBinding = (): boolean => {
    for (const binding of lastBindings.values()) {
      if (binding.identity.provider !== "twitch") return true;
    }
    return false;
  };

  const armBootstrapFallback = () => {
    if (!session) return;
    if (state.selection !== "bootstrap" || state.active) {
      cancelFallback();
      return;
    }
    if (session.fallbackTimer) return;
    if (!bootstrapFallbackStarted) bootstrapFallbackStarted = now();
    if (now() - bootstrapFallbackStarted > TIMING.BOOTSTRAP_WAIT_MS) return;
    session.fallbackTimer = schedule(() => {
      if (!session) return;
      session.fallbackTimer = null;
      if (state.selection !== "bootstrap" || state.active) return;
      if (now() - bootstrapFallbackStarted > TIMING.BOOTSTRAP_WAIT_MS) return;
      const snapshot = adapter?.buildSnapshot();
      if (!snapshot) {
        armBootstrapFallback();
        return;
      }
      for (const cell of snapshot.cells) {
        if (cell.assignment === true) continue;
        const binding = lastBindings.get(cell.identity.key);
        if (!binding) continue;
        if (
          cell.identity.provider === "twitch" &&
          hasNonTwitchBinding()
        ) {
          continue;
        }
        const vm = binding.cell as {
          editMode?: boolean;
          firstPlay?: boolean;
        };
        if (vm.editMode === true) continue;
        const entry = ports.get(cell.identity.key);
        if (!entry?.port.isBound()) continue;
        const paused = pausedByKey.get(cell.identity.key);
        const playing =
          paused === false ||
          (paused === undefined && vm.firstPlay === false);
        if (!playing) continue;
        const result = transition(state, {
          type: "BOOTSTRAP_READY",
          now: now(),
          identity: cell.identity,
        });
        state = result.state;
        void applyEffects(result.effects);
        cancelFallback();
        return;
      }
      armBootstrapFallback();
    }, TIMING.BOOTSTRAP_FALLBACK_MS);
  };

  const ensurePort = (binding: CellBinding) => {
    if (!binding.playerComponent) return;
    const key = binding.identity.key;
    const existing = ports.get(key);
    if (existing && sameIdentity(existing.identity, binding.identity)) {
      return;
    }
    if (existing) {
      existing.port.dispose();
      ports.delete(key);
    }
    const playerBinding: PlayerBinding = {
      identity: binding.identity,
      cell: binding.cell as PlayerBinding["cell"],
      playerComponent: binding.playerComponent as PlayerBinding["playerComponent"],
      provider: binding.provider,
      onReady: () => {
        const current = lastBindings.get(key);
        if (!current || !sameIdentity(current.identity, binding.identity)) return;
        const result = transition(state, {
          type: "PLAYER_READY",
          now: now(),
          identity: binding.identity,
          assignment: currentAssignment(key),
        });
        state = result.state;
        void applyEffects(result.effects).then(() => {
          void reconcileCell(binding.identity);
          if (state.selection === "bootstrap" && !state.active) {
            armBootstrapFallback();
          }
          if (
            state.selectionGrant &&
            !state.selectionGrant.consumed &&
            sameIdentity(state.selectionGrant.grant.identity, binding.identity)
          ) {
            maybeRestoreGrant(binding.identity);
          }
        });
      },
      onContractMismatch: () => {
        const current = lastBindings.get(key);
        if (!current || !sameIdentity(current.identity, binding.identity)) return;
        if (!failuresDegrade(binding.identity)) {
          if (!state.reportedCodes["twitch-sdk-contract-changed"]) {
            state = {
              ...state,
              reportedCodes: {
                ...state.reportedCodes,
                "twitch-sdk-contract-changed": true,
              },
            };
            try {
              console.warn("[Holodex+ AudioLock]", {
                code: "twitch-sdk-contract-changed",
                adapterVersion: 1,
              });
            } catch {
              /* ignore */
            }
          }
          return;
        }
        failSession("cell-contract-changed");
      },
    };
    const port = createPlayerPort(playerBinding);
    if (port) ports.set(key, { identity: binding.identity, port });
  };

  const reconcileCell = async (identity: CellIdentity): Promise<void> => {
    const key = identity.key;
    if (inFlightReads.has(key)) return;
    const run = (async () => {
      const t = now();
      const entry = ports.get(key);
      if (!entry || !sameIdentity(entry.identity, identity)) return;
      if (state.mode === "degraded" || !enabled) return;
      const read = await entry.port.readMuted();
      if (!sameIdentity(lastBindings.get(key)?.identity ?? null, identity)) return;
      if (!enabled || state.mode === ("degraded" as LockState["mode"])) return;

      if (read.kind === "unavailable") {
        if (read.reason === "not-ready") return;
        if (read.reason === "untrusted") {
          const result = transition(state, {
            type: "UNTRUSTED_POLL",
            now: t,
            identity,
            assignment: currentAssignment(key),
          });
          state = result.state;
          await applyEffects(result.effects);
          return;
        }
        if (!failuresDegrade(identity)) return;
        const prev = state.cells[key]?.consecutiveFailures ?? 0;
        const failures = prev + 1;
        state = {
          ...state,
          cells: {
            ...state.cells,
            [key]: {
              ...(state.cells[key] ?? emptyCellRuntime()),
              consecutiveFailures: failures,
            },
          },
        };
        if (failures >= TIMING.MAX_CONSECUTIVE_FAILURES) {
          failSession("player-unavailable");
        }
        return;
      }

      state = {
        ...state,
        cells: {
          ...state.cells,
          [key]: {
            ...(state.cells[key] ?? emptyCellRuntime()),
            consecutiveFailures: 0,
          },
        },
      };

      const result = pollObservation(
        state,
        identity,
        currentAssignment(key),
        read.muted,
        t,
      );
      state = result.state;
      await applyEffects(result.effects);
    })();

    inFlightReads.set(key, run);
    try {
      await run;
    } finally {
      inFlightReads.delete(key);
    }
  };

  const installBinding = (binding: CellBinding) => {
    const key = binding.identity.key;
    lastBindings.set(key, binding);
    ensurePort(binding);

    const existing = unpatches.get(key);
    if (existing && existing.cell === binding.cell) {
      return;
    }
    if (existing) {
      existing.unpatch();
      unpatches.delete(key);
    }

    const cell = binding.cell as Record<string, unknown>;
    const originalCheck = cell.manualCheckMuted as () => unknown;
    const originalSetMuted = cell.setMuted as (v: boolean) => unknown;
    const originalMuteOthers = cell.muteOthers as (id: string | number) => unknown;
    const originalUpdate = cell.updatePausedState as (p?: boolean) => unknown;

    const unpatch = adapter!.patchCell(binding, {
      manualCheckMuted() {
        const identity = lastBindings.get(key)?.identity;
        if (!identity) return originalCheck.call(cell);
        if (!enabled || !state.muteOthers || state.mode === "degraded") {
          return originalCheck.call(cell);
        }
        return reconcileCell(identity);
      },
      setMuted(value: boolean) {
        const identity = lastBindings.get(key)?.identity;
        if (!identity) return originalSetMuted.call(cell, value);
        if (authDepth.value > 0) {
          return originalSetMuted.call(cell, value);
        }
        if (!enabled || !state.muteOthers || state.mode === "degraded") {
          return originalSetMuted.call(cell, value);
        }
        if (hasPanelDispatch()) {
          const result = transition(state, {
            type: "EXPLICIT_SET_MUTED",
            now: now(),
            identity,
            muted: value,
          });
          state = result.state;
          void applyEffects(result.effects);
          if (!value) cancelFallback();
          return;
        }
        const result = transition(state, {
          type: "OBSERVED_MUTED",
          now: now(),
          identity,
          muted: value,
          assignment: currentAssignment(key),
          origin: "refresh",
        });
        state = result.state;
        void applyEffects(result.effects);
      },
      muteOthers(id: string | number) {
        const identity = lastBindings.get(key)?.identity;
        if (!identity) return originalMuteOthers.call(cell, id);
        if (authDepth.value > 0) {
          authScope.mappedMuteOthers += 1;
          return originalMuteOthers.call(cell, id);
        }
        if (!enabled || !state.muteOthers || state.mode === "degraded") {
          return originalMuteOthers.call(cell, id);
        }
        if (String(id) !== identity.key) return;
        if (
          firstPlayDepth.value > 0 &&
          state.selection === "bootstrap" &&
          !state.active
        ) {
          if (identity.provider === "twitch" && hasNonTwitchBinding()) {
            return;
          }
          const result = transition(state, {
            type: "NATIVE_FIRST_PLAY",
            now: now(),
            identity,
          });
          state = result.state;
          void applyEffects(result.effects);
          cancelFallback();
          return;
        }
        if (state.selection === "selected" || state.selection === "silence") {
          return;
        }
        if (state.selection === "bootstrap" && !state.active) {
          if (identity.provider === "twitch" && hasNonTwitchBinding()) {
            return;
          }
          const result = transition(state, {
            type: "NATIVE_FIRST_PLAY",
            now: now(),
            identity,
          });
          state = result.state;
          void applyEffects(result.effects);
          cancelFallback();
          return;
        }
        return originalMuteOthers.call(cell, id);
      },
      updatePausedState(paused = false) {
        const identity = lastBindings.get(key)?.identity;
        if (!identity) return originalUpdate.call(cell, paused);
        pausedByKey.set(key, paused);
        const entering =
          (cell.firstPlay === true || cell.firstPlay === undefined) &&
          !paused &&
          cell.editMode !== paused;
        if (entering) firstPlayDepth.value += 1;
        try {
          return originalUpdate.call(cell, paused);
        } finally {
          if (entering) firstPlayDepth.value -= 1;
          if (
            paused === false &&
            state.selection === "bootstrap" &&
            !state.active
          ) {
            armBootstrapFallback();
          }
        }
      },
    });
    unpatches.set(key, { cell: binding.cell as object, unpatch });
  };

  const syncBindings = (next: CellBinding[]) => {
    const nextMap = new Map(next.map((b) => [b.identity.key, b]));
    for (const [key, old] of [...lastBindings.entries()]) {
      const neu = nextMap.get(key);
      if (!neu) {
        const up = unpatches.get(key);
        up?.unpatch();
        unpatches.delete(key);
        ports.get(key)?.port.dispose();
        ports.delete(key);
        inFlightReads.delete(key);
        if (session?.settleTimers.has(key)) {
          cancel(session.settleTimers.get(key)!);
          session.settleTimers.delete(key);
        }
        const result = transition(state, {
          type: "CELL_REMOVED",
          now: now(),
          identity: old.identity,
        });
        state = result.state;
        void applyEffects(result.effects);
        lastBindings.delete(key);
        pausedByKey.delete(key);
        continue;
      }
      if (sameIdentity(old.identity, neu.identity)) {
        lastBindings.set(key, neu);
        if (!ports.has(key) && neu.playerComponent) ensurePort(neu);
        continue;
      }
      // identity changed
      ports.get(key)?.port.dispose();
      ports.delete(key);
      inFlightReads.delete(key);
      if (session?.settleTimers.has(key)) {
        cancel(session.settleTimers.get(key)!);
        session.settleTimers.delete(key);
      }
      if (old.cell !== neu.cell) {
        unpatches.get(key)?.unpatch();
        unpatches.delete(key);
      }
      if (identityCore(old.identity) === identityCore(neu.identity)) {
        const rebound = transition(state, {
          type: "BINDING_REBOUND",
          now: now(),
          previous: old.identity,
          identity: neu.identity,
          reason: "remount",
        });
        state = rebound.state;
        void applyEffects(rebound.effects);
        if (storeSettleTarget && sameIdentity(storeSettleTarget, old.identity)) {
          storeSettleTarget = neu.identity;
          storeSettleEpoch = state.epoch;
        }
      } else {
        const removed = transition(state, {
          type: "CELL_REMOVED",
          now: now(),
          identity: old.identity,
        });
        state = removed.state;
        void applyEffects(removed.effects);
      }
      installBinding(neu);
    }
    for (const [key, neu] of nextMap) {
      if (!lastBindings.has(key)) installBinding(neu);
    }
    reboundActive();
    if (adapter) checkStoreSettle(adapter.buildSnapshot());
  };

  const reboundActive = (): void => {
    if (!state.active) return;
    for (const binding of lastBindings.values()) {
      if (sameIdentity(binding.identity, state.active)) return;
    }
    const binding = lastBindings.get(state.active.key);
    if (!binding || binding.identity.contentId !== state.active.contentId) {
      return;
    }
    const previous = state.active;
    const result = transition(state, {
      type: "BINDING_REBOUND",
      now: now(),
      previous,
      identity: binding.identity,
      reason: "late-bind",
    });
    state = result.state;
    void applyEffects(result.effects);
    if (storeSettleTarget && sameIdentity(storeSettleTarget, previous)) {
      storeSettleTarget = state.active;
      storeSettleEpoch = state.epoch;
    }
  };

  const checkStoreSettle = (snapshot: StoreSnapshot) => {
    if (!storeSettleTarget || !session?.storeSettleTimer) return;
    const pendingKeys = new Set<string>();
    for (const [key, b] of lastBindings) {
      if (!ports.get(key)?.port.isBound() || b.pendingPort) pendingKeys.add(key);
    }
    if (storeConverged(snapshot, storeSettleTarget, pendingKeys)) {
      cancelStoreSettle();
    }
  };

  const processLayout = () => {
    layoutCoalesceQueued = false;
    if (!adapter || !session || state.mode === "degraded") {
      pendingMutationTypes.clear();
      return;
    }
    const snapshot = adapter.buildSnapshot();
    const mutations = new Set(pendingMutationTypes);
    pendingMutationTypes.clear();
    const cls = classifyLayout(
      prevSnapshot,
      snapshot,
      mutations,
      state.active,
    );
    if (cls.kind !== "none") {
      const layout = transition(state, {
        type: "LAYOUT_CHANGED",
        now: now(),
        kind: cls.kind,
        snapshot,
        preservedActive: cls.preservedActive,
      });
      state = layout.state;
      void applyEffects(layout.effects);
      for (const rem of cls.removed) {
        if (state.active && sameIdentity(state.active, rem)) continue;
        const r = transition(state, {
          type: "CELL_REMOVED",
          now: now(),
          identity: rem,
        });
        state = r.state;
        void applyEffects(r.effects);
      }
    }
    const snap = transition(state, {
      type: "STORE_SNAPSHOT",
      now: now(),
      snapshot,
    });
    state = snap.state;
    void applyEffects(snap.effects);
    reboundActive();
    checkStoreSettle(snapshot);
    prevSnapshot = snapshot;
  };

  const scheduleProcessLayout = () => {
    if (!session || layoutCoalesceQueued) return;
    layoutCoalesceQueued = true;
    session.coalesceTimer = schedule(() => {
      if (session) session.coalesceTimer = null;
      processLayout();
    }, 0);
  };

  const rescan = () => {
    if (!enabled || disposed || state.mode === "degraded" || !session) return;
    if (!adapter) return;
    const found = adapter.discover();
    if (!found.ok) {
      if (found.code !== "root-timeout") failSession(found.code);
      return;
    }
    if (found.store !== session.store || found.observeTarget !== session.observeTarget) {
      teardownSession();
      startDiscoveryLoop();
      return;
    }
    syncBindings(found.bindings);
  };

  const scheduleRescan = () => {
    if (!session) return;
    if (session.rafHandle != null) return;
    session.rafHandle = raf(() => {
      if (session) session.rafHandle = null;
      rescan();
    }) as unknown as number;
  };

  const teardownSession = () => {
    if (!session) {
      for (const [, up] of unpatches) up.unpatch();
      unpatches.clear();
      for (const [, entry] of ports) entry.port.dispose();
      ports.clear();
      lastBindings.clear();
      inFlightReads.clear();
      pausedByKey.clear();
      prevSnapshot = null;
      return;
    }
    const s = session;
    session = null;
    try {
      s.stopObserver();
    } catch {
      /* ignore */
    }
    if (s.rafHandle != null) cancelRaf(s.rafHandle);
    if (s.coalesceTimer) cancel(s.coalesceTimer);
    if (s.heartbeatTimer) cancel(s.heartbeatTimer);
    if (s.storeSettleTimer) cancel(s.storeSettleTimer);
    if (s.fallbackTimer) cancel(s.fallbackTimer);
    for (const t of s.settleTimers.values()) cancel(t);
    s.settleTimers.clear();
    try {
      s.stopStore();
    } catch {
      /* ignore */
    }
    for (const [, up] of unpatches) up.unpatch();
    unpatches.clear();
    for (const [, entry] of ports) entry.port.dispose();
    ports.clear();
    lastBindings.clear();
    inFlightReads.clear();
    pausedByKey.clear();
    prevSnapshot = null;
    cancelStoreSettle();
    bootstrapFallbackStarted = 0;
  };

  const isOnMultiview = (): boolean =>
    /^\/multiview(?:\/|$)/.test(win.location.pathname);

  const stopRouteWatch = () => {
    if (routeTimer) {
      cancel(routeTimer);
      routeTimer = null;
    }
  };

  const startRouteWatch = () => {
    if (routeTimer) return;
    const tick = () => {
      routeTimer = null;
      if (!enabled || disposed) return;
      if (!isOnMultiview()) {
        if (!leftMultiview) {
          leftMultiview = true;
          if (discoveryTimer) {
            cancel(discoveryTimer);
            discoveryTimer = null;
          }
          teardownSession();
        }
      } else if (leftMultiview) {
        leftMultiview = false;
        if (state.mode === "degraded") {
          const r = transition(state, { type: "RESET_DEGRADED", now: now() });
          state = r.state;
        }
        startDiscoveryLoop();
      }
      routeTimer = schedule(tick, TIMING.PATHNAME_CHECK_MS);
    };
    routeTimer = schedule(tick, TIMING.PATHNAME_CHECK_MS);
  };

  const beginSession = (
    store: unknown,
    observeTarget: Element,
  ) => {
    if (!adapter) return;
    // Tear down prior session listeners/timers only — keep bindings already synced.
    if (session) {
      const prev = session;
      session = null;
      try {
        prev.stopObserver();
      } catch {
        /* ignore */
      }
      if (prev.rafHandle != null) cancelRaf(prev.rafHandle);
      if (prev.coalesceTimer) cancel(prev.coalesceTimer);
      if (prev.heartbeatTimer) cancel(prev.heartbeatTimer);
      if (prev.storeSettleTimer) cancel(prev.storeSettleTimer);
      if (prev.fallbackTimer) cancel(prev.fallbackTimer);
      for (const t of prev.settleTimers.values()) cancel(t);
      try {
        prev.stopStore();
      } catch {
        /* ignore */
      }
    }
    const stopObserver = adapter.observe(observeTarget, scheduleRescan);
    const stopStore = adapter.watchSnapshot(
      store as Parameters<HolodexAdapter["watchSnapshot"]>[0],
      () => {
        scheduleProcessLayout();
      },
      (type) => {
        pendingMutationTypes.add(type);
        scheduleProcessLayout();
      },
    );
    session = {
      stopObserver,
      stopStore,
      heartbeatTimer: null,
      rafHandle: null,
      coalesceTimer: null,
      settleTimers: new Map(),
      storeSettleTimer: null,
      fallbackTimer: null,
      store,
      observeTarget,
    };
    const beat = () => {
      if (!session) return;
      rescan();
      session.heartbeatTimer = schedule(beat, TIMING.HEARTBEAT_MS);
    };
    session.heartbeatTimer = schedule(beat, TIMING.HEARTBEAT_MS);
    processLayout();
  };

  const tryDiscover = () => {
    if (!enabled || disposed || state.mode === "degraded") return;
    if (!adapter) {
      adapter = createHolodexAdapter(win, doc, (code) => {
        if (code === "root-timeout") return;
        failSession(code);
      });
    }
    const found = adapter.discover();
    if (!found.ok) {
      return;
    }
    const result = transition(state, {
      type: "DISCOVERED",
      now: now(),
      muteOthers: found.store.state.multiview.muteOthers,
    });
    state = result.state;

    // Mute Others off is a normal idle wait — keep store watch; wrappers already
    // delegate when !muteOthers. root-timeout only for missing root/store.
    if (discoveryTimer) {
      cancel(discoveryTimer);
      discoveryTimer = null;
    }
    syncBindings(found.bindings);
    beginSession(found.store, found.observeTarget);
  };

  const startDiscoveryLoop = () => {
    if (discoveryTimer) {
      cancel(discoveryTimer);
      discoveryTimer = null;
    }
    if (state.mode === "degraded") return;
    if (!isOnMultiview()) {
      leftMultiview = true;
      return;
    }
    discoveryStarted = now();
    const tick = () => {
      if (!enabled || disposed || state.mode === "degraded") return;
      if (session) return;
      tryDiscover();
      if (session) return;
      const elapsed = now() - discoveryStarted;
      if (elapsed >= TIMING.DISCOVERY_TOTAL_MS) {
        failSession("root-timeout");
        return;
      }
      const delay =
        elapsed < TIMING.DISCOVERY_FAST_WINDOW_MS
          ? TIMING.DISCOVERY_FAST_MS
          : TIMING.DISCOVERY_SLOW_MS;
      discoveryTimer = schedule(tick, delay);
    };
    tick();
  };

  const onPanelCapture = (event: Event) => {
    if (!enabled) return;
    const target = event.target as Element | null;
    if (!target?.closest?.(".media-controls-list")) return;
    beginPanelDispatch(event, eventTrusted(event));
    if (panelClearTimer) cancel(panelClearTimer);
    panelClearTimer = schedule(() => {
      clearPanelIfSameScope(event);
      panelClearTimer = null;
    }, 0);
  };

  const onPanelBubble = (event: Event) => {
    endPanelDispatch(event);
  };

  const onPointerDown = (event: Event) => {
    if (!enabled || !state.muteOthers) return;
    if (!eventTrusted(event)) return;
    const target = event.target as Element | null;
    if (!target) return;
    const frame = target.closest?.(".mv-frame");
    if (!frame) return;
    if (
      target.closest?.("a,button,[draggable=true],.resize-handle,.mv-header")
    ) {
      return;
    }
    for (const [, binding] of lastBindings) {
      const el = (binding.cell as { $el?: Element }).$el;
      if (el && (el === frame || el.contains(frame))) {
        const result = transition(state, {
          type: "IFRAME_INTENT",
          now: now(),
          identity: binding.identity,
          source: "pointer",
        });
        state = result.state;
        break;
      }
    }
  };

  const onBlur = () => {
    schedule(() => {
      if (!enabled) return;
      if (doc.visibilityState === "hidden") return;
      const active = doc.activeElement;
      if (!active || active.tagName !== "IFRAME") return;
      for (const [, binding] of lastBindings) {
        const el = (binding.cell as { $el?: Element }).$el;
        if (el && el.contains(active)) {
          const result = transition(state, {
            type: "IFRAME_INTENT",
            now: now(),
            identity: binding.identity,
            source: "iframe",
          });
          state = result.state;
          break;
        }
      }
    }, 0);
  };

  const onFocusIn = () => {
    schedule(() => {
      if (doc.activeElement && doc.activeElement.tagName !== "IFRAME") {
        if (state.intent?.source === "iframe") {
          state = { ...state, intent: null };
        }
      }
    }, 0);
  };

  const onPageShow = (event: PageTransitionEvent) => {
    if (!enabled || disposed) return;
    if (event.persisted) {
      if (state.mode === "degraded") {
        state = transition(state, { type: "RESET_DEGRADED", now: now() }).state;
      }
      teardownSession();
      startDiscoveryLoop();
      return;
    }
    if (!session) startDiscoveryLoop();
  };

  const onPageHide = () => {
    teardownSession();
    state = transition(state, { type: "DISABLE", now: now() }).state;
    state = { ...state, extensionEnabled: enabled };
  };

  const installBootstrap = () => {
    win.addEventListener("click", onPanelCapture, true);
    win.addEventListener("click", onPanelBubble, false);
    win.addEventListener("pointerdown", onPointerDown, true);
    win.addEventListener("blur", onBlur);
    win.addEventListener("focusin", onFocusIn);
    win.addEventListener("pageshow", onPageShow as EventListener);
    win.addEventListener("pagehide", onPageHide);
    disposers.push(() => {
      win.removeEventListener("click", onPanelCapture, true);
      win.removeEventListener("click", onPanelBubble, false);
      win.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("blur", onBlur);
      win.removeEventListener("focusin", onFocusIn);
      win.removeEventListener("pageshow", onPageShow as EventListener);
      win.removeEventListener("pagehide", onPageHide);
    });
  };

  installBootstrap();

  const handle: AudioLockHandle = {
    setEnabled(value: boolean) {
      if (disposed) return;
      if (value === enabled) return;
      enabled = value;
      if (value) {
        const result = transition(state, { type: "ENABLE", now: now() });
        state = result.state;
        startRouteWatch();
        startDiscoveryLoop();
      } else {
        const result = transition(state, { type: "DISABLE", now: now() });
        state = result.state;
        if (discoveryTimer) cancel(discoveryTimer);
        discoveryTimer = null;
        stopRouteWatch();
        teardownSession();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      if (discoveryTimer) cancel(discoveryTimer);
      discoveryTimer = null;
      stopRouteWatch();
      teardownSession();
      for (const d of disposers) d();
      disposers.length = 0;
      adapter?.dispose();
      adapter = null;
      state = createInitialState();
      if (panelClearTimer) cancel(panelClearTimer);
      panelGate.event = null;
      panelGate.trusted = false;
    },
  };

  const testPorts = new Map<string, BoundPlayerPort>();
  const syncTestPorts = () => {
    testPorts.clear();
    for (const [k, v] of ports) testPorts.set(k, v.port);
  };

  (handle as unknown as TestableHandle).__reconcile = reconcileCell;
  (handle as unknown as TestableHandle).__getState = () => state;
  (handle as unknown as TestableHandle).__setState = (s) => {
    state = s;
  };
  (handle as unknown as TestableHandle).__applyEffects = applyEffects;
  (handle as unknown as TestableHandle).__installBindings = (bindings) => {
    syncBindings(bindings);
  };
  (handle as unknown as TestableHandle).__tryDiscover = tryDiscover;
  Object.defineProperty(handle, "__ports", {
    get() {
      syncTestPorts();
      return testPorts;
    },
  });
  (handle as unknown as TestableHandle).__lastBindings = lastBindings;
  (handle as unknown as TestableHandle).__adapter = () => adapter;

  return handle;
}

export type TestableHandle = AudioLockHandle & {
  __reconcile: (identity: CellIdentity) => Promise<void>;
  __getState: () => LockState;
  __setState: (s: LockState) => void;
  __applyEffects: (effects: LockEffect[]) => Promise<void>;
  __installBindings: (bindings: CellBinding[]) => void;
  __tryDiscover: () => void;
  __ports: Map<string, BoundPlayerPort>;
  __lastBindings: Map<string, CellBinding>;
  __adapter: () => HolodexAdapter | null;
};
