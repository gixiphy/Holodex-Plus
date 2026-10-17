VERDICT: FAIL

# Twitch audio lock 實作驗收第 2 輪

已依序完成實跑、第一輪 high／medium 核對、整體審查；下列 SHA 一律指受驗版本，不包含本報告的提交。
受驗 HEAD：`445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`。
範圍：`c879311fe103f28085f664e0cbf3de64c46333f6`（Fi 決定紀錄 docs commit）之後至受驗 HEAD；已用 git log 與 git diff 確認。根目錄無 AGENTS.md／CLAUDE.md，採 dispatch 規則。

## 測試／build 實跑結果

Node v26.12.0；以下 yarn 均為 `npx --yes yarn@1.22.22`。npm、Yarn、TMPDIR 均在本 worktree `.cache`。每個指令由 `.cache/run-with-timeout.py` 以 process group 逾時控制，逾時回 124。

| 指令 | 逾時 | 結束碼 | 數量／結果 |
| --- | --- | --- | --- |
| `yarn install --frozen-lockfile --non-interactive --cache-folder "$YARN_CACHE_FOLDER"` | 300s | 0 | Already up-to-date |
| `yarn test:audio-lock` | 120s | 0 | 5 files、101 tests passed |
| `yarn typecheck:audio-lock` | 120s | 0 | 產品及測試兩段 tsc 通過 |
| `node .cache/audio-lock-lint/run.cjs` | 120s | 0 | scope 0 error、0 warning |
| 同 wrapper，options.ts／contentScript.ts／holodex-inject.ts，`--format json` | 120s | 1 | 3 errors、0 warning；皆 ban-ts-comment |
| 同 wrapper，`git show 709e963` 複製的上述三檔 baseline | 120s | 1 | 同樣 3 errors、0 warning；新 hunk 無新增診斷 |
| `yarn build:chrome` | 180s | 0 | dist_chrome 成功 |
| `yarn build:firefox` | 180s | 0 | dist_firefox 成功 |
| `git diff --check c879311 445f43f -- src tests package.json yarn.lock vitest.audio-lock.config.ts tsconfig.audio-lock.tests.json` | — | 0 | 產品改動無空白問題 |
| `yarn vitest run --config .cache/review2-vitest.config.ts`（額外 probe） | 120s | 1 | 6 tests：1 passed、5 failed；下列五項問題的重現 |

lint 整合檔仍受 baseline 的三則 `@ts-ignore` 阻擋，不能稱全倉 lint pass。React version 設定提示與 Browserslist 資料過舊提示不算本功能新診斷。
兩份 manifest 可解析為 MV3，逐一檢查 24 個引用（含重複 icon）均存在，Chrome service_worker 與 Firefox background.scripts 入口存在；另查 23 個 JS／HTML 靜態傳遞引用，兩份產物皆無缺檔；page bundle 只 import contracts chunk，無 polyfill／storage.local。manifest 來源未變、權限與 matches 未擴張。這是靜態 unpacked 結構檢查，未在真瀏覽器載入，不能宣稱真機清單已通過。

## 發現清單

### 1. [high] READY 判定依賴上游不存在的 player.ready，真實播放器永遠無法綁定

`src/pages/content/holodex/audio-lock/controller.ts:490-493 @ 445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`

```ts
      provider: binding.provider,
      isReady: () => {
        const comp = binding.playerComponent as { ready?: boolean } | null;
        return comp?.ready === true;
      },
      onReady: () => {
```

計畫指定的上游 TwitchPlayer／YoutubePlayer／PlayerMixin 均沒有 ready 布林欄位；PlayerMixin.playerReady 只套用 mute、初始化 listeners 並 `$emit("ready", player)`。READY 已發生的線索 twPlayer／ytPlayer 在父 VideoCell 上（VideoCell.vue:211–215），也不在此 player component。players.ts 的 ready listener 只重跑 tryBind，而 tryBind 仍要求此 isReady()，因此收到事件後仍永遠回 not-ready。所有 PlayerPort 輪詢、mute、grant restore、READY 正規化和 fallback 都無法工作，非 active 的 Twitch 可以持續出聲；這直接破壞核心功能。

fixtures.ts:276 人造了上游沒有的 `ready`，fireReady 還主動把它設 true，101 個測試因此沒有揭露問題。probe 移除該欄位、把 twPlayer 放回父 cell，發出相同 READY 後，兩個 port 的 isBound 都是 false，B 自行 unmute 後 rawMuted 仍 false。應以可撤銷 Vue READY 事件記錄 readiness，並用父 cell 的 SDK 參考處理 late-bind；測試須使用上游的欄位位置。

### 2. [high] 重送 enabled=true 將既有 session 留在 discovering，停止壓回非 active 音訊

`src/pages/content/holodex/audio-lock/controller.ts:1186-1190 @ 445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`

```ts
      if (disposed) return;
      enabled = value;
      if (value) {
        const result = transition(state, { type: "ENABLE", now: now() });
        state = result.state;
        startDiscoveryLoop();
      } else {
```

ENABLE 在 state.ts:402–406 無條件將 locked 改成 discovering；但 startDiscoveryLoop 發現 session 已存在就返回，沒有再送 DISCOVERED／STORE_SNAPSHOT 恢復 locked。pollObservation 在 discovering 直接返回，故 manualCheckMuted 持續攔住原生輪詢卻也不執行 guard mute，直到其他 store 變更才可能恢復。settings bridge 的 ready 回覆後重新讀 storage、pageshow 重新讀取，以及同值 config 都會正常重送 true，不需要使用者刻意呼叫內部方法。

probe 等初始 session 完成後重送一次 setEnabled(true)，讓 B 自行取消靜音並呼叫 patched manualCheckMuted：mode 變 discovering，rawMuted 保持 false，預期壓回 true 的斷言失敗。應讓相同設定冪等，保留既有 session 的狀態；回歸測試須驗證音訊保護仍有效，而非只檢查 timer 數量。

### 3. [medium] degraded 卸載連路由監聽一起取消，無法依計畫在重新進入 multiview 後恢復

`src/pages/content/holodex/audio-lock/controller.ts:882-886 @ 445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`

```ts
    }
    if (s.rafHandle != null) cancelRaf(s.rafHandle);
    if (s.coalesceTimer) cancel(s.coalesceTimer);
    if (s.heartbeatTimer) cancel(s.heartbeatTimer);
    if (s.pathnameTimer) cancel(s.pathnameTimer);
    if (s.storeSettleTimer) cancel(s.storeSettleTimer);
    if (s.fallbackTimer) cancel(s.fallbackTimer);
```

三次 SDK read 失敗後，`failSession()` 呼叫 teardown，連 pathname timer 也被取消，但 `pathnameWatching` 仍為 true。此後離開再返回 multiview 不再有 callback 設定 leftMultiview／RESET_DEGRADED，保護持續停用；只能重新開設定或 reload。這違反主計畫 §1 及修正計畫步驟 4.9–10 的「路由重新進入可恢復」。暫存 probe 透過真 controller 三次 throw read 進 degraded，離開 2000ms、返回 4000ms 後仍 degraded；預期恢復的斷言失敗。應讓路由 bootstrap 獨立於音訊 session 存活，並在停用／dispose 時釋放。

### 4. [medium] 啟動時 Mute Others 關閉被誤當 root 尚未找到，兩分鐘後永久停止探測

`src/pages/content/holodex/audio-lock/controller.ts:1025-1028 @ 445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`

```ts
    state = result.state;

    if (!found.store.state.multiview.muteOthers) {
      teardownSession();
      return;
    }

    if (discoveryTimer) {
```

已成功找到合法 store，卻在安裝 watch 之前返回。startDiscoveryLoop 因沒有 session 繼續計時，120 秒後 failSession(root-timeout) 停止全部探測；此後使用者才開啟 Mute Others，既沒有 store watcher 也沒有 discovery timer，無法啟用保護。這與「只有兩個開關都開才保護」的正常熱切換需求不符，關閉 Mute Others 本身不是契約失配。probe 以初始 muteOthers=false 等待 122 秒，再開啟並等待 4 秒：仍 degraded、bindings=0。應在合法 store 下保留開關監聽，將正常 off 等待與 root discovery timeout 分開處理。

### 5. [medium] 已 ready 且 SDK 存在卻缺必要 methods，仍永遠回 not-ready，不會依契約降級（`src/pages/content/holodex/audio-lock/players.ts:183-185 @ 445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`）

## 第一輪 high／medium 逐條核對

| 第一輪項目 | 結果 | 本輪依據 |
| --- | --- | --- |
| H1 120 秒後停止保護新格 | 已解決 | controller MutationObserver＋2000ms heartbeat；121 秒後新增格測試通過 |
| H2 generation／port／版面事件未接線 | 部分解決，實際 READY 仍不工作 | adapter registry、syncBindings dispose/rebind、LAYOUT_CHANGED／CELL_REMOVED／PLAYER_READY 均已接線；換 provider、VM、player 與 active 移除測試通過；另外用 probe 驗證 preset DOM 更新後仍 bootstrap；但真實上游 READY 無法 bind，見發現 1 |
| M3 refresh true 當明確命令 | 已解決 | panel 外走 OBSERVED_MUTED；bootstrap 不寫 true，active 尊重 grant／settle；兩 provider 測試 |
| M4 token 無 muted→unmuted 邊緣 | 已解決 | reducer 檢查 prev===true、token 與 settle；純狀態及 controller 測試 |
| M5 mute 限速／settle 未接線 | 已解決原報缺陷 | muteInFlight／cooldown／1500ms settle、三次不收斂、500ms store timer 已接線並有測試 |
| M6 degraded 不保持 | latch 已解決，恢復路徑未完成 | discover/rescan 不再自動重裝；實際路由恢復失敗，見發現 3 |
| M7 fixture muteOthersCalls 耦合 | 已解決 | authScope 計數 mapped 方法，src 無 muteOthersCalls；移除 fixture 計數欄位仍恰一次 |
| M8 fallback 舊 snapshot／不檢查 paused | 已解決 | timer 執行時重新 buildSnapshot，檢查 ready／editMode／paused 或 firstPlay；相應測試通過 |
| M9 必要回歸缺少 | 大部分補齊，尚未完全解決 | 101 tests 包含 grant 三入口、storage race、A→B→A、BFCache 等；但 route reentry 測試實際只關開設定，preset 測試接受 bootstrap 或 silence 且未驗證 merge，且 fixture ready 欄位掩蓋發現 1、重送設定只數 timer，故未能覆蓋計畫保證 |

額外 probe 僅在 `.cache`，未改產品或既有測試；使用原 Vitest config 延伸 include／exclude，保持 jsdom。最後實跑 6 tests，preset replacement 通過；真實 READY shape、同值 config、初始 Mute Others off、degraded 路由恢復與 SDK 缺 methods 共五個預期行為斷言失敗。最初 probe 執行曾因 yarn exec 未轉傳 config、以及預設排除 .cache 而受阻，修正臨時執行設定後才取得上述有效結果；不將環境錯誤當產品缺陷。

## 整體範圍與限制

- `git log --name-only c879311..445f43f` 共 15 個 commit：11 個產品／測試、4 個 docs；訊息均英文，產品 commit 未夾帶 docs 或非白名單路徑。`git diff c879311 445f43f` 共 23 檔；未改主計畫、產品 tsconfig、manifest、Vite configs、options UI、CI 或 flags。
- package／lock 的新增工具為 Vitest 3.2.6 與 jsdom 26.1.0 及其解析；沒有新 runtime dependency／權限，lint 工具保留在 .cache。整合 hunk 限於本功能 options／bridge／入口，無 layout 功能、新共用 helper 或對另一 PR 的 import／commit 相依；共享既有檔案仍依原計畫於未來整理上游分支時處理插入點衝突，本輪不建立該分支。
- 未見 placeholder／空產品實作／第一 PR 外功能。測試廣度有改善，但測到 fixture 契約不等於符合真實上游，發現 1 是本輪主要驗收缺口。
- 主計畫要求的真瀏覽器人工清單在實作報告仍全部未完成，本輪亦未執行安裝／真機驗收。沒有宣稱廣告、重連或 SecurityError 已在瀏覽器重現或修好。完整 diff --check 因 impl-2 報告 Markdown 行尾雙空白回 2；僅產品範圍回 0，未將 Markdown 格式列為 bug。

## 給 Fi 的摘要

本輪判定 FAIL：確認兩個 high 與三個 medium，第一輪生命週期與限速等多數缺陷雖已修正，實際 READY 契約仍使核心防護失效。實跑 101 個既有測試、typecheck、scoped lint 和兩個 build 皆通過，整合檔 lint 僅有 baseline 三則錯誤。額外六個 probe 中五個失敗，揭露不存在的 ready 欄位、同值設定重送、初始關閉與降級後恢復等測試盲點。兩份產物的 manifest 與靜態引用完整，但真瀏覽器人工清單仍未完成，建議修正上述行為並補足契約測試後再驗收。
