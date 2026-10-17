# fix-4 real-Vivaldi failure root cause (coordinator, 2026-10-18 00:1x Asia/Taipei)

## Fi's real test (M1 Vivaldi, fix-4 build bdb28f0, Mute Others on)
- Twitch cell stays muted (good), but YouTube gets muted repeatedly (bad).
- Console (fix-4 loaded, `[Holodex+] Activated` present):
  Uncaught SecurityError: Failed to read a named property '__v_isRef' from 'Window': An attempt was made to break through the security policy of the user agent.
      at _.get [as _embedWindow] (vendor.be3ecd61.js:5:8646)
      at _._handleResponses (v1.js:1:14959)
- Fi (00:21) confirmed the MVP shows the same `__v_isRef` SecurityError.

## Root cause (read-only analysis; verbatim from coordinator)
Holodex's TwitchPlayer.vue assigns `this.player = new window.Twitch.Player(...)` into Vue 2.7 reactive data; Vue makes `_player._embedWindow` (cross-origin player.twitch.tv window) reactive, and reading `__v_isRef` throws SecurityError inside Twitch v1.js `_handleResponses`, so Twitch player state never updates: getMuted() always returns false, setMuted()/play() fail before sending. fix-4 reads Twitch as unmuted, sends mute that fails, after 3 failures goes `degraded` (player-mute-did-not-settle), then patched manualCheckMuted falls back to Holodex original, which treats Twitch as unmuted and triggers Mute Others, muting YouTube repeatedly. MVP (/Applications/Extensions/holodex-plus-audiolock-chrome on M1, read-only reference, never move/modify) avoids this by intercepting window.Twitch.Player to construct with muted:true and swallowing re-mute errors without falling back. Automated tests passed because they did not use a real cross-origin player.twitch.tv iframe.

Note on Vue 2.7: `observe()` walks any value whose Object.prototype.toString is `[object Object]` (class instances included) unless `value.__v_skip` is truthy (markRaw); the reactive getter calls `isRef(value)` which reads `value.__v_isRef` -> on a cross-origin WindowProxy this throws. Unverified hypothesis: setting `__v_skip = true` (non-enumerable is fine) on the Twitch.Player instance inside the constructor wrapper, before Holodex stores it in reactive data, prevents the error and makes getMuted/setMuted work again. Must be verified on a real player.twitch.tv iframe.

## MVP's one remaining bug (Fi 00:20)
Reverse switch: when Twitch is audible (user explicitly unmuted Twitch) and the user then switches audio to YouTube (unmutes the YouTube cell), Twitch is NOT muted automatically; Fi must mute Twitch by hand. Likely cause: Holodex Mute Others mutes the Twitch cell via the Twitch player API (setMuted), which is broken by the SecurityError above.

## MVP baseline (what it does right; keep all of it)
- Traps `window.Twitch` with defineProperty (or wraps it if present) so `Twitch.Player` is constructed with `muted:true` by default.
- Patches every VideoCell via `Vue.mixin({created})` + 1s polling of the component tree.
- Patched `manualCheckMuted` (only when Mute Others is on): reads `player.isMuted()` in try/catch and returns on error; if player muted but cell not -> `setMuted(true)`; if player unmuted and user intent (iframe focus within 10s, or hover + activeElement) -> `setMuted(false)` (switch audio); else re-mute via `player.setMute(true)` in try/catch, never falls back to Holodex original.
- `updatePausedState` sets `firstPlay=false` for Twitch cells when Mute Others is on.
- Full MVP page script: mvp-holodex-inject.js in this folder (copied read-only from the M1 install).
