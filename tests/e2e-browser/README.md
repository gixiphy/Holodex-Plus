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
5. Runs the five-phase scenario below and writes a JSON result

This harness is **not** part of `test:audio-lock` and is not picked up by Vitest.

Profiles are created under `.cache/e2e-browser/` (ignored via `.gitignore` `.cache`) and deleted when the run finishes. It does **not** touch the user's Chrome or Vivaldi profile.

## Scenario (five phases)

1. Real holodex.net/multiview with one YouTube cell (`ytFAKE00001`) and one Twitch cell (`fakechannel`), Mute Others on
2. YouTube plays first; Twitch starts 3 seconds later
3. Twitch self-unmutes once (no user input)
4. Twitch mute lag 2.5s; self-unmutes every 4s × 6; then observe 5s
5. Real CDP mouse click into the Twitch player, then Twitch unmutes (audio should switch to Twitch)

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
```

Exit codes for `run.mjs`: `0` finished, `2` exception, `3` global timeout (240s).  
`compare.mjs` exits `0` only when the first (candidate) result passes all lock criteria.
