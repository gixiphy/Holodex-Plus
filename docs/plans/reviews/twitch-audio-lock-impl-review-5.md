VERDICT: FAIL

# Twitch audio lock fix-4 實作驗收 5（第一階段）

此為先提交的測試／建置證據；瀏覽器與邊界驗收尚未完成，暫不放行。

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
| 基準 src＋本輪測試，在 `.cache/review5/red` 的隔離副本跑 vitest（state、rebind） | 180 | 1（預期） | 39 tests：7 failed／32 passed；M1、M2 與 Twitch 首播重現 YT 被靜音 |
| `yarn eslint --max-warnings 0 src/pages/content/holodex/audio-lock tests/audio-lock` | 60 | 2（既有 blocker） | 缺 `@typescript-eslint/eslint-plugin`，未新增依賴 |
| 獨立 node vm／manifest 注入檢查 | 60 | 0 | 4 個頁面腳本全數通過 |

範圍 lint 的 stderr 有工具設定提示 `React version not specified`；不是 ESLint 規則 warning（`--max-warnings 0` 仍 exit 0）。計畫排除的 fakes.js（既有 5 項）與 vite.config.base.ts（既有 2 項）不列本輪缺陷。

## 產物與範圍核對

已沿原始碼 `inject()`（text/javascript）與兩處實際注入入口追到建置 referrer；Chrome／Firefox 各有 `holodex-inject.ts-B2IN2u5h.js`、`inject.ts-CQQBYCft.js`。4/4 均可由 `new vm.Script` 解析，無動態 import／import.meta，且列於對應 Holodex／YouTube 的 web_accessible_resources。Holodex 腳本 SHA-256：`b1cbe45576d57f4dfd3c8f831654b6f8485ad8f579894c11aac394f215570c14`；yt-chat：`e464fbc1c3f3c43a0e87b51ea3d07164c52b394559da8026e6370538ee0bef55`（兩瀏覽器相同）。

既有 117 個測試名稱與順序維持，沒有修改既有測試斷言。src 僅改 contracts.ts、state.ts、controller.ts；package.json、yarn.lock、建置設定、產物測試未改；fakes.js 與證據逐位元相同。基準 src 測試使用 worktree 內副本，未修改或 revert 產品檔案。

## 瀏覽器驗收

| 項目 | 新 build | MVP |
| --- | --- | --- |
| Chrome headless | 待跑連續三次 | 已確認現場唯讀目錄存在，待跑 |

## 發現清單

尚未完成瀏覽器與邊界驗收；目前無已確認的產品缺陷。

## 給 Fi

128 個測試與兩套建置皆已實跑通過。四個注入產物都能以傳統 script 解析，沒有再出現 fix-3 的格式問題。隔離重跑舊產品碼可重現沒有播放就把 YouTube 靜音。Chrome 與 MVP 實測尚待完成，本階段先保存證據而不放行。

VERDICT: FAIL
