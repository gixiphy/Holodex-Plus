import { inject } from "@utils";
import { startAudioLockSettingsBridge } from "./audio-lock-settings";
import injectPath from "./holodex-inject?script&module";

if (window.top === window) {
  startAudioLockSettingsBridge(window);
}

try {
  inject(injectPath);
} catch (err) {
  try {
    console.warn("[Holodex+ AudioLock]", {
      code: "inject-failed",
      adapterVersion: 1,
    });
  } catch {
    /* ignore */
  }
  void err;
}
