/**
 * Holodex+ multiview audio lock (page context).
 *
 * When Mute Others is on, prevent Twitch/YouTube embeds from stealing the
 * selected audio via polling, refresh, or first-play. Configuration arrives
 * from the isolated content-script bridge via postMessage.
 */

import {
  AUDIO_LOCK_CHANNEL,
  AUDIO_LOCK_VERSION,
  parseAudioLockMessage,
  type AudioLockHandle,
} from "./audio-lock/contracts";
import { createAudioLockController } from "./audio-lock/controller";

type PageWindow = Window & {
  __HDX_AUDIO_LOCK_HANDLE__?: AudioLockHandle;
};

export function installAudioLock(): AudioLockHandle {
  const w = window as PageWindow;
  if (w.top !== w) {
    return {
      setEnabled() {
        /* no-op in frames */
      },
      dispose() {
        /* no-op */
      },
    };
  }

  if (w.__HDX_AUDIO_LOCK_HANDLE__) {
    return w.__HDX_AUDIO_LOCK_HANDLE__;
  }

  const controller = createAudioLockController({
    window: w,
    document: w.document,
  });

  let readySent = false;
  const onMessage = (event: MessageEvent) => {
    if (event.source !== w) return;
    if (event.origin !== w.location.origin) return;
    const msg = parseAudioLockMessage(event.data);
    if (!msg || msg.type !== "config") return;
    controller.setEnabled(msg.enabled);
  };

  w.addEventListener("message", onMessage);

  const handle: AudioLockHandle = {
    setEnabled(value: boolean) {
      controller.setEnabled(value);
    },
    dispose() {
      w.removeEventListener("message", onMessage);
      controller.dispose();
      delete w.__HDX_AUDIO_LOCK_HANDLE__;
    },
  };

  w.__HDX_AUDIO_LOCK_HANDLE__ = handle;

  if (!readySent) {
    readySent = true;
    try {
      w.postMessage(
        {
          channel: AUDIO_LOCK_CHANNEL,
          version: AUDIO_LOCK_VERSION,
          type: "ready",
        },
        w.location.origin,
      );
    } catch {
      /* ignore */
    }
  }

  return handle;
}
