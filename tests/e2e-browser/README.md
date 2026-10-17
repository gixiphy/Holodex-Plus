# Browser e2e: Twitch audio lock on holodex.net

Headless Google Chrome harness that loads an unpacked extension, opens real `https://holodex.net/multiview`, and replaces Twitch embed / YouTube iframe API with `audio-lock/fakes.js` so the Mute Others lock can be exercised without real players.

## Requirements

- Google Chrome installed at `/Applications/Google Chrome.app` (override with `CHROME`)
- Network access to `holodex.net`
- Node 20+
- A built `dist_chrome` (run `yarn build` first)

## What it does

1. Starts headless Chrome with a temporary profile under `.cache/e2e-browser/` (or `HPLUS_E2E_TMP`)
2. Loads the unpacked extension via CDP `Extensions.loadUnpacked`
3. Opens real holodex.net/multiview and seeds a YouTube + Twitch layout with Mute Others on
4. Intercepts Twitch/YouTube player scripts with fakes
5. Samples store `muted` before reload, during post-reload settle, and just before playback (`prePlay`)
6. Runs the five-phase scenario below and writes a JSON result

This harness is **not** part of `test:audio-lock` and is not picked up by Vitest.

Profiles are created under `.cache/e2e-browser/` (ignored via `.gitignore` `.cache`) and deleted when the run finishes. It does **not** touch the user's Chrome or Vivaldi profile.

## Scenario (five phases)

1. Real holodex.net/multiview with one YouTube cell (`ytFAKE00001`) and one Twitch cell (`fakechannel`), Mute Others on
2. YouTube plays first; Twitch starts 3 seconds later
3. Twitch self-unmutes once (no user input)
4. Twitch mute lag 2.5s; self-unmutes every 4s × 6; then observe 5s
5. Real CDP mouse click into the Twitch player, then Twitch unmutes (audio should switch to Twitch)

## Pre-play sampling and pass criteria

`run.mjs` records `result.prePlay` every 250ms in three windows:

- `pre-reload` (3s after seeding layout, before `Page.reload`)
- `post-reload-settle` (each 8s settle loop after reload)
- `pre-play` (1.5s after settle, before `__startPlaying`)

`compare.mjs` fails the candidate when any of these hold:

- `preReloadYtStoreMuted !== 0` or `preReloadSamples < 10`
- `prePlayYtStoreMuted !== 0` or `prePlaySamples < 30`
- `checks.initial.storeA === true`

Timeline sampling after play (168 + 20) is unchanged so results stay comparable to MVP evidence.

## Commands

```bash
export npm_config_cache=$PWD/.cache/npm YARN_CACHE_FOLDER=$PWD/.cache/yarn TMPDIR=$PWD/.cache/tmp
mkdir -p "$TMPDIR" .cache/e2e-browser
npx --yes yarn@1.22.22 build
npx --yes yarn@1.22.22 e2e:audio-lock

# Or manually (compare against MVP live + evidence + none):
node tests/e2e-browser/audio-lock/run.mjs fix  dist_chrome .cache/e2e-browser/fix.json
node tests/e2e-browser/audio-lock/run.mjs mvp  /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/mvp.json
node tests/e2e-browser/audio-lock/run.mjs none none .cache/e2e-browser/none.json
node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix.json .cache/e2e-browser/mvp.json \
  docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json .cache/e2e-browser/none.json

# Consecutive 3 fix runs (restart the streak on any failure):
for n in 1 2 3; do
  node tests/e2e-browser/audio-lock/run.mjs fix-$n dist_chrome .cache/e2e-browser/fix-$n.json || exit 1
  node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix-$n.json \
    docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json || exit 1
done
node tests/e2e-browser/audio-lock/run.mjs mvp /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/mvp.json
node tests/e2e-browser/audio-lock/run.mjs none none .cache/e2e-browser/none.json
node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix-1.json .cache/e2e-browser/fix-2.json \
  .cache/e2e-browser/fix-3.json .cache/e2e-browser/mvp.json .cache/e2e-browser/none.json
```

Exit codes for `run.mjs`: `0` finished, `2` exception, `3` global timeout (240s).  
`compare.mjs` exits `0` only when the first (candidate) result passes all lock criteria.

## Live players

Real Twitch (`player.twitch.tv`) + YouTube embeds on holodex.net/multiview. **Run only on M5** with a logged-in desktop session. Uses a headed Google Chrome and a temporary profile under `.cache/e2e-browser/live-prof-*` (deleted on exit). Never touches the operator's Chrome/Vivaldi profiles.

### Modes

- `normal` (default): extension guard + `__v_skip` path. Expects `twitchObserved=false`, `vIsRefErrors=0`.
- `fallback`: before page scripts, defines `window.Twitch` as a non-configurable data property so the construct guard fails. Expects `twitchObserved=true`, `vIsRefErrors>0`, and iframe `UPDATE_STATE` / postMessage SetMuted still lock audio.

### Defaults and env

| Variable | Default | Meaning |
| --- | --- | --- |
| `HPLUS_E2E_TWITCH_CHANNEL` | `eslcs` | Twitch channel |
| `HPLUS_E2E_YOUTUBE_ID` | `1-LpQekNa9g` | YouTube video id |
| `HPLUS_E2E_TMP` | `.cache/e2e-browser` | temp root |
| `HPLUS_E2E_HEADLESS` | unset | set `1` for `--headless=new` (debug only) |
| `CHROME` | Google Chrome.app | browser binary |

If the default stream cannot play within 60s, the harness may try alternate picks (Twitch directory top cards / Holodex live cards), up to 3 each. No usable live → `verdict: "SKIP"` exit 4 (`no-live-twitch` / `no-live-youtube`). SKIP is not PASS.

### Start playback and focus

Holodex Twitch uses `autoplay:false`; calling `video.play()` inside the iframe does not start playback. The harness uses trusted CDP mouse clicks on the player play button (YouTube `.ytp-large-play-button` / `.ytmCuedOverlayPlayButton`, Twitch `button[data-a-target="player-overlay-play-button"]` / play-pause, else iframe center), then clicks a verified blank region so focus leaves the iframe.

Blank clicks scan the lower-right viewport for an element that is not a control, iframe, frame, dialog, or overlay. After closing the media panel with Escape, the harness waits up to 3s for `.v-dialog--active` / `.v-overlay--active` to clear (then one outside click + retry) before blanking. Blank lookup itself retries for up to 3s; failure includes `elementFromPoint` samples.

### Mute toggle

Mute uses a trusted click on the player mute control, then polls every 100ms for up to 1000ms. Only if muted/volume are unchanged does it send keyboard `m`, then poll again up to 1000ms. This avoids a delayed button unmute being cancelled by the keyboard fallback. Returns `method`, `clickAt`, `changedAt`, `keyAt`.

Scenario c round 2 starts a 50ms sampler before that input and keeps it until 2000ms after the timing origin. The origin is `clickAt` when `keyAt` is null, and `keyAt` when the keyboard `m` fallback was required. The round records `inputFallback` (`true` only when `keyAt` is set). `switched` is the first sample in `[origin, origin+2000]` with YouTube audible and Twitch `<video>.muted === true`.

### Scenario isolation and page exceptions

Scenarios b, each c round, d, e, and f run in try/catch. A scenario exception records `{ pass:false, error }` in that scenario plus `scenarioErrors` / `harnessErrors`, then continues. Only browser start, extension load, calibration, and scenario a setup abort the whole run (exit 2).

`Runtime.exceptionThrown` goes to `pageExceptions` with `firstLine` (first line of `exception.description`, else `text`), `frames` (`{functionName, url}` from `stackTrace.callFrames` only), and `allowId`. Classification uses those frames, not a substring of the whole stack string:

- `extension`: a frame URL or `exceptionDetails.url` contains `chrome-extension://`, or the message contains `AudioLock` / `Holodex+`
- `host`: there is at least one frame and every frame URL starts with `https://holodex.net/assets/`
- anything else is unclassified and fails scenario f

Host allowlist (`tests/e2e-browser/audio-lock/live-exceptions.mjs`), both the line and the frame predicate:

- `null-length-fetchVideoData`: first line matches `TypeError: Cannot read properties of null (reading '…')`, and some frame's `functionName` ends with `fetchVideoData` on `https://holodex.net/assets/`
- `getCurrentTime-not-function`: first line is exactly `TypeError: this.player.getCurrentTime is not a function`, and every frame URL starts with `https://holodex.net/assets/`

Scenario f (normal/MVP): after removing the Twitch cell, for 5s there must be no new extension exceptions, no new unclassified exceptions, YouTube still audible, and every new host exception must have a non-null `allowId`. Those rows are `hostAllowedPendingMvp`. `live-compare.mjs` checks each one against the same-round MVP JSON (`allowId` plus `firstLine`). A miss marks column f as `FAIL(mvp-missing)` and forces `effectiveVerdict` off `PASS`. Acceptance uses `effectiveVerdict`. One `live.mjs` run cannot see the MVP file yet, so its own `verdict` does not do that comparison.

`[Holodex+ AudioLock]` console warnings store `code`. Object arguments use `preview.properties` named `code`, or `Runtime.callFunctionOn` plus `JSON.stringify` when preview has no code. Missing code is `null`. Scenario e rejects degraded codes (`player-unavailable`, `player-mute-did-not-settle`, `store-did-not-settle`, `restore-failed`, `cell-contract-changed`) in normal and MVP. Fallback allows only `code === "twitch-guard-unavailable"`; `code === null` fails e.

If calibration `waitPlaying('twitch')` fails, the harness reads the Twitch iframe (`readyState`, `body.innerHTML.length`, `video` count, `location.href`). When the URL matches the picked channel and the body is empty or there are zero videos, it reloads the page once, seeds YouTube again, and retries `addTwitch` / `waitPlaying('twitch')`. The result is `twitchMountRetry: { at, diagnosticsBefore, diagnosticsAfter, recovered }`. A second failure is `SKIP` / `no-live-twitch` (exit 4). This retry happens only before scenario a. Picks stay the same. The retry is the same e2e run.

`fallbackProbe` is a read-only snapshot (no component method calls) at the end of a, the end of b, and before each c-round input. It records whether cell b has `twPlayer`, whether that player is the Vue instance, `__ob__`, `setMuted` / `getMuted`, Vue `ready` listener count, iframe origin and count, whether `manualCheckMuted` is the extension wrapper, store `b.muted` and `muteOthers`, command counts, the last `UPDATE_STATE` muted flag, and AudioLock warning codes. `live-compare.mjs` prints the last probe's `twPlayerSet`, `instHasOb`, `readyListeners`, and `wrapperInstalled` for fallback runs.

`logsByPhase` keeps `twitchCommandLog` and `updateStates` under `a`, `b`, `c1`, `c2`, `c3`, `d-before`, `d-after`, and `f`. A later reload does not replace an earlier phase key.

Modes covered to completion: fallback runs a, b, c×3, e, g; normal and MVP run a, b (MVP also b′), c×3, d, e, f. Later scenarios still run after an earlier FAIL.

### Truth method

Per-iframe CDP sessions read `<video>` `{ muted, volume, paused, readyState, currentTime }`. Audible = `!paused && readyState >= 2 && !muted && volume > 0.01`. Calibration toggles mute once per player before scenarios; failure → `truth-method-invalid`.

### Commands

```bash
export npm_config_cache=$PWD/.cache/npm YARN_CACHE_FOLDER=$PWD/.cache/yarn TMPDIR=$PWD/.cache/tmp
npx --yes yarn@1.22.22 build
node tests/e2e-browser/audio-lock/live.mjs live-fix dist_chrome .cache/e2e-browser/live-fix.json
node tests/e2e-browser/audio-lock/live.mjs live-fix-fallback dist_chrome .cache/e2e-browser/live-fix-fallback.json --mode=fallback
node tests/e2e-browser/audio-lock/live.mjs live-mvp /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/live-mvp.json
node tests/e2e-browser/audio-lock/live-compare.mjs .cache/e2e-browser/live-fix.json .cache/e2e-browser/live-fix-fallback.json .cache/e2e-browser/live-mvp.json
# exit 0 only when the first JSON has effectiveVerdict PASS
# or: yarn e2e:audio-lock:live
```

Exit codes: `0` PASS, `1` FAIL, `2` exception, `3` timeout after scenario a started, `4` SKIP.
