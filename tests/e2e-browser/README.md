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

### Scenario isolation and page exceptions

Scenarios b, each c round, d, e, and f run in try/catch. A scenario exception records `{ pass:false, error }` in that scenario plus `scenarioErrors` / `harnessErrors`, then continues. Only browser start, extension load, calibration, and scenario a setup abort the whole run (exit 2).

`Runtime.exceptionThrown` goes to `pageExceptions` (timestamped). Classification:

- `extensionExceptions`: stack/url contains `chrome-extension://`, or message contains `AudioLock` / `Holodex+`
- `hostExceptions`: every stack URL is under `https://holodex.net/assets/`
- anything else is unclassified and fails scenario f

Scenario f (normal/MVP): after removing the Twitch cell, for 5s there must be no new `extensionExceptions`, no unclassified exceptions, YouTube still audible, and any new `hostExceptions` messages must match the allowlist (`this.player.getCurrentTime is not a function`, `fetchVideoData`). Final acceptance also requires the same host messages on the same-round MVP JSON.

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
# or: yarn e2e:audio-lock:live
```

Exit codes: `0` PASS, `1` FAIL, `2` exception, `3` timeout after scenario a started, `4` SKIP.
