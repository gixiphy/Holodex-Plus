/** Pure types and message parsing for Holodex+ audio lock. No DOM or extension APIs. */

export type CellKey = string;
export type MutedAssignment = true | false | undefined;
export type Provider = "youtube" | "twitch";

export type CellIdentity = {
  key: CellKey;
  contentId: string;
  provider: Provider;
  generation: number;
};

export type ReadMuted =
  | { kind: "known"; muted: boolean }
  | { kind: "unavailable"; reason: "not-ready" | "timeout" | "access-error" };

export type SelectionGrant = {
  identity: CellIdentity;
  epoch: number;
  source: "bootstrap" | "explicit";
};

export interface PlayerPort {
  readMuted(): Promise<ReadMuted>;
  mute(): Promise<boolean>;
  restoreSelectedAudio(grant: SelectionGrant): Promise<boolean>;
  dispose(): void;
}

export type LockMode =
  | "disabled"
  | "discovering"
  | "waiting-for-choice"
  | "locked"
  | "degraded";

export type SelectionKind = "bootstrap" | "selected" | "silence";

export type DesiredMute = "muted" | "audible" | "unassigned";

export type IntentToken = {
  identity: CellIdentity;
  source: "panel" | "iframe" | "pointer";
  expiresAt: number;
  consumed: boolean;
};

export type SelectionGrantState = {
  grant: SelectionGrant;
  consumed: boolean;
};

export type CellRuntime = {
  readInFlight: boolean;
  muteInFlight: boolean;
  lastMuteAt: number;
  consecutiveFailures: number;
  lastGuardMuteAt: number;
  settleUntil: number;
  ownMuteGeneration: number | null;
  lastObservedMuted: boolean | null;
  unsettledMuteCount: number;
};

export type LockState = {
  mode: LockMode;
  selection: SelectionKind;
  active: CellIdentity | null;
  epoch: number;
  intent: IntentToken | null;
  selectionGrant: SelectionGrantState | null;
  extensionEnabled: boolean;
  muteOthers: boolean;
  cells: Record<CellKey, CellRuntime>;
  reportedCodes: Record<string, true>;
};

export type StoreCellSnapshot = {
  identity: CellIdentity;
  assignment: MutedAssignment;
};

export type StoreSnapshot = {
  muteOthers: boolean;
  cells: StoreCellSnapshot[];
};

export type LayoutClassification = {
  kind:
    | "none"
    | "reorder"
    | "add"
    | "remove-active"
    | "replace-active"
    | "preset"
    | "merge-preset";
  added: CellIdentity[];
  removed: CellIdentity[];
  preservedActive: CellIdentity | null;
};

export type LockEvent =
  | { type: "ENABLE"; now: number }
  | { type: "DISABLE"; now: number }
  | { type: "DISCOVERED"; now: number; muteOthers: boolean }
  | {
      type: "NATIVE_FIRST_PLAY";
      now: number;
      identity: CellIdentity;
    }
  | { type: "BOOTSTRAP_READY"; now: number; identity: CellIdentity }
  | {
      type: "LAYOUT_CHANGED";
      now: number;
      kind: "add" | "remove-active" | "replace-active" | "preset" | "reorder" | "merge-preset";
      snapshot: StoreSnapshot;
      preservedActive?: CellIdentity | null;
    }
  | {
      type: "PLAYER_READY";
      now: number;
      identity: CellIdentity;
      assignment: MutedAssignment;
    }
  | {
      type: "EXPLICIT_SET_MUTED";
      now: number;
      identity: CellIdentity;
      muted: boolean;
    }
  | {
      type: "IFRAME_INTENT";
      now: number;
      identity: CellIdentity;
      source: "iframe" | "pointer";
    }
  | {
      type: "OBSERVED_MUTED";
      now: number;
      identity: CellIdentity;
      muted: boolean;
      assignment: MutedAssignment;
      origin: "poll" | "refresh";
    }
  | { type: "MUTE_SENT"; now: number; identity: CellIdentity }
  | { type: "RESET_DEGRADED"; now: number }
  | { type: "STORE_SNAPSHOT"; now: number; snapshot: StoreSnapshot }
  | { type: "CELL_REMOVED"; now: number; identity: CellIdentity }
  | {
      type: "BINDING_REBOUND";
      now: number;
      previous: CellIdentity;
      identity: CellIdentity;
      reason: "remount" | "late-bind";
    }
  | { type: "CONTRACT_FAILED"; now: number; code: string }
  | { type: "TOKEN_EXPIRED"; now: number }
  | { type: "SETTLE_EXPIRED"; now: number; identity: CellIdentity; stillMuted: boolean }
  | {
      type: "STORE_DID_NOT_SETTLE";
      now: number;
    };

export type LockEffect =
  | { type: "MUTE_PLAYER"; identity: CellIdentity; epoch: number }
  | {
      type: "CALL_ORIGINAL_SET_MUTED";
      identity: CellIdentity;
      muted: boolean;
      epoch: number;
    }
  | {
      type: "CALL_ORIGINAL_MUTE_OTHERS";
      identity: CellIdentity;
      epoch: number;
    }
  | {
      type: "RESTORE_SELECTED_AUDIO";
      grant: SelectionGrant;
    }
  | {
      type: "SET_STORE_MUTED";
      identity: CellIdentity;
      value: true;
      epoch: number;
    }
  | { type: "REPORT_ONCE"; code: string };

export const ADAPTER_VERSION = 1;

export const TIMING = {
  USER_INTENT_MS: 2500,
  READ_TIMEOUT_MS: 750,
  MUTE_COOLDOWN_MS: 1000,
  SETTLE_MS: 1500,
  STORE_SETTLE_MS: 500,
  FAILURE_COOLDOWN_MS: 5000,
  MAX_CONSECUTIVE_FAILURES: 3,
  DISCOVERY_FAST_MS: 250,
  DISCOVERY_FAST_WINDOW_MS: 15_000,
  DISCOVERY_SLOW_MS: 2000,
  DISCOVERY_TOTAL_MS: 120_000,
  BOOTSTRAP_FALLBACK_MS: 1000,
  BOOTSTRAP_WAIT_MS: 120_000,
  HEARTBEAT_MS: 2000,
  PATHNAME_CHECK_MS: 2000,
  STORAGE_READ_TIMEOUT_MS: 5000,
  MAX_INSTANCE_SCAN: 2000,
  MAX_DOM_SCAN: 500,
} as const;

export const AUDIO_LOCK_CHANNEL = "holodex-plus/audio-lock";
export const AUDIO_LOCK_VERSION = 1;

export type AudioLockMessage =
  | { channel: typeof AUDIO_LOCK_CHANNEL; version: typeof AUDIO_LOCK_VERSION; type: "ready" }
  | {
      channel: typeof AUDIO_LOCK_CHANNEL;
      version: typeof AUDIO_LOCK_VERSION;
      type: "config";
      enabled: boolean;
    };

export function parseAudioLockMessage(value: unknown): AudioLockMessage | null {
  if (!value || typeof value !== "object") return null;
  const msg = value as Record<string, unknown>;
  if (msg.channel !== AUDIO_LOCK_CHANNEL) return null;
  if (msg.version !== AUDIO_LOCK_VERSION) return null;
  if (msg.type === "ready") {
    return { channel: AUDIO_LOCK_CHANNEL, version: AUDIO_LOCK_VERSION, type: "ready" };
  }
  if (msg.type === "config") {
    if (typeof msg.enabled !== "boolean") return null;
    return {
      channel: AUDIO_LOCK_CHANNEL,
      version: AUDIO_LOCK_VERSION,
      type: "config",
      enabled: msg.enabled,
    };
  }
  return null;
}

export function sameIdentity(a: CellIdentity | null, b: CellIdentity | null): boolean {
  if (!a || !b) return false;
  return (
    a.key === b.key &&
    a.contentId === b.contentId &&
    a.provider === b.provider &&
    a.generation === b.generation
  );
}

export function identityCore(a: CellIdentity): string {
  return `${a.key}|${a.provider}|${a.contentId}`;
}

export function encodeAssignment(a: MutedAssignment): "M" | "A" | "U" {
  if (a === true) return "M";
  if (a === false) return "A";
  return "U";
}

export type AudioLockHandle = {
  setEnabled(value: boolean): void;
  dispose(): void;
};
