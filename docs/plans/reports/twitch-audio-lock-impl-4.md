# Twitch audio lock 實作報告 4（fix-3）

日期：2026-10-17。執行者：Cursor。分支 `gixiphy/twitch-audio-lock`。  
依據：`docs/plans/twitch-audio-lock-fix-3.md`（基準 head `f77423c`，父 commit `3893149`）。  
根因證據：`docs/plans/evidence/twitch-audio-lock-fix-3/ROOTCAUSE.md`。

## 修法摘要

採用修正計畫方案 B：不改 `inject()`／manifest／音訊鎖邏輯。在 Vite build 加 `classicPageScripts()`（`enforce: "post"`），於 crxjs 輸出 `holodex-inject.ts-*.js` 後，用內層 Vite `build({ format: "iife", inlineDynamicImports: true })` 覆蓋該 chunk 內容為單一經典腳本，清除 `imports`／`dynamicImports`。檔名與 `web_accessible_resources` 不變。另新增產物測試與 headless Chrome e2e harness。

## 任務對照

| 任務 | 計畫要求 | 結果 | Commit SHA |
| --- | --- | --- | --- |
| 1 | `classicPageScripts`＋`test:artifacts`；建置前後 FAIL→PASS | 完成 | `f59dbb5ea05a3f69a1cef06a646a809fb8257eca` |
| 2 | e2e harness／`compare.mjs`／README／`e2e:audio-lock` | 完成 | `d1991086b75b011f12235d01dc598271175a9271` |
| 3 | 本實作報告 | 完成 | （本 docs commit） |

未改動：`src/**`、`yarn.lock`、manifest、`vite.config.chrome.ts`／`vite.config.firefox.ts`、`tests/audio-lock/**`、證據資料夾、`.ref/`。`package.json` 僅新增 `test:artifacts`、`e2e:audio-lock` 兩行 scripts。

## 任務 1 Step 2：修正前 FAIL 摘要

乾淨 `yarn build`（尚無 plugin）後 `yarn test:artifacts`：

| 項目 | 值 |
| --- | --- |
| 結束碼 | 1 |
| tests | 10（suites 2） |
| pass | 6 |
| fail | 4 |

兩個 dist 皆失敗：

- `page_scripts_parse_as_classic_script`：`SyntaxError: Cannot use import statement outside a module`（`holodex-inject.ts-BjDs9NrB.js` 以 `import{…}from"./contracts-….js"` 開頭）
- `holodex_page_script_runs_and_sets_flags`：同上 SyntaxError，旗標未設

其餘（`dist_has_manifest`、`finds_injected_page_scripts`、`page_scripts_are_web_accessible_on_their_site`）通過。

## 任務 1 Step 5：修正後 PASS 摘要

| 項目 | 值 |
| --- | --- |
| `head -c 120 dist_*/assets/holodex-inject.ts-*.js` | 以 `(function(){"use strict";` 開頭（非 `import`） |
| `yarn test:artifacts` | 結束碼 0；**10/10** PASS（chrome 5＋firefox 5） |
| `yarn test:audio-lock` | 結束碼 0；**5 files / 117 tests** PASS |
| `yarn typecheck:audio-lock` | 結束碼 0 |

## e2e 並列表（任務 2 Step 5）

指令（逾時 300s／次；profile 在 `.cache/e2e-browser/`）：

```bash
node tests/e2e-browser/audio-lock/run.mjs fix  dist_chrome .cache/e2e-browser/fix.json   # exit 0
node tests/e2e-browser/audio-lock/run.mjs mvp  /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/mvp.json  # exit 0
node tests/e2e-browser/audio-lock/run.mjs none none .cache/e2e-browser/none.json           # exit 0
node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix.json .cache/e2e-browser/mvp.json \
  docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json .cache/e2e-browser/none.json  # exit 0
```

`yarn e2e:audio-lock`（fix vs 證據 MVP）：結束碼 **0**，約 79s。

| 檢查 | fix | mvp（現場） | mvp（證據檔） | none |
| --- | --- | --- | --- | --- |
| 頁面腳本有跑 | yes | yes | yes | no |
| Twitch 晚播後 | YT | YT | YT | TW |
| 自己取消靜音後 | YT | YT | YT | TW |
| 延遲＋重複 6 次後 | YT | YT | YT | TW |
| 延遲期間被搶次數 | 0 | 0 | 0 | 116 |
| YouTube 被靜音取樣／總取樣 | 0/168 | 0/168 | 0/168 | 156/168 |
| 使用者點 Twitch 後 | TW | TW | TW | TW |
| AudioLock 警告數 | 0 | 0 | 0 | 0 |
| 判定（候選條件） | PASS | FAIL (flags.v3/newHandle) | FAIL (flags.v3/newHandle) | FAIL（搶聲） |

說明：`compare.mjs` 結束碼只看**第一欄候選**；MVP 欄的「判定 FAIL (flags.v3/newHandle)」是因為候選條件要求正式版的 `HOLODEX_PLUS_INSTALLED_V3`＋`__HDX_AUDIO_LOCK_HANDLE__`，MVP 用不同旗標／把手，鎖定行為列與 fix 相同。`none` 對照組確認 harness 有效（Twitch 搶走）。

fix.json 關鍵值：`flags.v3=true`、`newHandle=true`、`errors=[]`、無 SyntaxError、無 `[Holodex+ AudioLock]` 警告。

## 最終驗證數字

環境：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；逾時用 `perl -e 'alarm N; exec @ARGV' --`。

| 指令 | 逾時 (s) | 結束碼 | 數字／備註 |
| --- | ---: | ---: | --- |
| `yarn install --frozen-lockfile` | 180 | 0 | Already up-to-date |
| `yarn test:artifacts`（重建後） | 120 | 0 | **10 pass / 0 fail** |
| `yarn test:audio-lock` | 180 | 0 | **5 files / 117 tests** |
| `yarn typecheck:audio-lock` | 120 | 0 | 通過 |
| `node .cache/audio-lock-lint/run.cjs`（scoped） | 120 | 0 | 0 error、0 warning（僅 React version 設定提示） |
| `yarn build:chrome` | 180 | 0 | holodex-inject 36.53 kB，IIFE |
| `yarn build:firefox` | 180 | 0 | 同上 |
| `yarn e2e:audio-lock` | 300 | 0 | compare PASS；約 79s |
| 現場 mvp／none harness | 300 | 0／0 | 見上表 |
| 殘留 `prof-*` | — | — | 無 |

ESLint：沿用既有 `.cache/audio-lock-lint/`（parser/plugin 已裝），**無缺 plugin blocker**。本輪未改 `src/**`，scoped lint 範圍與既有相同。

## 偏離

1. **`run.mjs` 的 `done()`**：在 `proc.kill('SIGKILL')` 與 `fs.rmSync(prof, …)` 之間多等 200ms，避免 macOS 上 Chrome 尚未放開檔案導致 profile 殘留。計畫要求的 kill→rm 順序不變；未再使用 `/tmp/hplus-repro`。
2. **頁面腳本無 sourcemap**：內層 IIFE build 設 `sourcemap: false`，與計畫取捨一致（production 原本也無；`__DEV__` 下此檔亦無 map）。
3. **ROOTCAUSE「其他差異」1–4**：依計畫本輪不做；e2e 以「無 AudioLock 警告」監測降級／契約失配。

## 未完成的人工項目

- Firefox `about:debugging` 載入 `dist_firefox`，確認 `window.HOLODEX_PLUS_INSTALLED_V3 === true`、console 無 `Cannot use import statement`（計畫列為 Fi 人工，不阻擋 Codex 驗收）。
- Fi 在 M1 Vivaldi 的真機確認。

## 產品／測試 commit 一覽

| SHA | 訊息 |
| --- | --- |
| `f59dbb5ea05a3f69a1cef06a646a809fb8257eca` | `fix(build): emit holodex page script as a standalone classic script` |
| `d1991086b75b011f12235d01dc598271175a9271` | `test(e2e): add headless Chrome audio lock harness for holodex.net` |
| （本 commit） | `docs: add twitch-audio-lock implementation report 4` |
