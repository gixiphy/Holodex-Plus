VERDICT: FAIL

# Twitch audio lock 實作驗收第 2 輪

階段 2 保存：已完成第一輪 high／medium 核對；整體新問題審查接續進行。
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

lint 整合檔仍受 baseline 的三則 `@ts-ignore` 阻擋，不能稱全倉 lint pass。React version 設定提示與 Browserslist 資料過舊提示不算本功能新診斷。
兩份 manifest 可解析為 MV3，逐一檢查 24 個引用（含重複 icon）均存在，Chrome service_worker 與 Firefox background.scripts 入口存在；這是靜態 unpacked 結構檢查，尚未在真瀏覽器載入。

## 發現清單

### 1. [medium] degraded 卸載連路由監聽一起取消，無法依計畫在重新進入 multiview 後恢復

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

## 第一輪 high／medium 逐條核對

| 第一輪項目 | 結果 | 本輪依據 |
| --- | --- | --- |
| H1 120 秒後停止保護新格 | 已解決 | controller MutationObserver＋2000ms heartbeat；121 秒後新增格測試通過 |
| H2 generation／port／版面事件未接線 | 主要缺陷已解決 | adapter registry、syncBindings dispose/rebind、LAYOUT_CHANGED／CELL_REMOVED／PLAYER_READY 均已接線；換 provider、VM、player 與 active 移除測試通過；另外用 probe 驗證 preset DOM 更新後仍 bootstrap |
| M3 refresh true 當明確命令 | 已解決 | panel 外走 OBSERVED_MUTED；bootstrap 不寫 true，active 尊重 grant／settle；兩 provider 測試 |
| M4 token 無 muted→unmuted 邊緣 | 已解決 | reducer 檢查 prev===true、token 與 settle；純狀態及 controller 測試 |
| M5 mute 限速／settle 未接線 | 已解決原報缺陷 | muteInFlight／cooldown／1500ms settle、三次不收斂、500ms store timer 已接線並有測試 |
| M6 degraded 不保持 | latch 已解決，恢復路徑未完成 | discover/rescan 不再自動重裝；實際路由恢復失敗，見發現 1 |
| M7 fixture muteOthersCalls 耦合 | 已解決 | authScope 計數 mapped 方法，src 無 muteOthersCalls；移除 fixture 計數欄位仍恰一次 |
| M8 fallback 舊 snapshot／不檢查 paused | 已解決 | timer 執行時重新 buildSnapshot，檢查 ready／editMode／paused 或 firstPlay；相應測試通過 |
| M9 必要回歸缺少 | 大部分補齊，尚未完全解決 | 101 tests 包含 grant 三入口、storage race、A→B→A、BFCache 等；但 route reentry 測試實際只關開設定，preset 測試接受 bootstrap 或 silence 且未驗證 merge，故未能覆蓋計畫保證 |

額外 probe 指令：`python3 .cache/run-with-timeout.py 120 npx --yes yarn@1.22.22 vitest run --config .cache/review2-vitest.config.ts`，exit 1，2 tests：1 passed（preset）、1 failed（route reentry）。probe／config 僅在 .cache，未修改產品或既有測試。

## 給 Fi 的摘要

101 個測試、typecheck、scoped lint 與兩個 build 皆通過，整合檔 lint 與 baseline 一致。第一輪的兩個 high 主要缺陷與大部分 medium 已修正。degraded 現在能保持，但會連路由監聽一起停止，實際離開再返回 multiview 無法恢復保護。部分回歸測試仍放過了這種錯誤，因此目前判定 FAIL；整體新問題審查尚在進行。
