VERDICT: PASS

# Twitch audio lock 實作驗收第 3 輪

已依序完成：實跑驗證、上一輪五項重驗、新增問題與產物審查。本輪未發現 high／medium／low。
受驗 HEAD：`04000118bfac3f9b5b9b4d65bfee8017c73dbcd0`（不含審查報告提交）。範圍：`5613891..04000118bfac3f9b5b9b4d65bfee8017c73dbcd0`，已用 git log 確認。根目錄沒有 AGENTS.md／CLAUDE.md，採 dispatch 規則。

## 測試／build 實跑結果

以下 yarn 均為 `npx --yes yarn@1.22.22`；npm、Yarn、TMPDIR 均在 worktree `.cache`。全部用 `.cache/run-with-timeout.py` 包住，逾時回 124；原始輸出在 `.cache/review3-*.log`。

| 指令 | 逾時 | 結束碼 | 數量／結果 |
| --- | --- | --- | --- |
| `yarn install --frozen-lockfile --non-interactive` | 300s | 0 | 依賴已就緒 |
| `yarn test:audio-lock` | 120s | 0 | 5 files、117 tests passed（state 28、adapter 13、players 14、settings 14、controller 48） |
| `yarn typecheck:audio-lock` | 120s | 0 | 產品與測試兩段 tsc 通過 |
| `node .cache/audio-lock-lint/run.cjs` | 120s | 0 | scoped 0 error、0 warning |
| 同 lint wrapper，options.ts／contentScript.ts／holodex-inject.ts，`--format json` | 120s | 1 | 3 errors、0 warning；ban-ts-comment，仍為整合 lint blocker |
| `yarn build:chrome` | 180s | 0 | dist_chrome 建置成功 |
| `yarn build:firefox` | 180s | 0 | dist_firefox 建置成功 |
| 同 lint wrapper，`git show 709e963` 三個整合檔的 worktree 暫存副本 | 120s | 1 | 同樣 3 errors、0 warning；ban-ts-comment，無新增 |
| `yarn vitest run --config .cache/review3-vitest.config.ts` | 120s | 0 | 獨立 probe：1 file、15 tests passed |
| `git diff --check 5613891 0400011 -- src tests` | — | 0 | 無空白錯誤 |
| `python3 .cache/review3-artifacts.py`（經 timeout wrapper） | 30s | 0 | 每個 dist：24 個 manifest 引用、23 個 JS／HTML 靜態引用，缺檔 0 |
| fix-2 readiness shape grep（Python 等價 regex，保留 cell 賦值例外） | — | 0 | 命中 0 |

JSON lint formatter 用於保留可核對診斷；與計畫 unix formatter 檢查相同檔案和規則。build 與 scoped lint 成功不代表全倉 lint 通過。

## 發現清單

No issues found. Checked for bugs and AGENTS.md compliance.

## 第 2 輪五項問題及 fix-2 驗收逐條核對

| 第 2 輪項目 | 結果 | 產品與實跑證據 |
| --- | --- | --- |
| 1 high：虛構 player.ready | 已解決 | players.ts:122-146 以父 cell late-bind；:188-219 以 Vue ready 訊號。controller.ts:487 傳父 cell，不讀 component.ready／twPlayer／ytPlayer。獨立 probe 兩 provider × READY 前後安裝共四例，皆成功綁定且 B 自行 unmute 被壓回，active A 不變。 |
| 2 high：同值設定重送 | 已解決 | controller.ts:1184 同值返回；state.ts:392-395 同值 ENABLE 返回原狀態。probe 重送三次 true，完整 state 不變、B rawMuted 被壓回；三次不可用讀取進 degraded 後重送 true 保持 latch。正式 reducer 測試涵蓋 locked／waiting-for-choice／degraded。 |
| 3 medium：降級取消路由監聽 | 已解決 | routeTimer 已移至 controller，teardown／failSession／pagehide 不取消；只有停用／dispose 取消。probe 真 pushState 離開 2000ms 再回 4000ms，恢復 locked、兩個 bindings，且 B guard 有效；disable timer 回到 0。非 multiview 啟動 122 秒無警告，進入後可綁定；pagehide 保留 route bootstrap、BFCache pageshow 重建、dispose timer 為 0。 |
| 4 medium：Mute Others 初始 off 觸發 root-timeout | 已解決 | tryDiscover 不再因 off 提早 teardown，保留合法 store watcher。probe 等 122 秒仍 disabled、無警告，off 時 setMuted(false) 委派原 muteOthers；開啟後 locked 且 B rawMuted 被壓回。正式測試亦驗證 active A 與兩個 bindings。 |
| 5 medium：READY 缺 SDK method 不降級 | 已解決 | players.ts:173-185、:200-204 mismatch latch／microtask 一次回報；controller.ts:514-518 整組 failSession。獨立 probe 逐一移除 Twitch getMuted／setMuted、YouTube isMuted／mute／unMute：READY 前不誤降級，READY 後 cell-contract-changed、warn 恰一次、兩格全部四種 wrapper 還原。Twitch script 未載入且 player={}、無 READY 時仍只是 not-ready。 |

額外 stale YouTube probe：保留前一 component 的 cell.ytPlayer，新的 component.$el 不含舊 iframe，readMuted 正確為 not-ready；刻意讓 port 的 READY callback 早於 cell.onReady（cell 仍存舊參考），仍能綁新 wrapper、實際 mute 新 SDK。所有 probe 僅在 `.cache`，未修改正式測試或產品。

## Fi 硬性上游契約核對

僅讀 `.ref/holodex` 必要行，基準 `8c6d0da`：

- `src/components/player/PlayerMixin.ts:27-35,43-48`：data 沒有 ready；playerReady 套用 mute 並 emit ready。
- `TwitchPlayer.vue:1-3,40-43,86,92-95,116-122`：SDK 先於 READY 存在，READY 傳 component.player，同一物件存入 cell.twPlayer；公開 getMuted／setMuted。
- `YoutubePlayer.vue:1-3,53-69,104-107,117-119`：component.player 是 wrapper，READY 傳 raw e.target；mute methods 綁 wrapper，raw 僅用於 getIframe containment。
- `src/components/multiview/VideoCell.vue:11-49,72,79-80,134-139,210-226`：ref=player、@ready=onReady、YouTube key 重建、Twitch async；SDK refs 在父 cell，換片只清另一 provider 參考，manualCheckMuted 經 player.isMuted。

fixture 檔頭已引用上游來源；player component 無 ready／twPlayer／ytPlayer，YouTube raw 與 wrapper 不同，raw.getIframe 在 component.$el 內；同 provider YouTube 換片保留舊 cell.ytPlayer。`fixture_matches_upstream_player_shape` 隨正式 117 tests 通過。計數、listeners、__provider 等為測試儀器，產品不讀取，未用其替代上游 readiness 契約。

正式測試新增 16 個；實作報告記錄了拿掉修正時的失敗摘要，本輪以獨立行為 probe 驗證結果，不將歷史 TDD 敘述當成本輪實跑證據。

## 新增問題、範圍及產物審查

- 已用 `git log --format='%H %s' --name-only 5613891..0400011` 與 `git diff 5613891 0400011` 核對全部 7 個 commit／10 個檔案：5 個產品 commit 僅修改 fix-2 白名單中的 3 個產品模組與 5 個測試／fixture 檔，訊息皆英文且不夾 docs。另兩個 docs commit 分別為 fix-2 兩個標題更名（642d2ab）與 impl-3 報告（0400011），前者未變動計畫規格。
- 禁改清單（package／lock／configs／整合入口／utils／settings／.ref）的 `git diff --stat 5613891 0400011` 為空。沒有新增模組、測試檔、依賴、權限或 options UI；沒有跨功能 helper、另一個 layout PR 的產品依賴或超出第一 PR 的改動。共享檔案與未來上游整理仍依主計畫；本輪無新增該類衝突點。
- 新增程式逐 hunk 檢查未發現 placeholder／空實作／過度設計。事件路徑和 late-bind 仍綁定 Twitch 原 SDK、YouTube wrapper；沒有讀 SDK 私有欄位、iframe window、修改 SDK／Vue observer／全域 constructor。修正沒有改動 Fi 決定紀錄的選聲、grant、全靜音、2500ms 意圖或一次警告政策。
- Chrome／Firefox 產物 manifest 可解析，MV3 必要基本欄位、版本格式及各自 background 入口存在；每份 24 個 manifest 資源引用和 23 個 JS／HTML 靜態傳遞引用均存在。page bundle 無 storage.local／webextension-polyfill 字串，manifest 來源與權限未改。這是 unpacked 結構的靜態檢查，沒有實際安裝到瀏覽器，不能據此宣稱真機載入與音訊人工清單完成。
- 整合 lint 仍受 baseline 三則 ban-ts-comment 阻擋，沒有新增診斷；scoped lint 的 React version 提示與測試中的 Browserslist 過舊提示不是新產品缺陷。真瀏覽器人工清單與廣告／重連情境仍未實測，保留原計畫交付門檻，不將既有未完成項重報為本輪新增 bug。
- 本輪只提交此報告，probe／工具／日誌在 worktree `.cache`，build 產物未提交；未改產品或計畫，未 push、開 PR、merge、執行公證或 sudo。

## 給 Fi 的摘要

本輪判定 PASS：上一輪兩個 high、三個 medium 已逐條重驗解決，未發現新增問題。正式 117 tests、獨立 15 個 probe、typecheck、scoped lint 與兩個 build 均通過，READY 與 fixture 已對照真實上游。整合 lint 三則錯誤與上游 baseline 相同，仍列為 blocker。兩份產物的靜態引用完整，真瀏覽器載入與人工音訊驗收仍待完成。
