VERDICT: PASS

# Twitch audio lock fix-4 實作驗收 5

最終驗收完成；無 high／medium／low 發現。先提交測試／建置證據（df1856e），再完成本次瀏覽器與邊界驗收。

審查基準：`a034127ca878489a53b15f0403bb1c78dd5162e8`（計畫 commit）。受審 HEAD：`e1331e407298c6bab244d7034b89276263f0a809`。範圍為其後四個 commit：`7b78c4044c1aeb945c318372d81bfc64b32dd4a5`、`6d5079160659ef9cabfe53e5f7b5d734f26c1c4a`、`373e1af38d76c1b200a98ee46683f020b7cc2c53`、`e1331e407298c6bab244d7034b89276263f0a809`。

repo 與父目錄未找到 AGENTS.md／CLAUDE.md，採用本次派工的 Code Review Rules。所有結果由驗收者重跑，未採信實作報告數字。

## 實跑結果

每個指令均設外層逾時；npm/yarn/TMPDIR 皆指向本 worktree `.cache/`。下表 yarn 指令實際均以 `npx --yes yarn@1.22.22` 執行。

| 指令 | 逾時秒 | 結束碼 | 數量／結果 |
| --- | ---: | ---: | --- |
| `yarn test:audio-lock` | 180 | 0 | 6 files；128 passed，0 failed／skipped |
| `yarn typecheck:audio-lock` | 180 | 0 | 兩段 tsc；0 errors |
| `node .cache/audio-lock-lint/run.cjs` | 180 | 0 | 0 errors／0 lint warnings |
| `node .cache/audio-lock-lint/run.cjs --max-warnings 0 --ext .ts,.mjs tests/e2e-browser/audio-lock/run.mjs tests/e2e-browser/audio-lock/compare.mjs` | 180 | 0 | 2 檔；0 errors／0 lint warnings |
| `yarn build:chrome` | 240 | 0 | 41 modules |
| `yarn build:firefox` | 240 | 0 | 41 modules |
| `yarn test:artifacts` | 180 | 0 | 2 suites；10 passed，0 failed／skipped |
| `npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/rebind.test.ts tests/audio-lock/state.test.ts`（cwd：`.cache/review5/red`；基準 src＋本輪測試） | 180 | 1（預期） | 39 tests：7 failed／32 passed；M1、M2 與 Twitch 首播重現 YT 被靜音 |
| `yarn eslint --max-warnings 0 src/pages/content/holodex/audio-lock tests/audio-lock` | 60 | 2（既有 blocker） | 缺 `@typescript-eslint/eslint-plugin`，未新增依賴 |
| 獨立 node vm／manifest 注入檢查 | 60 | 0 | 4 個頁面腳本全數通過 |
| `npx --yes yarn@1.22.22 --cwd .cache/review5/edges vitest run --config vitest.audio-lock.config.ts tests/audio-lock/rebind.test.ts` | 180 | 0 | 10 passed（6 既有＋4 個驗收者探針） |
| `node tests/e2e-browser/audio-lock/compare.mjs .cache/review5/compare-negative-<check>.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`（5 次） | 各 30 | 各 1（預期） | 5/5 正確拒絕不符新增條件的資料 |

範圍 lint 的 stderr 有工具設定提示 `React version not specified`；不是 ESLint 規則 warning（`--max-warnings 0` 仍 exit 0）。計畫排除的 fakes.js（既有 5 項）與 vite.config.base.ts（既有 2 項）不列本輪缺陷。

## 產物與範圍核對

已沿原始碼 `inject()`（text/javascript）與兩處實際注入入口追到建置 referrer；Chrome／Firefox 各有 `holodex-inject.ts-B2IN2u5h.js`、`inject.ts-CQQBYCft.js`。4/4 均可由 `new vm.Script` 解析，無動態 import／import.meta，且列於對應 Holodex／YouTube 的 web_accessible_resources。Holodex 腳本 SHA-256：`b1cbe45576d57f4dfd3c8f831654b6f8485ad8f579894c11aac394f215570c14`；yt-chat：`e464fbc1c3f3c43a0e87b51ea3d07164c52b394559da8026e6370538ee0bef55`（兩瀏覽器相同）。

既有 117 個測試名稱與順序維持，沒有修改既有測試斷言。src 僅改 contracts.ts、state.ts、controller.ts；package.json、yarn.lock、建置設定、產物測試未改；fakes.js 與證據逐位元相同。基準 src 測試使用 worktree 內副本，未修改或 revert 產品檔案。

實作報告五份原始 JSON 的 SHA-256 已獨立重算，5/5 與報告相符。未發現跳過／only 測試。

## 瀏覽器驗收

本機 `/Applications/Google Chrome.app`（155.0.8059.80）headless，載入新建置 `dist_chrome`；MVP 僅唯讀載入 `/Applications/Extensions/holodex-plus-audiolock-chrome`，另並列既有 MVP 證據。所有 profile 位於 `.cache/e2e-browser/`，未使用使用者 profile；五次執行後 `prof-*` 殘留 0。

每次實跑 `node tests/e2e-browser/audio-lock/run.mjs <label> <extension> .cache/e2e-browser/<label>.json`，內建 240 秒逾時，外層 `python3 .cache/run-with-timeout.py 280`。每次另跑 `node tests/e2e-browser/audio-lock/compare.mjs <result.json> docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`，逾時 30 秒。完整實際參數、結束碼、秒數、原始 JSON 與基準都保存在提交的 `twitch-audio-lock-fix-4-harness-result.json`。

| label | extension | run 結束碼 | compare 結束碼 | 秒數 | timeline／播放前取樣 |
| --- | --- | ---: | ---: | ---: | --- |
| review5-fix-1 | `dist_chrome` | 0 | 0 | 63.89 | 188／50 |
| review5-fix-2 | `dist_chrome` | 0 | 0 | 63.55 | 188／50 |
| review5-fix-3 | `dist_chrome` | 0 | 0 | 63.58 | 188／50 |
| review5-mvp | `/Applications/Extensions/holodex-plus-audiolock-chrome` | 0 | 1 | 63.54 | 188／50 |
| review5-none | `none` | 0 | 1 | 63.69 | 188／50 |

| 檢查 | review5-fix-1 | review5-fix-2 | review5-fix-3 | review5-mvp | review5-none | mvp |
| --- | --- | --- | --- | --- | --- | --- |
| 頁面腳本有跑 | yes | yes | yes | yes | no | yes |
| reload 前 YT 被設靜音取樣 | 0/12 | 0/12 | 0/12 | 0/12 | 0/12 | — |
| reload 後播放前 YT 被設靜音取樣 | 0/38 | 0/38 | 0/38 | 0/38 | 0/38 | — |
| 播放前初始 YT store | false | false | false | false | false | false |
| Twitch 晚播後 | YT | YT | YT | YT | TW | YT |
| 自己取消靜音後 | YT | YT | YT | YT | TW | YT |
| 延遲＋重複 6 次後 | YT | YT | YT | YT | TW | YT |
| 延遲期間被搶次數 | 0 | 0 | 0 | 0 | 116 | 0 |
| YouTube 被靜音取樣／總取樣 | 0/168 | 0/168 | 0/168 | 0/168 | 156/168 | 0/168 |
| 使用者點 Twitch 後 | TW | TW | TW | TW | TW | TW |
| AudioLock 警告數 | 0 | 0 | 0 | 0 | 0 | 0 |
| 判定 | PASS | PASS | PASS | FAIL (flags.v3/newHandle) | FAIL (flags.v3/newHandle, afterBothPlay, afterSelfUnmute1, afterLaggedRepeats, everStolenDuringLag, ytMutedSamples/samples) | FAIL (flags.v3/newHandle, preReloadYtStoreMuted, prePlayYtStoreMuted) |

三次 fix 的個別 compare 均為 exit 0，為連續三次成功；整體六欄 compare（第一欄為 fix-1）亦為 exit 0。現場 MVP 僅因 `flags.v3/newHandle`（實際缺 newHandle）判 FAIL，行為與新 build 相同；舊 MVP 證據另因無新版播放前欄位而顯示相應 FAIL，僅供行為對照。none 如預期重現搶聲，故 compare exit 1，不屬候選版本的失敗。

情境確認：YT 先播、TW 晚 3 秒；無操作自行取消靜音一次；靜音延遲 2500ms，每 4 秒自行取消靜音，共六次。三次 fix 皆頁面腳本執行、YT 持續有聲、TW 被壓回靜音；播放期間 YT 靜音取樣 0/168，最後 CDP 真實滑鼠點入 Twitch iframe 並取消靜音後切換為 TW。獨立從原始陣列重算三次 fix：各有 50 個有效播放前取樣（無 err，storeA 全為 false）、188 個 timeline 取樣（播放情境 168＋使用者切換後 20）；非只信 checks 摘要。三次 fix 的 harness `errors` 陣列皆空、SyntaxError 與 AudioLock 警告皆為 0。

console 並非完全無例外：fix-1／2／3、MVP、none 的 Runtime.exceptionThrown 各為 4／5／4／4／4，URL 來自 Google Tag Manager 與 Holodex 站點腳本（其中 fix-2 另有一筆 MultiView）。沒有 chrome-extension URL 的例外；原始內容已完整保留於 JSON，未把站點例外隱藏成「console 全部乾淨」。

本輪 run.mjs 使用 5/8 次；Chrome／Firefox build 各一次（兩個 build 子命令）。2026-10-17 本輪工作在 60 分鐘上限內完成。所有工具逾時均未觸發。

## 邊界與計畫遵循

四個獨立探針保存在 `.cache/review5/edges/tests/audio-lock/rebind.test.ts`；以本輪 src 的隔離副本實跑，未改 repo 的 src／tests：

| 探針 | 結果 |
| --- | --- |
| Twitch 以物件型 video 晚綁定，snapshot 原先猜 youtube | active 承接為 twitch，store b=false／a=true，mode 維持 locked |
| 相同 contentId，provider 從 YouTube 改 Twitch | 進 silence，active=null，沒有誤承接 |
| VideoCell 不變、只重建 player，並送舊 READY | generation 更新、active 指向新 binding，YT muteCalls=0，保持 locked |
| 重建非 active 的 Twitch player，播放器初始自行有聲 | active 與 epoch 不變，Twitch 被壓回靜音，YT store 保持 false |

原有新增測試亦覆蓋換片進 silence、grant／intent 失效、500ms 不誤降級、Twitch 首播不搶聲與面板 unmute 切換。五種 compare 負向探針分別設 preReloadYtStoreMuted=1、preReloadSamples=9、prePlayYtStoreMuted=1、prePlaySamples=29、initial.storeA=true，皆 exit 1。

已逐行核對與計畫差異：syncBindings 結尾額外 checkStoreSettle、remount 同步 settle target／epoch，與 late-bind 的收斂檢查一致，未變更 bootstrap、silence、意圖窗、PLAYER_READY 正規化或 TIMING。產品只修改三個允許檔案；未見計畫外功能變動。沒有使用 plugin skill、push、PR、merge、notarize 或 sudo；只提交驗收報告與 harness JSON。

本 harness 在真實 holodex.net 上以相同 fake SDK 對照 MVP；Firefox 真機載入與 Fi 的 M1 Vivaldi 實測仍為人工交付項目。本輪未觀察到第三條造成播放前 YT 靜音的路徑。

## 發現清單

No issues found. Checked for bugs and AGENTS.md compliance.

## 給 Fi

這輪驗收 PASS，三次新 build 連續通過，行為與現場 MVP 一致。沒有播放前就把 YouTube 靜音的情況，播放期間也都是 0/168 靜音取樣，Twitch 自行取消靜音後會被壓回。使用者真的點入 Twitch 並取消靜音時，能正確切換音源。128 個單元測試、typecheck、範圍 lint、兩套建置、10 個產物測試與額外邊界探針均通過；Firefox 真機及 M1 Vivaldi 留待人工實測。

VERDICT: PASS
