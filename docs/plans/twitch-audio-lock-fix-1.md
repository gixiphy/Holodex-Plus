# Twitch audio lock 修正計畫 fix-1

> 執行者：Cursor。依據：主計畫 `docs/plans/twitch-audio-lock.md`（含文末「決定紀錄」，題 1–8 全部採 A），以及驗收報告 `docs/plans/reviews/twitch-audio-lock-impl-review-1.md`（受驗 head `26ff3a5df61f8262ef21adfa082f82b94d8c874b`，VERDICT: FAIL）。這份計畫只修正報告列出的 2 個 high、7 個 medium，3 個 low 列為選做。主計畫的設計規格繼續有效；這裡只寫「怎麼改才符合主計畫」，不重新定義產品行為。

日期：2026-10-17。工作分支 `gixiphy/twitch-audio-lock`，基準 head `db6fd32`（驗收報告 commit）。

## 範圍與硬性規則

- 修正只在第一個 PR 的白名單內進行：`src/pages/content/holodex/audio-lock/` 下的五個模組、`twitch-audio-lock.ts`、`audio-lock-settings.ts`、`tests/audio-lock/` 的五個測試檔與 `fixtures.ts`。不新增產品模組、測試檔、依賴、權限，也不改 `package.json`／`yarn.lock`、manifest、tsconfig、Vite config、options UI 或 `holodex-inject.ts`。
- 不改主計畫和既有報告。實作中如果發現必須偏離這份計畫，記錄到新的實作報告 `docs/plans/reports/twitch-audio-lock-impl-2.md`，不要回頭改計畫。
- 禁止 push、開 PR、merge、公證、sudo，也禁止刪除 worktree 以外的任何東西；不建立或切換分支。所有寫入都限在本 worktree；commit 需要寫入主 repo 的 Git metadata 屬於允許範圍。
- 產品 commit 訊息只用英文（Fi 確認的例外），每個 commit 只 stage 白名單檔案，不要用 `git add -A`。實作報告另外用 docs commit 提交。
- 快取放在 worktree：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。指令一律用 `npx --yes yarn@1.22.22`。

## 發現與修正對照

| 報告項目 | 修正步驟 | 對應測試（測試名稱） |
| --- | --- | --- |
| H1 發現迴圈 120 秒後停止 | 步驟 2、4 | `rescans_cells_added_after_discovery_window`、`session_observers_released_on_teardown` |
| H2 generation／port 與換片 | 步驟 2、3、4 | `same_key_provider_swap_rebinds_port`、`player_rebuild_bumps_generation_and_drops_stale_results`、`new_vm_instance_for_same_key_is_patched` |
| H2 LAYOUT_CHANGED／PLAYER_READY／CELL_REMOVED 沒有送出 | 步驟 1、4 | `locked_add_unassigned_cell_normalized_on_ready`、`preset_replace_bootstraps_merge_keeps_active_silence_stays`、`remove_active_enters_silence`、`classifyLayout_*` |
| M 面板外 setMuted(true) 被當成命令 | 步驟 1、5 | `refresh_mute_true_is_observation_only_in_bootstrap`、`refresh_mute_true_respects_grant_and_settle` |
| M 焦點 token 不檢查邊緣 | 步驟 1、5 | `focus_token_requires_muted_to_unmuted_edge`、`token_edge_selects_once` |
| M settle／收斂／失敗降級 | 步驟 1、5 | `mute_writes_respect_cooldown_and_settle`、`mute_did_not_settle_degrades_after_three`、`store_did_not_settle_degrades_at_500ms`、`selection_settle_ignores_stale_true` |
| M degraded 不持久 | 步驟 1、4 | `degraded_is_not_reinstalled_by_discovery`、`reenable_or_route_reentry_clears_degraded` |
| M 補呼叫依賴 fixture 欄位 | 步驟 5 | `early_return_supplement_exactly_once_without_fixture_counter` |
| M fallback 未排除暫停 | 步驟 1、5 | `fallback_skips_paused_and_not_playing`、`fallback_waits_then_rearms_on_play` |
| M 回歸測試缺漏 | 步驟 6、7 | 見「測試」章節的完整清單 |
| L1–L3（選做） | 步驟 8 | `ready_waits_for_storage_read`、`no_test_hooks_on_page_handle`、`repeated_enable_single_discovery_loop` |

## 檔案

| 檔案 | 修改內容 |
| --- | --- |
| `src/pages/content/holodex/audio-lock/contracts.ts` | `CellRuntime` 新增 `lastObservedMuted: boolean \| null`、`unsettledMuteCount: number`。`LockEvent` 修改：`OBSERVED_MUTED` 新增 `assignment: MutedAssignment`、`origin: "poll" \| "refresh"`，移除 `hasValidToken`（token 判斷移進 reducer）；`PLAYER_READY` 新增 `assignment`；新增 `{ type: "MUTE_SENT"; now; identity }`、`{ type: "RESET_DEGRADED"; now }`。`TIMING` 新增 `HEARTBEAT_MS: 2000`、`PATHNAME_CHECK_MS: 2000`、`BOOTSTRAP_WAIT_MS: 120_000`。新增型別 `LayoutClassification`（見步驟 1）。 |
| `src/pages/content/holodex/audio-lock/state.ts` | 修改 `withActive`（加 `now`、設定 selection settle）、`OBSERVED_MUTED`、`PLAYER_READY`、`DISCOVERED`、`ENABLE`、`CONTRACT_FAILED`／`STORE_DID_NOT_SETTLE`；新增 `MUTE_SENT`、`RESET_DEGRADED`；新增純函式 `classifyLayout`、`storeConverged`。`pollObservation` 改成只呼叫 `transition`，避免重複決策。 |
| `src/pages/content/holodex/audio-lock/holodex-adapter.ts` | 加入 identity registry 與 generation bump；`watchSnapshot(store, onSnapshot, onMutation)` 不再自己呼叫 `discover()`；新增 `observe(target, onChange): () => void`（MutationObserver）；`setStoreMuted` 用 discover 時快取的 store；刪除未使用的 `bumpGeneration` export。 |
| `src/pages/content/holodex/audio-lock/players.ts` | `PlayerBinding` 新增 `onReady?: () => void`，第一次 bind 成功時呼叫一次；`PlayerPort` 實作物件額外提供 `isBound(): boolean`（只在模組內型別 `BoundPlayerPort` 宣告，不改 `contracts.ts` 的 `PlayerPort` 公開介面）。 |
| `src/pages/content/holodex/audio-lock/controller.ts` | 主要修改：session 監聽（observer、store、heartbeat、pathname）、`syncBindings` 差異處理、事件派送、wrapper 改用目前的 identity、授權 scope 計數、settle／store 收斂計時器、fallback 資格、degraded latch、teardown。 |
| `src/pages/content/holodex/audio-lock-settings.ts` | 只在選做 L1 時修改。 |
| `tests/audio-lock/fixtures.ts` | multiview `$el` 放進 `#app`，cell `$el` 放進 multiview `$el`；新增 `addFakeCell`、`removeFakeCell`、`replaceCellContent`、`replacePlayer`、`applyPreset`；store commit 支援 `multiview/setLayout`、`multiview/setLayoutContent`、`multiview/removeLayoutItem`、`multiview/setLayoutContentById`；Twitch／YouTube SDK 新增 `settleDelayMs`、`ignoreMute` 選項；新增 `countSessionResources(store)` 輔助。 |
| `tests/audio-lock/state.test.ts`、`adapter.test.ts`、`players.test.ts`、`controller.test.ts`、`settings.test.ts` | 新增「測試」章節列出的案例，不新增測試檔。 |

## 步驟

每個步驟都先寫測試，跑過確認 FAIL，再實作到 PASS（TDD）。單檔測試指令：`npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/<file>.test.ts`，外層一律套 120 秒逾時 wrapper（見「測試」章節）。

### 步驟 0：準備

- [ ] 確認分支仍是 `gixiphy/twitch-audio-lock`、工作樹乾淨。不要建立或切換分支。
- [ ] 在 `.cache/run-with-timeout.py` 準備逾時 wrapper（已存在就沿用；該檔不提交）。規格：`subprocess.Popen(cmd, start_new_session=True)`，`wait(timeout=秒數)`，逾時時 `os.killpg(pid, SIGKILL)` 並 `exit 124`。
- [ ] 跑一次現有 49 個測試作為 baseline（預期全 PASS）。

### 步驟 1：純狀態機（`contracts.ts`、`state.ts`）

1. **`withActive(state, identity, source, now)`**：沿用現有 epoch++、清 intent、建立 grant；另外把 `cells[identity.key]` 設成 `{ ...ensureRuntime, settleUntil: now + TIMING.SETTLE_MS, lastObservedMuted: null }`。所有呼叫端（`NATIVE_FIRST_PLAY`、`BOOTSTRAP_READY`、`EXPLICIT_SET_MUTED`、token 選擇）都要傳 `event.now`。刪除沒用到的 `selection` 參數和重複的 selection 設定。
2. **`OBSERVED_MUTED`**（同時處理 poll 和 refresh 兩種 origin），依序判斷：
   - 讀取 `prev = cells[key]?.lastObservedMuted ?? null`，之後一律把它更新成 `event.muted`（`unsettledMuteCount` 在 `event.muted === true` 時歸零）。
   - `muted === true`：只有在 `selection === "selected"`、identity 是 active、沒有未消耗的同 identity grant、`settleUntil <= now` 時，才轉成 `toSilence` 並產生 `CALL_ORIGINAL_SET_MUTED(true)`；其他情況不產生 effect。bootstrap 讀到 true 一律不改 store、不進 silence。
   - `muted === false` 且 `tokenValid(state, identity, now) && prev === true && settleUntil <= now`：消耗 token，執行 `withActive(..., "explicit", now)`，產生 `CALL_ORIGINAL_SET_MUTED(false)`。`prev` 是 `false` 或 `null` 時 token 不授權，token 保留到過期（不消耗）。
   - 其他 `muted === false`：`want = desiredMute(state, event.assignment, identity)`。只有 `want === "muted"` 才往下判斷：`settleUntil > now` → 不產生 effect；`unsettledMuteCount >= TIMING.MAX_CONSECUTIVE_FAILURES` → 轉成 degraded，產生 `REPORT_ONCE("player-mute-did-not-settle")`；否則產生 `MUTE_PLAYER`。
3. **`MUTE_SENT { identity, now }`**（由 executor 在 `port.mute()` 送出後 dispatch）：`lastMuteAt = now`、`settleUntil = now + SETTLE_MS`、`ownMuteGeneration = identity.generation`、`unsettledMuteCount += 1`。reducer 外不能直接改 `state.cells`。
4. **`PLAYER_READY { identity, assignment }`**：`selected` 而且是非 active 格，或 `silence` 的任一格，只在 `assignment !== true` 時產生 `SET_STORE_MUTED(true)`；**不直接產生 `MUTE_PLAYER`**，壓回聲音交給 controller 隨後的 fresh read（主計畫要求「已知 false 才 mute」）。新 generation 一律建立新的 runtime（`emptyCellRuntime()`）。
5. **`DISCOVERED`**：`state.mode === "degraded"` 時原樣返回。如果原本是 `locked`，保持 `locked`，不能改成 `waiting-for-choice`（只更新 `muteOthers`）。
6. **`RESET_DEGRADED`**：`mode: degraded` → `discovering`，`selection: "bootstrap"`，`active: null`，epoch++；`reportedCodes` 保留（同一個 document 的同一個 code 最多 warn 一次）。`ENABLE` 從 degraded 進來時也要做同樣的重置。
7. **`classifyLayout(prev: StoreSnapshot | null, next: StoreSnapshot, mutationTypes: ReadonlySet<string>, active: CellIdentity | null): LayoutClassification`**，回傳 `{ kind: "none" | "reorder" | "add" | "remove-active" | "replace-active" | "preset" | "merge-preset", added: CellIdentity[], removed: CellIdentity[], preservedActive: CellIdentity | null }`。比較基準是 `identityCore`（key、provider、contentId），generation 不同但 core 相同時，視為同一格重建：
   - `mutationTypes` 含 `multiview/setLayout` 或 `multiview/setLayoutContent` 就是 preset 批次：next 裡如果有 core 跟 active 相同的格子，結果是 `merge-preset`，`preservedActive` 設成 next 中那一格（帶新 generation）；否則是 `preset`。
   - 不是 preset 時：active 的 key 消失 → `remove-active`；active 的 key 還在但 core 改變 → `replace-active`；只有新增 key → `add`；key 集合與 core 都相同、只差順序 → `reorder`；完全一樣 → `none`。非 active 格被移除或換內容時，放進 `removed`（以及 `added`），kind 依其他規則決定。
   - `LAYOUT_CHANGED` reducer 沿用現有分支，但 `merge-preset` 要清 grant、epoch++，並把 `active` 換成帶新 generation 的 `preservedActive`。
8. **`storeConverged(snapshot, active, pendingKeys: ReadonlySet<string>): boolean`**：active 格的 assignment 是 `false`，而且其他 video 格都是 `true`；屬於 `pendingKeys`（port 尚未 bind）的格子允許是 U。
9. **`pollObservation`**：改成只是把參數組成 `OBSERVED_MUTED`（`origin: "poll"`）再呼叫 `transition`，回傳值格式不變，讓既有測試能繼續使用。

### 步驟 2：adapter（`holodex-adapter.ts`）

1. **identity registry**：把 `generationByKey` 換成 `registry: Map<string, { contentId; provider; cell: object; player: object | null; generation: number }>`，提供內部函式 `identityFor(key, cell, content, player)`。規則：
   - 第一次看到這個 key：用 `generationCounter++` 當 generation。
   - `contentId`、`provider`、cell VM instance 任一項改變，或 player 從物件 A 換成物件 B（`null → 物件` 不算）：generation 改成新的 `generationCounter++`。
   - 其他情況沿用原本的 generation。
   provider 只用一套規則決定：`cell.isTwitchVideo === true` 就是 twitch，否則用 `providerFromContent`。snapshot 由 store 建立時，如果該 key 的 registry 項目 contentId 相同，就沿用它的 provider 和 generation，避免 snapshot 和 binding 的 identity 不一致。
2. **discover 回傳值**：成功時另外回傳 `observeTarget: Element`，取持有 `$refs.videoCell` 的 multiview VM 的 `$el`，沒有就用 root 的 `$el`；並把 `store` 快取到 adapter closure 裡。
3. **`watchSnapshot(store, onSnapshot, onMutation: (type: string) => void)`**：移除裡面的 `discover()`。store watch 的 getter 簽章（primitive 字串）要包含 provider 和 generation。`subscribe` 只呼叫 `onMutation(mutation.type)`，**不要**在 subscribe 裡同步建 snapshot（store 的 debounce 還沒執行）。另外匯出 `buildSnapshot(): StoreSnapshot` 給 controller 在合併後的 macrotask 呼叫。
4. **`observe(target, onChange)`**：建立 `new win.MutationObserver(() => onChange())`，呼叫 `observe(target, { childList: true, subtree: true })`；回傳的 disposer 執行 `disconnect()`，可重複呼叫。`MutationObserver` 不存在時回傳 no-op disposer，靠 heartbeat 補上。
5. **`setStoreMuted`**：改用快取的 store，不重新 discover；commit 包在 try/catch 裡，例外時呼叫 `report("store-shape-changed")`。
6. **`dispose`**：清掉 registry 和 store 快取。刪除沒有作用的 `originals` 迴圈和 `bumpGeneration` export。

### 步驟 3：PlayerPort（`players.ts`）

1. `PlayerBinding.onReady?: () => void`。`tryBind()` 第一次從「未 bind」變成「已 bind」時，用 `queueMicrotask` 呼叫 `onReady` 一次，並包在 try/catch 裡；同一個 port 之後不再呼叫。`$on("ready")` 路徑和 `readMuted()` 裡的 late-bind 路徑都會經過 `tryBind`。
2. 回傳的 port 物件加上 `isBound(): boolean`（`methods !== null && !disposed`）。controller 用模組內型別 `BoundPlayerPort = PlayerPort & { isBound(): boolean }` 存取它；`contracts.ts` 的 `PlayerPort` 不改。
3. `portsByCell` 的 key 維持 player component；controller 在 generation 改變時會先 `dispose()` 舊 port，所以新 component 一定會建立新 port。

### 步驟 4：controller 生命週期（`controller.ts`）

1. **session 資源集中管理**：新增 `session: { stopObserver; stopStore; heartbeatTimer; pathnameTimer; rafHandle; coalesceTimer; settleTimers: Map<string, timer>; storeSettleTimer; fallbackTimer } | null`。`teardownSession()` 依序：停止 observer、取消 rAF／所有 timer、unwatch／unsubscribe store、所有 wrapper `unpatch`、所有 port `dispose`、清空 `lastBindings`／`inFlightReads`／`pausedByKey`，最後設成 `null`。函式要冪等，可以重複呼叫。
2. **發現迴圈**（`startDiscoveryLoop`）：
   - 開始前先取消既有的 `discoveryTimer`，同一時間只會有一個迴圈。
   - 在找到 root 之前，維持 250ms（前 15 秒）／2000ms 的間隔，總時間上限 120 秒，逾時就 `report("root-timeout")`。
   - **第一次成功後立刻停止迴圈**，改由 session 監聽負責：
     - `adapter.observe(observeTarget, scheduleRescan)`；
     - `adapter.watchSnapshot(store, onSnapshot, onMutation)`；
     - heartbeat：`schedule(heartbeat, TIMING.HEARTBEAT_MS)` 的 timer 鏈，每次呼叫 `rescan()`。
     這些監聽只要 session 還在就持續運作，**沒有 120 秒上限**。
3. **`scheduleRescan()`**：用 `deps.requestAnimationFrame`（預設 `win.requestAnimationFrame`，不存在時用 `schedule(fn, 16)`）合併成一次 `rescan()`。`onMutation(type)` 把 type 加入 `pendingMutationTypes`，再用 `schedule(processLayout, 0)` 合併（同一個 macrotask 只排一次）。
4. **`rescan()`**：`state.mode === "degraded"` 或 session 不存在就直接返回。呼叫 `adapter.discover()`：
   - 失敗而且 code 不是 `root-timeout` → 走 `failSession(code)`（見第 10 點）。
   - 找到的 store 或 observeTarget 跟 session 的不同（root 被換掉）→ `teardownSession()` 後重新 `startDiscoveryLoop()`。
   - 其他情況 → `syncBindings(found.bindings)`。
5. **`syncBindings(next)`**，以 key 做差異比對：
   - 新的 key：`installBinding(b)`。
   - key 還在、identity 相同：只更新 `lastBindings`；如果 port 還沒建立，就呼叫 `ensurePort`。
   - key 還在但 identity 不同（generation 改變）：舊 port `dispose()`、`ports.delete`、`inFlightReads.delete`、`settleTimers` 取消；cell VM instance 不同時，先 `unpatch` 舊 VM 再 patch 新 VM；最後 `installBinding(b)`，並 dispatch `CELL_REMOVED(oldIdentity)`，留給 `processLayout` 分類。
   - key 消失：`unpatch`、port `dispose`、dispatch `CELL_REMOVED(oldIdentity)`。
   `unpatches` 改成 `Map<key, { cell: object; unpatch: () => void }>`，`ports` 改成 `Map<key, { identity: CellIdentity; port: BoundPlayerPort }>`；`ensurePort` 用 `sameIdentity` 比較，identity 不同就重建 port。
6. **wrapper 讀取目前的 identity**：`installBinding` 的 handler 不再閉包 `identity`，改成閉包 `key`；每次呼叫時用 `const identity = lastBindings.get(key)?.identity`，找不到就直接委派原方法。
7. **`processLayout()`**（合併後的 macrotask）：
   - `snapshot = adapter.buildSnapshot()`。
   - `cls = classifyLayout(prevSnapshot, snapshot, pendingMutationTypes, state.active)`，然後清空 `pendingMutationTypes`。
   - `cls.kind !== "none"` 時 dispatch `LAYOUT_CHANGED`；`cls.removed` 裡非 active 的每一格 dispatch `CELL_REMOVED`。
   - 接著 dispatch `STORE_SNAPSHOT`，執行 `checkStoreSettle(snapshot)`（步驟 5 第 4 點），最後 `prevSnapshot = snapshot`。
   - `onSnapshot`（store watch 觸發）也走同一個合併入口，不要另外同步處理。
8. **PLAYER_READY**：`ensurePort` 傳入 `onReady`。觸發時先確認 `lastBindings.get(key)?.identity` 仍然 `sameIdentity` 才 dispatch `PLAYER_READY { identity, assignment: currentAssignment(key) }`，執行 effects 後排 `reconcileCell(identity)`；bootstrap 階段另外呼叫 `armBootstrapFallback()`；若有同 identity 的 pending grant，呼叫 `maybeRestoreGrant(identity)`。
9. **pathname 監聽**：session 建立後才啟動 `PATHNAME_CHECK_MS` 的 timer 鏈。離開 `/multiview` → `teardownSession()`，並記錄 `leftMultiview = true`；之後重新進入 → 如果目前是 degraded 就 dispatch `RESET_DEGRADED`，再 `startDiscoveryLoop()`。這個 timer 跟入口 bootstrap 的 listener 一樣，只有最後的 `dispose()` 才會移除；`setEnabled(false)` 時也要停掉。不修改 history API。
10. **degraded latch**：新增 `failSession(code)`，依序 dispatch `CONTRACT_FAILED(code)` → 執行 REPORT_ONCE → `teardownSession()` → 取消 `discoveryTimer`。adapter 的 `report` callback、3 次讀取失敗（`player-unavailable`）、`player-mute-did-not-settle`、`STORE_DID_NOT_SETTLE` 都改走這個函式。`tryDiscover`／`rescan` 在 `state.mode === "degraded"` 時直接返回。只有以下路徑會解除 degraded：`setEnabled(false)` 後再 `setEnabled(true)`（`ENABLE`）、步驟 9 的路由重新進入（`RESET_DEGRADED`）、`pageshow` 且 `event.persisted === true`（`RESET_DEGRADED` 後重新發現）。

### 步驟 5：controller 的攔截與計時（`controller.ts`）

1. **面板外的 `setMuted`**：wrapper 在 `authDepth === 0`、protection 生效、而且 `!hasPanelDispatch()` 時，**不呼叫原方法**，`true` 和 `false` 都 dispatch `OBSERVED_MUTED { muted: value, assignment: currentAssignment(key), origin: "refresh" }`，effect 一律交給 reducer 決定（步驟 1 第 2 點）。刪除現有「`value === true` 時 dispatch `EXPLICIT_SET_MUTED`」的分支，也刪除 wrapper 裡自己判斷 token 的程式碼。面板路徑（`hasPanelDispatch()`）維持 `EXPLICIT_SET_MUTED`。
2. **reconcile 的 token**：`reconcileCell` 不再自己計算 `hasToken`，改成 dispatch `OBSERVED_MUTED { origin: "poll", assignment }`。
3. **MUTE_PLAYER executor**：
   - 先檢查：`effect.epoch === state.epoch`、`!runtime.muteInFlight`、`now >= runtime.lastMuteAt + MUTE_COOLDOWN_MS`、`now >= runtime.settleUntil`，任一不符就跳過。
   - 把 `muteInFlight` 設成 true，`await port.mute()`；送出後 dispatch `MUTE_SENT`，最後在 finally 把 `muteInFlight` 清掉。
   - `mute()` 回傳 false 時當作一次讀取失敗，計入 `consecutiveFailures`。
4. **500ms store 收斂**：
   - 啟動條件：`EXPLICIT_SET_MUTED(false)`、token 選擇、`NATIVE_FIRST_PLAY`、`BOOTSTRAP_READY` 讓 active 改變之後，以 `storeSettleTimer = schedule(onStoreSettleTimeout, TIMING.STORE_SETTLE_MS)` 啟動，同時記下 `storeSettleTarget = active`。
   - 檢查：`checkStoreSettle(snapshot)` 在 `storeConverged(snapshot, storeSettleTarget, pendingKeys)` 為 true 時取消 timer。
   - 逾時：如果 active 還是 `storeSettleTarget` 而且 epoch 沒變，dispatch `STORE_DID_NOT_SETTLE` 並 `failSession`。
   - 取消：新的選擇會先取消舊 timer；selection 改成 silence 或停用也會取消。
5. **1500ms selection settle**：
   - 啟動條件：同一組選擇路徑在 active 改變時，以 `settleTimers.set(key, schedule(onSettleExpired, SETTLE_MS))` 啟動。
   - 到期：做一次 fresh read，結果如果是 known，就 dispatch `SETTLE_EXPIRED { stillMuted: read.muted }`（identity 或 epoch 不符就丟棄）。
   - 這段期間，active 讀到 `true` 由 reducer 的 `settleUntil` 擋下（步驟 1 第 2 點）。
6. **`setMuted` 提前返回的補呼叫**：新增 `authScope = { muteOthersCalls: 0 }`。wrapper `muteOthers` 在 `authDepth > 0` 時先 `authScope.muteOthersCalls += 1`，再呼叫原方法。`CALL_ORIGINAL_SET_MUTED` 的 executor 在呼叫原 `setMuted` 前記下 `before = authScope.muteOthersCalls`；呼叫後如果 `effect.muted === false`、計數沒有增加、而且 active 仍是這格，就補呼叫 `cell.muteOthers(cell.item.i)` 一次（同樣會計數）。刪除所有讀取 `muteOthersCalls` 欄位的程式碼；完成後 `grep -rn muteOthersCalls src/` 必須沒有結果。
7. **1000ms fallback 資格**：
   - 播放狀態：wrapper `updatePausedState(paused)` 記錄 `pausedByKey.set(key, paused)`；`paused === false` 而且 bootstrap 還沒選格時，呼叫 `armBootstrapFallback()`。
   - 候選條件（執行當下判斷）：assignment 不是 `true`、`cell.editMode === false`、port `isBound()`，以及 `pausedByKey.get(key) === false`，或沒有紀錄但 `cell.firstPlay === false`（hook 晚到、已經播放過；限制寫在實作報告）。用 `adapter.buildSnapshot()` 取得**當下的** snapshot，不要閉包舊 snapshot。
   - `armBootstrapFallback()`：還沒有 timer 時，排 `TIMING.BOOTSTRAP_FALLBACK_MS` 後執行。沒有候選就不選格，等下一次 `updatePausedState(false)` 或 `PLAYER_READY` 再排；從 bootstrap 開始最多等 `BOOTSTRAP_WAIT_MS`，之後不再排。`NATIVE_FIRST_PLAY` 成立、selection 離開 bootstrap、teardown 時都要取消 timer。

### 步驟 6：fixtures（`tests/audio-lock/fixtures.ts`）

- `createFakeMultiviewRoot`：multiview 的 `$el` 加上 `.multiview` class 並 append 到 `#app`；`createFakeVideoCell` 可以接收 `parentEl`，把 cell `$el` append 進 multiview `$el`，讓 MutationObserver 能看到新增或移除。
- `addFakeCell(env, { key, provider, muted?: boolean | "omit", ready?: boolean })`：寫入 layout／layoutContent，建立 cell 和 player，push 到 multiview `$children` 和 `$refs.videoCell`，append DOM，最後 `store.commit("multiview/setLayoutContentById")`。
- `removeFakeCell(env, key)`：從 layout、layoutContent、`$children` 移除，移除 DOM，commit `multiview/removeLayoutItem`。
- `replaceCellContent(env, key, { provider, contentId })`：同一個 VM 換 content、`isTwitchVideo` 和 player component，commit `multiview/setLayoutContentById`。
- `replacePlayer(env, key)`：同樣的 content，換一個新的 player component 和 SDK。
- `applyPreset(env, cells, { merge })`：依序 commit `multiview/setLayoutContent`、`multiview/setLayout`。
- SDK 選項：`settleDelayMs`（`setMuted` 生效後，`rawMuted` 延遲才更新，用 fake timer 推進）、`ignoreMute`（mute 呼叫只計數，不改 `rawMuted`）。
- `countSessionResources(store)`：回傳 `{ watchers: store._watchers.length, subscribers: store._subscribers.length, timers: vi.getTimerCount() }`。MutationObserver 數量用 `vi.spyOn(window.MutationObserver.prototype, "disconnect")` 和建構次數比對。
- 不要讓 fixture 的 `muteOthersCalls` 欄位影響產品判斷；測試要計算 mapped method 被呼叫幾次時，在 patch 之前包住原函式計數（見 `early_return_supplement_exactly_once_without_fixture_counter`）。

### 步驟 7：測試補齊

依「測試」章節逐項寫入既有的五個測試檔。每個案例在 `afterEach` 都要 `handle.dispose()`、`vi.useRealTimers()`、清 DOM。只用 `vi.advanceTimersByTimeAsync(明確毫秒數)` 推進時間，**禁止** `runAllTimers()`／`runOnlyPendingTimers()` 迴圈。

### 步驟 8：選做（low）

- L1：bridge 收到 `ready` 時，若初始 storage read 還沒完成，就不立即 `postConfig(latestEnabled)`，改在讀取完成（或逾時、或 onChanged）後送出一次。測試 `ready_waits_for_storage_read`。
- L2：把 `__reconcile` 等測試 hook 改成只掛在 `createAudioLockController` 回傳的物件上；`installAudioLock()` 存到 window 的 handle 只保留 `{ setEnabled, dispose }`。刪除 `onPointerDown` 的 `__trusted` 分支，只看 `event.isTrusted`；測試改用 jsdom 的 `Object.defineProperty(event, "isTrusted", ...)`，如果做不到，就透過 deps 注入 `isTrusted: (e) => boolean`。測試 `no_test_hooks_on_page_handle`。
- L3：已由步驟 4 第 2 點處理（開始前先取消既有迴圈）。測試 `repeated_enable_single_discovery_loop`。

### 步驟 9：驗證與提交

- [ ] 依序執行「測試」章節的全部指令，記錄結束碼與測試數量。
- [ ] 建議的產品 commit 切分（英文訊息），每個 commit 結束時 typecheck 與測試都要能過：
  1. `fix(audio-lock): make reducer enforce token edge, settle and refresh observations`（contracts、state、state.test）
  2. `fix(audio-lock): track cell generations and rebind player ports`（adapter、players、相關測試、fixtures）
  3. `fix(audio-lock): keep watching layout after discovery and dispatch lifecycle events`（controller、controller.test、fixtures）
  4. `fix(audio-lock): rate-limit guard mutes and latch degraded sessions`（controller、controller.test）
  5. `test(audio-lock): cover settings bridge races`（settings.test，L1 如果有做也放這裡）
- [ ] 寫實作報告 `docs/plans/reports/twitch-audio-lock-impl-2.md`：逐項列出「發現 → commit → 測試名稱」對照、指令結果表、偏離與理由、尚未完成的人工清單。另外用 `docs: add twitch-audio-lock implementation report 2` 提交。
- [ ] 不 push、不開 PR、不 merge。

## 測試

### 逾時規則

- vitest config 已設定 `testTimeout`／`hookTimeout`／`teardownTimeout` 都是 5000ms，不要調高。
- 每個 process 都用 `.cache/run-with-timeout.py` 包住：install 300 秒；lint、typecheck、test 120 秒；每個 build 180 秒。逾時一律 exit 124，不能當作通過。
- 120 秒的 discovery、bootstrap 等待都用 fake timers 推進，例如 `advanceTimersByTimeAsync(121_000)`，不實際等待。

### 必須新增的自動測試

**state.test.ts**

| 測試名稱 | 斷言 |
| --- | --- |
| `focus_token_requires_muted_to_unmuted_edge` | 有效 token，但 `lastObservedMuted` 是 `false` 或 `null`，再讀到 false：不選格；selected 的非 active 格產生 `MUTE_PLAYER`；token 沒有被消耗。 |
| `token_edge_selects_once` | 先 OBSERVED true、再 OBSERVED false（token 有效、不在 settle 內）：恰好產生一次 `CALL_ORIGINAL_SET_MUTED(false)`；接著第二次 true→false 不再授權。 |
| `refresh_mute_true_is_observation_only_in_bootstrap` | bootstrap 四格 U，`OBSERVED_MUTED(true, origin: "refresh")`：effects 為空，selection 仍是 bootstrap。 |
| `refresh_mute_true_respects_grant_and_settle` | active 有未消耗的 grant，或 `settleUntil > now` 時讀到 true：不進 silence；兩者都不成立時才進 silence，並產生 `CALL_ORIGINAL_SET_MUTED(true)`。 |
| `observed_false_uses_assignment_in_bootstrap` | bootstrap、assignment 為 true、讀到 false → `MUTE_PLAYER`；assignment 為 U 或 false → 沒有 effect。 |
| `mute_settle_and_unsettled_count` | `MUTE_SENT` 之後 1500ms 內讀到 false 不產生 effect；連續 3 次 `MUTE_SENT` 而且一直讀到 false → degraded + `REPORT_ONCE("player-mute-did-not-settle")`；中間只要讀到 true，計數就歸零。 |
| `player_ready_normalizes_only_unassigned` | selected、非 active 格：U → `SET_STORE_MUTED`；true → 沒有 effect；兩種情況都不會產生 `MUTE_PLAYER`。 |
| `discovered_keeps_degraded_and_locked` | degraded 收到 `DISCOVERED` 仍是 degraded；locked 收到 `DISCOVERED` 仍是 locked；`RESET_DEGRADED`／`ENABLE` 會解除 degraded。 |
| `classifyLayout_add_reorder_remove_replace` | 分別驗證 add、reorder、none、remove-active、replace-active，以及非 active 格的 removed 清單。 |
| `classifyLayout_preset_and_merge` | 帶 `setLayoutContent`／`setLayout` 的 mutation 時：active core 還在 → `merge-preset`，`preservedActive` 帶新 generation；不在 → `preset`。 |
| `storeConverged_allows_pending_unassigned` | pending 格是 U 時仍算收斂；非 pending 格是 U 或 false 時不算收斂。 |

**adapter.test.ts**

| 測試名稱 | 斷言 |
| --- | --- |
| `generation_bumps_on_content_provider_vm_or_player_change` | 只換 contentId、只換 provider、只換 VM instance、player 物件 A→B，generation 都會改變；`null → player` 和重複 discover 不會改變。 |
| `snapshot_identity_matches_binding_identity` | `buildSnapshot()` 的每格 identity 跟 `discover()` 回傳的 binding 用 `sameIdentity` 比較結果為 true，包括換 provider 之後。 |
| `observe_disconnects_on_dispose` | `observe()` 回傳的 disposer 呼叫兩次不會出錯，DOM 變化後不再觸發 callback。 |
| `subscribe_does_not_build_snapshot_synchronously` | commit 時只觸發 `onMutation(type)`；snapshot callback 不在同一個同步呼叫堆疊中觸發。 |

**players.test.ts**

| 測試名稱 | 斷言 |
| --- | --- |
| `onReady_fires_once_on_first_bind` | 未 ready → `fireReady` → `onReady` 呼叫一次；再次 fireReady 或 `readMuted` 不再觸發；dispose 後也不觸發。 |
| `isBound_reflects_late_bind_and_dispose` | ready 前是 false，bind 後是 true，dispose 後是 false。 |

**controller.test.ts**（所有案例都透過 `setEnabled(true)` 和真正的 discovery／observer 路徑，不能只靠 `__setState` 設定初始狀態）

| 測試名稱 | 對應發現 | 斷言 |
| --- | --- | --- |
| `rescans_cells_added_after_discovery_window` | H1 | 選定 A，推進 121 秒，`addFakeCell` 新增 Twitch B（assignment 為 true）；推進一個 rAF 和 0ms 之後，B 已經 patch。B 呼叫 `setMuted(false)`（refresh）和原生 first play 之後，`a.muted === false`，active 仍是 A。 |
| `session_observers_released_on_teardown` | H1 | `setEnabled(false)`、`dispose()`、離開 `/multiview` 三種情況，`countSessionResources` 都回到啟用前的數字，MutationObserver 的 disconnect 次數等於建立次數。 |
| `same_key_provider_swap_rebinds_port` | H2 | A 是 active，B 從 Twitch 換成 YouTube（新 SDK 回報 unmuted）：B 的 generation 改變，舊 Twitch port 被 dispose，下一次 poll 對新 YouTube SDK 的 `muteCalls >= 1`，舊 SDK 沒有被呼叫。 |
| `player_rebuild_bumps_generation_and_drops_stale_results` | H2 | 舊 player 的 read 停住，期間執行 `replacePlayer`；舊 read 晚回時不會寫入任何 player 或 store，新 port 正常運作。 |
| `new_vm_instance_for_same_key_is_patched` | H2 | 同一個 key 換成新的 VM：舊 VM 的方法已還原，新 VM 已 patch。 |
| `locked_add_unassigned_cell_normalized_on_ready` | H2／主計畫初始化 ② | 選定 A，新增 U 格且 player 還沒 ready：不呼叫 SDK、不改 store。`fireReady` 之後 store 變成 true，fresh read 為 false 時 `muteCalls === 1`；A 不變，也沒有 degraded。Twitch、YouTube 各跑一次。 |
| `preset_replace_bootstraps_merge_keeps_active_silence_stays` | H2／題 2 | 全 U 的 preset 換掉 A → 進 bootstrap，首播一次就收斂；merge preset 保留 A → active 不變，新格正規化；先前是 silence 的 preset → 仍是 silence；舊 Promise 不寫入新格。 |
| `remove_active_enters_silence` | H2 | `removeFakeCell(A)` → silence；之後其他格 first play 也不會取得聲音。 |
| `refresh_mute_true_is_observation_only` | M | bootstrap 四格 U，refresh 對每格送出 `setMuted(true)`：store 仍是 U、selection 仍是 bootstrap；之後首播仍然只選一格。 |
| `focus_token_requires_muted_to_unmuted_edge` | M | 重現 probe 情境：B 一直回報 false、iframe focus 產生 token、下一次 poll → active 仍是 A。正向案例：先讀到 true，再讀到 false（在 2500ms 內）→ B 被選中。 |
| `mute_writes_respect_cooldown_and_settle` | M | SDK 用 `ignoreMute`，連續 10 次 1000ms poll：mute 寫入不超過 4 次，而且任兩次之間至少隔 1500ms。 |
| `mute_did_not_settle_degrades_after_three` | M | 承上，第 3 次之後再讀到 false → degraded，console.warn 恰好一次，所有 wrapper 都已還原。 |
| `store_did_not_settle_degrades_at_500ms` | M | 面板選 B 之後，讓 fixture 的 `muteOthers` 不寫 state：500ms 後 degraded，並報 `store-did-not-settle`；正常收斂時不會 degraded。 |
| `selection_settle_ignores_stale_true` | M | SDK 設定 `settleDelayMs: 800`，面板選 B：1500ms 內的 poll 讀到 true 也不進 silence；SETTLE_EXPIRED 時已經是 false → 維持 B。另一個案例 SDK 一直是 true → 到期後進 silence，並報一次 `restore-failed`。 |
| `degraded_is_not_reinstalled_by_discovery` | M | 3 次讀取失敗 → `player-unavailable`；之後推進 30 秒，B 沒有再被 patch，mode 仍是 degraded。 |
| `reenable_or_route_reentry_clears_degraded` | M | `setEnabled(false/true)`、離開後重新進入 `/multiview`（各自獨立的案例）之後，會重新 patch 並運作。 |
| `early_return_supplement_exactly_once_without_fixture_counter` | M | 在 patch 之前包住 cell 原本的 `muteOthers` 來計數，並把 `cell.muteOthersCalls` 換成沒有 `length` 的物件；面板選擇 assignment 為 true 的格子 → 計數為 1；選擇 U 或 false 的格子 → 計數也為 1。 |
| `fallback_skips_paused_and_not_playing` | M | bootstrap 四格 U、hook 晚到；只有第 3 格 `updatePausedState(false)`，第 1 格 ready 但 paused → fallback 選第 3 格。 |
| `fallback_waits_then_rearms_on_play` | M | 沒有播放中的格子 → 1000ms 不選格；之後第 2 格開始播放 → 再 1000ms 選第 2 格；超過 120 秒就不再排。 |
| `unassigned_selection_restores_actual_player_audio via first-play` | M（回歸缺漏） | 主計畫 N1 的首播路徑：被選格 watcher 呼叫 0 次，rawMuted 恢復成 false，恰好一次 `unmuteCalls`。 |
| `unassigned_selection_restores_actual_player_audio via fallback` | M（回歸缺漏） | 同上，fallback 路徑。 |
| `manual_refresh_cannot_switch_active` | M（回歸缺漏） | A 已選定，B 的 refresh 送出 `setMuted(false)`，以及 B 的 first play：active 不變。Twitch、YouTube 各跑一次。 |
| `pending_grant_cancelled_by_disable_mute_all_or_new_selection` | M（回歸缺漏） | grant 的 fresh read 停住期間，分別 `setEnabled(false)`、全部靜音、選擇另一格：舊格的 `unmuteCalls === 0`。 |
| `last_command_wins_a_b_a` | M（回歸缺漏） | 同一個 macrotask 依序面板選 A→B→A：debounce 執行後 active 是 A，store 只有 A 是 false，B 的晚到 read 不會改變結果。 |
| `bfcache_pageshow_revalidates` | M（回歸缺漏） | `pagehide` → 資源全部釋放；`pageshow`（persisted）→ 重新 patch，A 的選擇從 store 的唯一 false 重新建立。 |
| `toggle_ten_times_no_leak` | M（回歸缺漏） | `setEnabled(true/false)` 連續 10 次：wrapper、port、listener、timer 數量都回到 baseline；Mute Others 關閉期間 wrapper 完全不存在（或完全委派原方法）。 |

**settings.test.ts**

| 測試名稱 | 斷言 |
| --- | --- |
| `storage_change_before_get_resolves_wins` | get 還沒 resolve 時收到 onChanged(false)：送出 false；get 之後以 true resolve 時不再送 config。 |
| `storage_change_before_get_rejects_wins` | 同上，但 get reject：不 warn，也不覆蓋成 false 以外的值。 |
| `storage_rejection_disables_and_warns_once` | get reject、沒有 change：送出 false，warn 一次。 |
| `ready_before_and_after_storage_read` | ready 早於 read 完成、或晚於 read 完成，最後送出的 config 都等於 storage 的值。若沒做 L1，「早於」案例允許先送一次預設值，但最後一筆必須正確。 |
| `pageshow_starts_new_read_after_timeout` | 5000ms 逾時後 disabled；pageshow 觸發新的讀取，讀到 true 後恢復。 |
| `page_messages_cannot_write_storage` | page 端送出偽造的 config、未知 type、`set` 類訊息：`storage.local.set` 呼叫 0 次。 |

### 驗證指令

```sh
export npm_config_cache="$PWD/.cache/npm" YARN_CACHE_FOLDER="$PWD/.cache/yarn" TMPDIR="$PWD/.cache/tmp"
mkdir -p "$TMPDIR"
T=".cache/run-with-timeout.py"
python3 $T 300 npx --yes yarn@1.22.22 install --frozen-lockfile --non-interactive --cache-folder "$YARN_CACHE_FOLDER"
python3 $T 120 node .cache/audio-lock-lint/run.cjs
python3 $T 120 node .cache/audio-lock-lint/run.cjs src/utils/options.ts src/pages/content/holodex/contentScript.ts src/pages/content/holodex/holodex-inject.ts --format unix
python3 $T 120 npx --yes yarn@1.22.22 typecheck:audio-lock
python3 $T 120 npx --yes yarn@1.22.22 test:audio-lock
python3 $T 180 npx --yes yarn@1.22.22 build:chrome
python3 $T 180 npx --yes yarn@1.22.22 build:firefox
grep -rn "muteOthersCalls\|__trusted" src/ || echo "no fixture coupling"
git diff --check db6fd32 HEAD
```

整合檔 lint 跟 baseline 比較：沿用主計畫的方式，baseline 是 709e963 版本的 3 則 `@typescript-eslint/ban-ts-comment`，修正後必須相同。

## 驗收條件

- [ ] 上述所有指令的結束碼都符合預期（lint 整合檔與 baseline 相同，其他都是 0）。測試數量比 baseline 的 49 多，新增案例逐一對應「測試」章節的名稱。實作報告的數字要跟實際輸出一致。
- [ ] **H1**：發現成功之後，不論過了多久，新增的格子都會在下一個 rAF／0ms／2000ms heartbeat 內被 patch，原生的 setMuted(false) 和 first play 都不能搶走 A。session 的 observer、store 訂閱、timer 在停用、dispose、離開 multiview、pagehide 時都會釋放（`session_observers_released_on_teardown`、`toggle_ten_times_no_leak`）。
- [ ] **H2**：換 content、換 provider、重建 player、換 VM instance 都會產生新的 generation；舊 port 被 dispose，舊的非同步結果被丟棄，wrapper 使用目前的 identity。controller 實際送出 `LAYOUT_CHANGED`、`PLAYER_READY`、`CELL_REMOVED`；新增的 U 格 READY 後 store 變成 true，preset、merge、silence 三種分支照題 2A 處理。
- [ ] 面板以外的 `setMuted(true/false)` 都只當 observation；bootstrap 期間不改 store、不進 silence。
- [ ] 焦點或 pointer token 只在同一個 generation 觀察到 true→false 時授權一次，而且不在自身的 settle 期間內。
- [ ] mute 寫入遵守 1000ms 冷卻、1500ms settle、單一 in-flight；3 次沒有收斂就 degraded。選擇後 500ms 內 store 沒收斂就 degraded；1500ms selection settle 有效；3 次讀取失敗就 `player-unavailable`。
- [ ] degraded 之後，發現迴圈、heartbeat、observer 都不會重新安裝；只有重新啟用、路由重新進入、BFCache pageshow 會重新探測。
- [ ] `src/` 裡沒有 `muteOthersCalls`；提前返回時的補呼叫，在 assignment 為 true／U／false 三種情況下，mapped method 都恰好呼叫一次。
- [ ] fallback 只選目前沒有 paused、而且 ready 的格子，用的是當下的 snapshot；沒有候選就等待並重新排程，上限 120 秒。
- [ ] 沒有新增依賴、權限、產品模組或測試檔；`package.json`、`yarn.lock`、manifest、tsconfig、Vite config、options UI 都沒有 diff。產品 commit 是英文訊息、只含白名單檔案，跟 docs commit 分開。兩個 build 的 manifest 權限與 web_accessible_resources 的 match 範圍不變，page bundle 裡沒有 `webextension-polyfill`。
- [ ] 實作報告如實寫出人工清單仍未執行；只能稱為「可交付實測」候選。沒有 push、PR、merge、公證或分支操作。
