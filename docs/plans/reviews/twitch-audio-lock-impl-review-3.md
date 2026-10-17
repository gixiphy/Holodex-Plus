VERDICT: PASS

# Twitch audio lock 實作驗收第 3 輪

階段 2 紀錄：五個上一輪問題已重驗解決，尚待新增問題審查完成；最終判定以後續更新為準。
受驗 HEAD：`04000118bfac3f9b5b9b4d65bfee8017c73dbcd0`（不含審查報告提交）。範圍：`5613891..04000118bfac3f9b5b9b4d65bfee8017c73dbcd0`，已用 git log 確認。根目錄沒有 AGENTS.md／CLAUDE.md，採 dispatch 規則。

## 測試／build 實跑結果

以下 yarn 均為 `npx --yes yarn@1.22.22`；npm、Yarn、TMPDIR 均在 worktree `.cache`。全部用 `.cache/run-with-timeout.py` 包住，逾時回 124；原始輸出在 `.cache/review3-*.log`。

| 指令 | 逾時 | 結束碼 | 數量／結果 |
| --- | --- | --- | --- |
| `yarn install --frozen-lockfile --non-interactive` | 300s | 0 | 依賴已就緒 |
| `yarn test:audio-lock` | 120s | 0 | 5 files、117 tests passed |
| `yarn typecheck:audio-lock` | 120s | 0 | 產品與測試兩段 tsc 通過 |
| `node .cache/audio-lock-lint/run.cjs` | 120s | 0 | scoped 0 error、0 warning |
| 同 lint wrapper，options.ts／contentScript.ts／holodex-inject.ts，`--format json` | 120s | 1 | 3 errors、0 warning；ban-ts-comment，仍為整合 lint blocker |
| `yarn build:chrome` | 180s | 0 | dist_chrome 建置成功 |
| `yarn build:firefox` | 180s | 0 | dist_firefox 建置成功 |
| 同 lint wrapper，`git show 709e963` 三個整合檔的 worktree 暫存副本 | 120s | 1 | 同樣 3 errors、0 warning；ban-ts-comment，無新增 |
| `yarn vitest run --config .cache/review3-vitest.config.ts` | 120s | 0 | 獨立 probe：1 file、15 tests passed |
| `git diff --check 5613891 0400011 -- src tests` | — | 0 | 無空白錯誤 |

JSON lint formatter 用於保留可核對診斷；與計畫 unix formatter 檢查相同檔案和規則。build 與 scoped lint 成功不代表全倉 lint 通過。

## 發現清單

目前無確認的 high／medium／low；新增問題審查待完成。

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

## 給 Fi 的摘要

上一輪兩個 high、三個 medium 已逐條重驗解決。正式 117 tests 與獨立 15 個 probe 全通過，READY 和 fixture 均已對照真實上游。整合 lint 三則錯誤與 709e963 baseline 相同，仍列為 blocker。尚待新增問題與產物靜態引用審查完成。
