import { storage } from "webextension-polyfill";
import { Options } from "@utils";
import {
  AUDIO_LOCK_CHANNEL,
  AUDIO_LOCK_VERSION,
  TIMING,
  parseAudioLockMessage,
  type AudioLockMessage,
} from "./audio-lock/contracts";

/**
 * Isolated content-script bridge: reads Options and posts config to page.
 * Must be started before inject(); page script must register listener before ready.
 */
export function startAudioLockSettingsBridge(win: Window): () => void {
  let disposed = false;
  let latestEnabled = true;
  let inFlight = false;
  let changedDuringRead = false;
  let readGeneration = 0;
  let warned = false;

  const postConfig = (enabled: boolean) => {
    if (disposed) return;
    latestEnabled = enabled;
    const message: AudioLockMessage = {
      channel: AUDIO_LOCK_CHANNEL,
      version: AUDIO_LOCK_VERSION,
      type: "config",
      enabled,
    };
    try {
      win.postMessage(message, win.location.origin);
    } catch {
      /* ignore */
    }
  };

  const warnOnce = (code: string) => {
    if (warned) return;
    warned = true;
    try {
      console.warn("[Holodex+ AudioLock]", { code, adapterVersion: 1 });
    } catch {
      /* ignore */
    }
  };

  const readStorage = async () => {
    if (disposed) return;
    const gen = ++readGeneration;
    inFlight = true;
    changedDuringRead = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      inFlight = false;
      postConfig(false);
      warnOnce("storage-read-timeout");
    }, TIMING.STORAGE_READ_TIMEOUT_MS);

    try {
      const value = await Options.get("twitchAudioLock");
      clearTimeout(timer);
      if (disposed || gen !== readGeneration) return;
      if (timedOut || changedDuringRead) {
        inFlight = false;
        return;
      }
      if (value === null || value === undefined) {
        postConfig(true);
      } else if (typeof value !== "boolean") {
        postConfig(false);
        warnOnce("storage-invalid");
      } else {
        postConfig(value);
      }
    } catch {
      clearTimeout(timer);
      if (disposed || gen !== readGeneration) return;
      if (!timedOut && !changedDuringRead) {
        postConfig(false);
        warnOnce("storage-rejected");
      }
    } finally {
      if (gen === readGeneration) inFlight = false;
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (disposed) return;
    if (event.source !== win) return;
    if (event.origin !== win.location.origin) return;
    const msg = parseAudioLockMessage(event.data);
    if (!msg || msg.type !== "ready") return;
    postConfig(latestEnabled);
    if (!inFlight) {
      void readStorage();
    }
  };

  const onChanged = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ) => {
    if (disposed) return;
    if (areaName !== "local") return;
    if (!("twitchAudioLock" in changes)) return;
    const change = changes.twitchAudioLock;
    if (inFlight) changedDuringRead = true;
    if (change.newValue === undefined) {
      postConfig(true);
      return;
    }
    if (typeof change.newValue !== "boolean") {
      postConfig(false);
      warnOnce("storage-invalid");
      return;
    }
    postConfig(change.newValue);
  };

  const onPageShow = () => {
    if (disposed) return;
    void readStorage();
  };

  win.addEventListener("message", onMessage);
  win.addEventListener("pageshow", onPageShow);
  storage.onChanged.addListener(onChanged);

  void readStorage();

  return () => {
    if (disposed) return;
    disposed = true;
    win.removeEventListener("message", onMessage);
    win.removeEventListener("pageshow", onPageShow);
    storage.onChanged.removeListener(onChanged);
  };
}
