# Twitch audio lock 實作報告 3（fix-2）

日期：2026-10-17。執行者：Cursor。分支 `gixiphy/twitch-audio-lock`。  
依據：`docs/plans/twitch-audio-lock-fix-2.md`（基準 head `c2625b4`）。  
基線：`test:audio-lock` 5 files / **101** tests PASS。完成後：**117** tests PASS（+16）。

本輪僅依修正計畫實作五個問題；真瀏覽器人工清單仍未執行，只能稱為「可交付實測」候選。

## 五個問題對照

| 問題 | 根因 | Commit SHA | 回歸測試 |
| --- | --- | --- | --- |
| 1 READY 依賴不存在的 `player.ready` | PlayerMixin 沒有 `ready` 布林；READY 來自 `$emit("ready")`，SDK 參考在父 VideoCell 的 `twPlayer`／`ytPlayer` | `899eab97e2a21125d32e80b5e547972ed4d6eecb` | `fixture_matches_upstream_player_shape`、`binds_on_vue_ready_event_without_ready_field`、`late_bind_twitch_requires_cell_twPlayer_identity`、`late_bind_youtube_rejects_stale_cell_ytPlayer`、`ready_event_binds_even_before_cell_onReady`、`upstream_shape_ready_event_binds_and_guards`、`upstream_shape_late_bind_guards` |
| 5 已 ready、SDK 缺 method 不降級 | `tryBind` 把 bind 失敗與 not-ready 混成同一回傳 | `57d432157abbf0feff02ab52e794256a3ab1ca58` | `ready_instance_missing_methods_reports_mismatch`、`ready_sdk_missing_methods_degrades` |
| 2 重送 `enabled=true` 卡 discovering | `setEnabled`／`ENABLE` 不檢查同值，每次把 mode 打回 discovering | `529bacbfae8dd6008f19cb7ffc82ddbf0b5eae7a` | `enable_is_idempotent_when_already_enabled`、`duplicate_enable_keeps_guard_active`、`duplicate_enable_keeps_degraded_latch` |
| 3 degraded 卸載連路由監聽一起取消 | `pathnameTimer` 掛在 `Session`，`teardownSession` 取消後 `pathnameWatching` 仍 true | `84aeef91a6fdcdc791969c242d5db010188bd592` | `degraded_route_reentry_recovers`、`route_watch_released_on_disable_and_dispose`、`route_watch_released_on_dispose`、`non_multiview_start_waits_for_route`、`reenable_clears_degraded` |
| 4 Mute Others 關閉被當成 root 沒找到 | `tryDiscover` 找到 store 後若 `!muteOthers` 就 teardown 並讓 discovery timer 繼續跑到 root-timeout | `2662f30abe12ba28b779e5aacebbcf62ad608e6f` | `initial_mute_others_off_has_no_discovery_timeout` |

產品 commit 共 5 個（英文訊息、不含 docs）。本報告另以 docs commit 提交。

## 回歸測試：拿掉修正時的失敗摘要（Step 2 實測）

| 測試 | 失敗摘要 |
| --- | --- |
| `binds_on_vue_ready_event_without_ready_field` | `expected { kind: 'unavailable', reason: 'not-ready' } to deeply equal { kind: 'known', muted: false }`（仍讀不存在的 `player.ready`） |
| `late_bind_twitch_requires_cell_twPlayer_identity` | `expected false to be true`（`isBound()`） |
| `late_bind_youtube_rejects_stale_cell_ytPlayer` | fireReady 後仍 `not-ready`／無法 bound |
| `ready_event_binds_even_before_cell_onReady` | `expected false to be true`（`isBound()`） |
| `ready_instance_missing_methods_reports_mismatch` | `expected +0 to be 1`（`onContractMismatch` 未被呼叫） |
| `ready_sdk_missing_methods_degrades` | `expected 'locked' to be 'degraded'` |
| `enable_is_idempotent_when_already_enabled` | `mode: 'discovering'` ≠ 輸入的 `locked` |
| `duplicate_enable_keeps_guard_active` | `rawMuted` 仍為 false（保護失效） |
| `duplicate_enable_keeps_degraded_latch` | 同值 `setEnabled(true)` 後 `mode` 變成 `locked`（latch 被清掉） |
| `degraded_route_reentry_recovers` | 進出 `/multiview` 後仍 `degraded` |
| `route_watch_released_on_disable_and_dispose` | degraded 後 timer 數為 0（路由 timer 已死） |
| `non_multiview_start_waits_for_route` | 121s 後 `console.warn` 出現 `root-timeout` |
| `initial_mute_others_off_has_no_discovery_timeout` | 122s 後 `mode === 'degraded'` |

## 驗證指令結果

環境：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；一律 `python3 .cache/run-with-timeout.py <秒>`。

| 指令 | 逾時 (s) | 結束碼 | 數字／備註 |
| --- | ---: | ---: | --- |
| `yarn install --frozen-lockfile …` | 300 | 0 | Already up-to-date |
| `yarn test:audio-lock` | 120 | 0 | **5 files / 117 tests** PASS（基線 101） |
| `yarn typecheck:audio-lock` | 120 | 0 | `tsc` + tests project 通過 |
| `node .cache/audio-lock-lint/run.cjs`（scoped） | 120 | 0 | 0 error、0 warning（僅 React version 設定提示） |
| 整合檔 lint（options／contentScript／holodex-inject） | 120 | 1 | 與基線相同：3 則 `@typescript-eslint/ban-ts-comment`（`holodex-inject.ts`），無新增 |
| `yarn build:chrome` | 180 | 0 | ✓ built |
| `yarn build:firefox` | 180 | 0 | ✓ built |
| `grep muteOthersCalls\|\|__trusted src/` | — | 0 | `no fixture coupling` |
| `git diff --check c2625b4 HEAD -- src tests` | — | 0 | 乾淨 |
| `git diff --stat c2625b4 HEAD --`（禁改清單） | — | 0 | **輸出為空** |
| 任務 2 shape grep | — | 0 | **輸出為空**（僅允許 `cell.twPlayer`／`cell.ytPlayer` 賦值） |

## Fixture 形狀對照（`.ref/holodex` @ 8c6d0da）

| Fixture 欄位／行為 | 上游出處 |
| --- | --- |
| Player component **無** `ready`／`twPlayer`／`ytPlayer` | PlayerMixin.ts:27-35 |
| `$on("ready")`／`fireReady` emit | PlayerMixin.ts:46 |
| Twitch `player` 初值 `{}`（`sdkLoaded: false`），否則 SDK | TwitchPlayer.vue:40-43, :86 |
| Twitch READY 參數 = `comp.player` | TwitchPlayer.vue:92-95 |
| YouTube wrapper SDK；READY 參數 = raw（`youtubeRawFor` / `getIframe`） | YoutubePlayer.vue:53-67, :69 |
| `$el` 內含 embed iframe | TwitchPlayer.vue:1-3、YoutubePlayer.vue:1-3 |
| Cell `twPlayer`／`ytPlayer`／`onReady` | VideoCell.vue:79-80, :210-216 |
| 建立時 `$on("ready", cell.onReady)`（模擬 `@ready`） | VideoCell.vue:18, :39 |
| 同 provider YouTube 換片留舊 `ytPlayer`、新 component 不 fire READY | VideoCell.vue:30, :134-139 |
| 換 provider 時清空另一邊參考 | VideoCell.vue:138-139 |

## 偏離與理由

1. **`discovered_keeps_degraded_and_locked`（state.test）**：最後一段「ENABLE 清除 degraded」改成先 `DISABLE` 再 `ENABLE`，預期 `discovering`。符合規格：degraded 只在停用後重新啟用時解除；同值 ENABLE 必須冪等。
2. **`reenable_or_route_reentry_clears_degraded`**：拆成 `reenable_clears_degraded` 與 `degraded_route_reentry_recovers`（真的走 `pushState`），避免只靠切設定冒充路由恢復。
3. **`missing public methods returns null port`**：刪除，由 `ready_instance_missing_methods_reports_mismatch` 取代（計畫任務 3）。
4. **Ruling（執行中）**：任務 6 commit 後為讓任務 2 grep 為空，將 `cellB.twPlayer` 更名為 `cell.twPlayer` 並 amend 進最後一個產品 commit（未 push；避免出現第 6 個產品 commit）。代價若錯：僅變數名稱 diff。
5. **未執行**：真瀏覽器人工驗收清單。

## 產品 commit 一覽

```
899eab9 fix(audio-lock): detect player readiness from upstream ready event and cell refs
57d4321 fix(audio-lock): degrade when a ready player lacks required methods
529bacb fix(audio-lock): make repeated enable a no-op for live sessions
84aeef9 fix(audio-lock): keep route watch alive across degraded teardown
2662f30 fix(audio-lock): keep watching the store while Mute Others is off
```
