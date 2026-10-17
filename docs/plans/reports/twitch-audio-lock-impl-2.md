# Twitch audio lock 實作報告 2（fix-1）

日期：2026-10-17  
分支：`gixiphy/twitch-audio-lock`  
工作 head：`1f716e2a3e8d5f1c37f2d3cf841fb8fd313a60fa`  
依據：`docs/plans/twitch-audio-lock-fix-1.md`、主計畫 `docs/plans/twitch-audio-lock.md`、驗收 `docs/plans/reviews/twitch-audio-lock-impl-review-1.md`

## 產品 commit

| SHA（短） | 訊息 |
| --- | --- |
| `ba53f89` | fix(audio-lock): make reducer enforce token edge, settle and refresh observations |
| `12d1bdc` | fix(audio-lock): track cell generations and rebind player ports |
| `9c5e0ad` | fix(audio-lock): keep watching layout after discovery and dispatch lifecycle events |
| `c64bb44` | fix(audio-lock): rate-limit guard mutes and latch degraded sessions |
| `3575590` | test(audio-lock): cover settings bridge races |
| `1f716e2` | fix(audio-lock): arm store settle on selection effects |

說明：計畫建議的第 4 則 commit 訊息對應 rate-limit／degraded latch；主體已在 `12d1bdc`／`9c5e0ad` 落地，`c64bb44` 為 lint／收斂補丁，`1f716e2` 補上選擇後 store settle 啟動條件。

## 發現 → commit → 測試對照

| 報告項目 | 主要 commit | 自動測試名稱 |
| --- | --- | --- |
| H1 發現迴圈 120 秒後停止 | `12d1bdc`、`9c5e0ad` | `rescans_cells_added_after_discovery_window`、`session_observers_released_on_teardown`、`toggle_ten_times_no_leak` |
| H2 generation／port 與換片 | `12d1bdc`、`9c5e0ad` | `generation_bumps_on_content_provider_vm_or_player_change`、`same_key_provider_swap_rebinds_port`、`player_rebuild_bumps_generation_and_drops_stale_results`、`new_vm_instance_for_same_key_is_patched` |
| H2 LAYOUT／READY／REMOVED | `ba53f89`、`9c5e0ad`、`1f716e2` | `classifyLayout_*`、`locked_add_unassigned_cell_normalized_on_ready`、`preset_replace_bootstraps_merge_keeps_active_silence_stays`、`remove_active_enters_silence` |
| M 面板外 setMuted(true) | `ba53f89`、`12d1bdc` | `refresh_mute_true_is_observation_only_in_bootstrap`、`refresh_mute_true_is_observation_only`、`refresh_mute_true_respects_grant_and_settle` |
| M 焦點 token 邊緣 | `ba53f89`、`9c5e0ad` | `focus_token_requires_muted_to_unmuted_edge`、`token_edge_selects_once` |
| M settle／冷卻／失敗 | `ba53f89`、`12d1bdc`、`1f716e2` | `mute_settle_and_unsettled_count`、`mute_writes_respect_cooldown_and_settle`、`mute_did_not_settle_degrades_after_three`、`store_did_not_settle_degrades_at_500ms`、`selection_settle_ignores_stale_true` |
| M degraded 不持久 | `12d1bdc`、`9c5e0ad` | `degraded_is_not_reinstalled_by_discovery`、`reenable_or_route_reentry_clears_degraded`、`discovered_keeps_degraded_and_locked` |
| M 補呼叫不依賴 fixture | `12d1bdc`、`9c5e0ad` | `early_return_supplement_exactly_once_without_fixture_counter` |
| M fallback 排除暫停 | `12d1bdc`、`9c5e0ad` | `fallback_skips_paused_and_not_playing`、`fallback_waits_then_rearms_on_play` |
| M 回歸缺漏 | `9c5e0ad`、`1f716e2` | `manual_refresh_cannot_switch_active`、`unassigned_selection_restores_*`、`pending_grant_*`、`last_command_wins_a_b_a`、`bfcache_pageshow_revalidates` |
| L1 ready 等 storage | `3575590` | `ready_waits_for_storage_read`、`ready_before_and_after_storage_read` |
| L2 無測試 hook 在 page handle | `9c5e0ad`／既有 `twitch-audio-lock.ts` | `no_test_hooks_on_page_handle` |
| L3 重複 enable 單一發現迴圈 | `12d1bdc` | `repeated_enable_single_discovery_loop` |

## 指令結果

| 指令 | 結束碼 | 備註 |
| --- | --- | --- |
| `yarn install --frozen-lockfile` | 0 | 已 up-to-date |
| scoped lint（`node .cache/audio-lock-lint/run.cjs`） | 0 | 修正後乾淨 |
| 整合檔 lint（options／contentScript／holodex-inject，unix） | 1（預期） | 仍為 baseline 3 則 `@typescript-eslint/ban-ts-comment`（與 709e963 相同） |
| `yarn typecheck:audio-lock` | 0 | |
| `yarn test:audio-lock` | 0 | **101** tests passed（5 files）；baseline 為 49 |
| `yarn build:chrome` | 0 | |
| `yarn build:firefox` | 0 | |
| `grep muteOthersCalls\|__trusted src/` | 0 | `no fixture coupling`（auth 計數改名 `mappedMuteOthers`，以符合 grep 契約） |
| `git diff --check db6fd32 HEAD` | 0 | |

## 偏離與理由

1. **`authScope.mappedMuteOthers` 取代計畫字面的 `muteOthersCalls`**：計畫步驟 5 用 `muteOthersCalls` 當 scope 欄位名，但驗收 grep 要求 `src/` 不得出現該字串；改名後行為相同。  
2. **產品 commit 切分**：controller 大改集中在 `12d1bdc`，後續 `9c5e0ad`／`c64bb44`／`1f716e2` 補測試與 settle 啟動；未嚴格一比一對到五則建議訊息的檔案邊界，但訊息與意圖對齊。  
3. **選做 L2**：`installAudioLock()` 回傳值本來就只有 `{ setEnabled, dispose }`；pointer 改為 `deps.isTrusted ?? event.isTrusted`（移除 `__trusted`）。  
4. **未再 dispatch 獨立「rate-limit only」大 commit**：邏輯已在 adapter／controller 重寫中完成。

## 尚未完成的人工清單

以下仍須在真實 Holodex multiview（Twitch／YouTube 混排）人工確認，本報告只稱「可交付實測」候選，不宣稱已人工驗收：

- [ ] 發現成功後超過 120 秒再新增格子，仍會被 patch，且無法搶走已選定音訊  
- [ ] 換 content／provider／重建 player／換 VM 後舊非同步結果不寫入  
- [ ] preset／merge／silence 三種 LAYOUT 分支行為與題 2A 一致  
- [ ] 面板 Mute／Mute Others 與 iframe 焦點 token（true→false）手感  
- [ ] degraded 後僅重新啟用、路由重進、BFCache pageshow 可恢復  
- [ ] Chrome／Firefox 正式包權限與 `web_accessible_resources` match 範圍目視確認（build 已通過；page bundle 無 `webextension-polyfill`）

## 硬性規則遵守

未 push、未開 PR、未 merge、未公證、未 sudo；未建立或切換分支；未改 `.ref/`、`docs/plans/reviews/`、`docs/plans/prompts/`。
