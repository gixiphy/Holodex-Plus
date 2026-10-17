VERDICT: FAIL

# Twitch audio lock fix-5 implementation review 7

DISPATCH-2610180330049797。受審基準 `9b1cab9`，受審 HEAD `d680a7d9b59a25d54a685ccbe871368e9aed5a15`（`git rev-parse HEAD` 實取）。Codex 驗收；Apple M5／arm64；2026-10-18 03:30 Asia/Taipei 開始。根目錄無 AGENTS.md／CLAUDE.md，依派工 Code Review Rules。先提交測試、build、範圍驗證，再做真直播；此版尚未完成真直播，FAIL 是未達交付門檻。

## 實跑結果

全部 cache／暫存放本 worktree：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。yarn 固定 `npx --yes yarn@1.22.22`。下表每項外層均使用 `perl -e 'alarm N; exec @ARGV' --`。

| 指令（N 秒逾時） | 結束碼 | 數量／實測結果 |
| --- | --- | --- |
| `npx --yes yarn@1.22.22 --cwd .cache/review7/baseline test:audio-lock tests/audio-lock/twitch-broken.test.ts`（180） | 1 | 17 tests：2 failed／15 passed；兩個 same_iframe 測試均 `expected a to be b`；expiry PASS |
| `npx --yes yarn@1.22.22 test:audio-lock`（240） | 0 | 8 files／167 passed／0 skipped |
| `npx --yes yarn@1.22.22 typecheck:audio-lock`（240） | 0 | 兩份 tsconfig 通過 |
| `npx --yes yarn@1.22.22 build`（240） | 0 | Chrome、Firefox；build 1 次 |
| `npx --yes yarn@1.22.22 test:artifacts`（240） | 0 | 10 passed／0 skipped |
| `node --check tests/e2e-browser/audio-lock/live.mjs`（30） | 0 | 受審版本與驗收 harness 版本均通過 |
| `node --check tests/e2e-browser/audio-lock/live-compare.mjs`（30） | 0 | 通過 |
| `node tests/e2e-browser/audio-lock/run.mjs review7-fake-1 dist_chrome .cache/review7/fake-1.json`（260） | 0 | compare（30 秒）exit 0；YT muted 0/168、切換後 TW、warnings 0 |
| `node tests/e2e-browser/audio-lock/run.mjs review7-fake-2 dist_chrome .cache/review7/fake-2.json`（260） | 0 | compare（30 秒）exit 0；YT muted 0/168、切換後 TW、warnings 0 |
| `node tests/e2e-browser/audio-lock/run.mjs review7-fake-3 dist_chrome .cache/review7/fake-3.json`（260） | 0 | compare（30 秒）exit 0；YT muted 0/168、切換後 TW、warnings 0 |

每次 compare 的第二參數均為 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`。假播放器 JSON 留在 `.cache/review7`，依本次限制不提交；只提交真直播 JSON。

red 驗證在 `.cache/review7/baseline` 隔離副本進行：複製目前 src／測試／設定，兩個本輪 src 檔以 `git show 9b1cab9:<path>` 還原；正式 src 完全未改。兩個失敗都到達 active 選聲斷言，沒有 import/helper error；第三個 expiry 測試 red／green 兩邊皆 PASS。

範圍實查：src 只有 controller 的四行移除、twitch-embed 的檔頭註解。onFocusIn 清意圖、TIMING、listener 註冊不變。package.json、yarn.lock、建置設定、tests/build-artifacts、run.mjs、compare.mjs、evidence、舊 reviews 均未動；fakes.js 與指定證據逐位元相同。既有測試／helper 沒有刪除或修改，新增測試無 skip/only。實作報告的 10 份 JSON SHA-256 全數吻合。

## 真直播結果

尚待執行。總 e2e 額度 8 次＝假播放器 3＋normal 3＋fallback 1＋MVP 1。

## 發現清單

尚待真直播實證後定稿。

## 給 Fi 的摘要

同一 iframe 第二次點擊的兩條路徑已通過新增測試，還原修正後也確實變紅。167 項測試、typecheck、雙瀏覽器 build 與 artifacts 均通過。真直播與產品缺口分類尚未完成，因此目前不能交付。

VERDICT: FAIL
