/**
 * Holodex+ Multiview "audio lock" (page context).
 *
 * Problem: with Media Controls > "Mute Others" enabled, Holodex polls every player
 * once a second (MediaControls.vue -> VideoCell.manualCheckMuted). Any player that
 * *reports* "unmuted" is treated as if the user picked it, so it mutes every other
 * cell. Twitch embeds can report unmuted on their own (start unmuted, ad breaks,
 * reconnects, stale getMuted() cache), which steals audio from the chosen cell.
 *
 * Fix: keep the Vuex store as the source of truth. When a cell's player reports
 * "unmuted" while the store says it should be muted, only accept it if the user
 * just interacted with that cell's iframe; otherwise re-mute that player.
 * Also: Twitch embeds are created muted, and Twitch cells don't auto-grab audio
 * on their first play.
 *
 * Disable at runtime: localStorage.setItem("hdxPlusAudioLock", "off") and reload.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const TAG = "[Holodex+ AudioLock]";
const USER_INTENT_MS = 10_000;

export function installAudioLock(): void {
  const w = window as any;
  if (w.top !== w) return;
  if (w.__HDX_AUDIO_LOCK__) return;
  w.__HDX_AUDIO_LOCK__ = true;
  if (safeGet("hdxPlusAudioLock") === "off") {
    console.log(TAG, "disabled via localStorage");
    return;
  }

  patchTwitchGlobal(w);
  trackIframeIntent();
  waitForVue((root) => {
    console.log(TAG, "Vue root found, store:", !!root.$store);
    hookVue(root);
  });
  console.log(TAG, "installed");
}

function safeGet(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}

/* ---------- 1. Twitch embeds start muted ---------- */

function wrapTwitch(T: any): any {
  if (!T || !T.Player || T.Player.__hdxWrapped) return T;
  const Orig = T.Player;
  const Wrapped: any = function (this: any, id: any, opts: any) {
    const o = { ...(opts || {}) };
    if (o.muted === undefined) o.muted = true; // Holodex re-applies the store state on "ready"
    return new Orig(id, o);
  };
  Wrapped.prototype = Orig.prototype;
  for (const k of Object.getOwnPropertyNames(Orig)) {
    if (["prototype", "length", "name", "caller", "arguments"].includes(k)) continue;
    try {
      Wrapped[k] = Orig[k];
    } catch {
      /* ignore */
    }
  }
  Wrapped.__hdxWrapped = true;
  // webpack exports may be getter-only, so build a fresh object instead of assigning.
  const out: any = {};
  for (const k of Object.keys(T)) out[k] = T[k];
  out.Player = Wrapped;
  console.log(TAG, "Twitch.Player wrapped (muted by default)");
  return out;
}

function patchTwitchGlobal(w: any): void {
  if (w.Twitch) {
    w.Twitch = wrapTwitch(w.Twitch);
    return;
  }
  let value: any;
  try {
    Object.defineProperty(w, "Twitch", {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v) => {
        value = wrapTwitch(v);
      },
    });
  } catch (e) {
    console.warn(TAG, "could not trap window.Twitch", e);
  }
}

/* ---------- 2. Detect real user interaction with a cell iframe ---------- */

let lastFocusedIframe: Element | null = null;
let lastFocusAt = 0;
let hoveredIframe: Element | null = null;

function trackIframeIntent(): void {
  // Clicking into a cross-origin iframe blurs the top window and makes the iframe activeElement.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a.tagName === "IFRAME") {
        lastFocusedIframe = a;
        lastFocusAt = Date.now();
      }
    }, 0);
  });
  document.addEventListener(
    "mouseover",
    (e) => {
      const t = e.target as Element | null;
      if (t && t.tagName === "IFRAME") hoveredIframe = t;
    },
    true,
  );
  document.addEventListener(
    "mouseout",
    (e) => {
      if (e.target === hoveredIframe) hoveredIframe = null;
    },
    true,
  );
}

function userIntendedCell(cell: any): boolean {
  const iframe: Element | null = cell?.$el?.querySelector?.("iframe") ?? null;
  if (!iframe) return false;
  if (lastFocusedIframe === iframe && Date.now() - lastFocusAt < USER_INTENT_MS) return true;
  // Pointer is on it and it still holds focus -> user is operating that player.
  return hoveredIframe === iframe && document.activeElement === iframe;
}

/* ---------- 3. Patch Holodex VideoCell instances ---------- */

function waitForVue(cb: (root: any) => void): void {
  const started = Date.now();
  const tick = () => {
    const el: any = document.querySelector("#app") || document.querySelector("[data-app]");
    const vm = el?.__vue__;
    if (vm) return cb(vm.$root);
    if (Date.now() - started < 120_000) setTimeout(tick, 300);
    else console.warn(TAG, "Vue root not found; giving up");
  };
  tick();
}

function muteOthersEnabled(vm: any): boolean {
  return !!vm?.$store?.state?.multiview?.muteOthers;
}

function patchCell(cell: any): void {
  if (!cell || cell.__hdxAudioLock) return;
  if (typeof cell.manualCheckMuted !== "function" || typeof cell.setMuted !== "function") return;
  cell.__hdxAudioLock = true;

  const origCheck = cell.manualCheckMuted;
  cell.manualCheckMuted = async function () {
    if (!muteOthersEnabled(cell)) return origCheck.call(cell);
    const player = cell.$refs?.player;
    if (!player) return;
    let playerMuted: boolean;
    try {
      playerMuted = !!(await player.isMuted());
    } catch {
      return; // player not ready yet
    }
    const storeMuted = !!cell.muted;
    if (playerMuted === storeMuted) return;
    if (playerMuted) {
      // Player muted itself / user muted inside the player: harmless, sync store.
      return cell.setMuted(true);
    }
    // Player says "unmuted" but store says "muted".
    if (userIntendedCell(cell)) {
      console.log(TAG, "user unmuted cell", cell.item?.i, "-> switching audio");
      return cell.setMuted(false);
    }
    console.log(TAG, "cell", cell.item?.i, cell.isTwitchVideo ? "(twitch)" : "", "unmuted itself -> re-muting");
    try {
      player.setMute(true);
    } catch (e) {
      console.warn(TAG, "re-mute failed", e);
    }
  };

  const origUpdate = cell.updatePausedState;
  if (typeof origUpdate === "function") {
    cell.updatePausedState = function (paused = false) {
      // Don't let a Twitch cell grab audio just because it started playing.
      if (cell.isTwitchVideo && muteOthersEnabled(cell)) cell.firstPlay = false;
      return origUpdate.call(cell, paused);
    };
  }
}

function walk(vm: any, fn: (vm: any) => void): void {
  fn(vm);
  for (const c of vm.$children || []) walk(c, fn);
}

function patchTree(root: any): void {
  walk(root, (vm) => {
    if (vm.$options?.name === "VideoCell") patchCell(vm);
  });
}

function hookVue(root: any): void {
  let Vue = root.constructor;
  while (Vue && Vue.super) Vue = Vue.super;
  try {
    Vue?.mixin?.({
      created(this: any) {
        if (this.$options?.name === "VideoCell") patchCell(this);
      },
    });
  } catch (e) {
    console.warn(TAG, "Vue.mixin failed; relying on polling", e);
  }
  patchTree(root);
  setInterval(() => patchTree(root), 1000);
}
