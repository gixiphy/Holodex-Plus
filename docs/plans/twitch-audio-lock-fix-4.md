# Twitch audio lock 修正計畫 fix-4：沒有播放就把 YouTube 靜音

> 執行者是 Cursor，驗收者是 Codex。逐任務實作，步驟用 checkbox（`- [ ]`）追蹤。實作偏離本計畫時，寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-5.md` 的「偏離」段落。不要回頭改本計畫、主計畫或既有報告。

**Goal：** 讓音訊鎖在沒有播放、沒有使用者操作時，不再把 store 選中的有聲格（本情境是 YouTube）寫成 `muted=true`。行為回到 MVP 的對照標準：先播的那格保有聲音，晚來的 Twitch 被壓回靜音，使用者真的點進 Twitch 並取消靜音時才切換。

**Architecture：** 根因是 active 的 `CellIdentity` 和實際 binding 的 identity 對不上（`generation` 不同）。state 因此把真正的 active 格當成「別格」，在它 READY 時靜音。修法是新增一個 state 事件 `BINDING_REBOUND`，在 controller 同步 binding 時把 active 換成「同一格、同一內容」的新 identity。換片或換 provider 仍照舊進 silence。不改 bootstrap、意圖窗、降級政策。

**Tech Stack：** 既有 TypeScript、Vitest＋jsdom（`vitest.audio-lock.config.ts`）、既有 headless Chrome harness（`tests/e2e-browser/audio-lock/`）。不新增任何 dependency。

**依據：** 主計畫 `docs/plans/twitch-audio-lock.md`（第 160、184、209 行與文末「決定紀錄」）、`docs/plans/twitch-audio-lock-fix-3.md`、驗收 `docs/plans/reviews/twitch-audio-lock-impl-review-4.md`（FAIL，1 high）、證據 `docs/plans/evidence/twitch-audio-lock-fix-4/`（`ROOTCAUSE-2.md`、`trace2-f59.json`、`trace2-mvp.json`、`run-trace.mjs`）。

日期：2026-10-17。分支 `gixiphy/twitch-audio-lock`，基準 head 是本計畫的 docs commit（父 commit `7e718a7`）。

## 根因（已用原始碼與單元探針確認）

規劃時在 scratchpad 寫了一支探針測試，用既有 `tests/audio-lock/fixtures.ts`，沒有改 repo 的 src 或 tests。修正前，下列兩條路徑都重現「YT store `muted` 從 false 變 true、Twitch 也是 true」，也就是兩格都沒有聲音。協調者推測的 bootstrap fallback **不是**這次的路徑：store 一開始就是 a=false、b=true，`applySnapshotSelection` 直接選出 active，fallback 計時器不會啟動。

### 路徑 M1：active 在 binding 註冊前就從 snapshot 選出（本次 e2e 的主因）

1. `src/pages/content/holodex/audio-lock/controller.ts:831-837`：store mutation（harness 的 `setLayout`／`setLayoutContent`／`setMuteOthers`）讓 `processLayout` 排在 `setTimeout(0)`。cell 的 binding 則要等 MutationObserver 觸發 `scheduleRescan` 的 rAF（`controller.ts:856-863`）或 2000ms heartbeat 才會註冊。所以 `processLayout` 經常比 binding 先跑。
2. `src/pages/content/holodex/audio-lock/holodex-adapter.ts:347-356`：`buildSnapshotFromStore` 遇到 registry 還沒有的 key，用 `generation = reg?.generation ?? 1` 補值，provider 用 `providerFromContent` 猜。
3. `src/pages/content/holodex/audio-lock/state.ts:231-238`：`applySnapshotSelection` 找到唯一有聲格 a，直接把 snapshot 的 identity `{a, gen 1}` 設成 `active`，狀態變成 `locked/selected`。
4. `holodex-adapter.ts:164-175`、`:259-280`：之後 rescan 才用 `generationCounter++` 註冊 binding。`walkChildren` 用 stack pop，最後一個 child 先被拜訪，所以 b 拿到 gen 1、a 拿到 gen 2。active `{a, gen 1}` 變成沒有任何 binding 對應的「幽靈 identity」。`controller.ts:742-745` 的「identity 沒變」分支、以及之後的 `STORE_SNAPSHOT`（`state.ts:488-503`，locked 時不重選）都不會修正它。
5. `controller.ts:490-499` → `state.ts:717-727`：YT 播放器 READY 時，`PLAYER_READY` 判定 `!sameIdentity(active{gen1}, a{gen2})`，而且 `assignment === false`，於是產生 `SET_STORE_MUTED(a, true)`。
6. `controller.ts:297-300` → `holodex-adapter.ts:589-597`：commit `multiview/setLayoutContentWithKey` 把 a 的 `muted` 寫成 true，Holodex 把它存進 localStorage。trace2-f59 第 4 個 preReload 取樣（YT/TW 播放器剛出現）就是這一刻。
7. reload 後：`state.ts:219-228` 的 `allMuted` 讓狀態進入 `silence`；`state.ts:66-68`、`:728-736` 讓兩格都保持靜音。Codex 第 4 輪看到 `checks.initial` 全是 true，YT 靜音取樣 168/168。

**為什麼跟時序有關：** 要看 rAF rescan 和 `setTimeout(0)` 的 `processLayout` 誰先跑、registry 註冊順序，以及 READY 先於還是晚於 rescan。21:4x 那次通過，是因為 binding 剛好在選 active 前註冊，或 a 剛好拿到 gen 1。

### 路徑 M2：同內容的 cell 或 player 重建，被當成刪除 active

1. `holodex-adapter.ts:178-195`：同一個 key、同一內容，只要 VideoCell VM 換了實體（`prev.cell !== cell`）或 player 元件換了（`playerChanged`），`generation` 就會 +1。
2. `controller.ts:747-766`：`syncBindings` 看到 identity 改變，一律送 `CELL_REMOVED(old)`。
3. `state.ts:793-796`：`CELL_REMOVED` 只比 `identityCore`（key|provider|contentId），一樣就 `toSilence`。新 player READY 時，`state.ts:728-736` 對 `assignment=false` 的 a 送 `SET_STORE_MUTED`，結果同樣是兩格都靜音並被持久化。

這違反主計畫第 209 行：「重建相同內容的 player 可在確認原 active content 未變後承接選擇，但必須換 generation、重建 port，舊結果無效。」

### 不是根因、這輪不動的部分

- `armBootstrapFallback`（`controller.ts:425-472`）、`BOOTSTRAP_READY`（`state.ts:531-546`）：這個情境沒有進入 bootstrap。
- `PLAYER_READY` 在 `selected` 時把「非 active、store 非 true」的格寫成 true（`state.ts:717-727`）：這是主計畫「locked 時新增格正規化」的設計（既有測試 `locked_add_unassigned_cell_normalized_on_ready`）。active identity 正確之後，這條規則就不會碰到 active 格。
- silence 政策、2500ms 意圖窗、一次 console.warn、降級政策：全部維持（主計畫決定紀錄 1–8）。

## 修法選擇

| 方案 | 做法 | 結論 |
| --- | --- | --- |
| A. active 重新綁定 | 新增 `BINDING_REBOUND` 事件。controller 在 `syncBindings` 結尾與 `processLayout` 結尾，把「同 key、同 contentId」的 active 換成目前 binding 的 identity。同內容重建也走這條，不送 `CELL_REMOVED` | **採用** |
| B. snapshot 不選 active | binding 註冊前不從 snapshot 選，等 binding | 不採用：等待期間 Twitch 首播會走 `NATIVE_FIRST_PLAY` 搶到 active，正好重演這次的 bug |
| C. 比對改用 `identityCore` | `sameIdentity` 不再比 generation | 不採用：主計畫第 160 行要求 active 綁定 player generation，舊非同步結果要靠 generation 丟棄 |
| D. adapter 先註冊 registry | `buildSnapshotFromStore` 遇到未知 key 先登記 | 不採用：此時拿不到 cell VM 與 player，之後一定還會 bump，問題只是往後移 |

A 只改 3 個產品檔，跟主計畫第 209 行的規格一致，也同時修掉 M1 和 M2。

## Global Constraints

- 禁止 push、開 PR、merge（不合併任何分支、不碰 remote）、公證（notarize）、sudo；不建立或切換分支。
- 所有寫入限於本 worktree；commit 寫入主 repo 的 Git metadata 屬允許範圍。禁止刪除 worktree 以外的任何東西。Chrome 暫存 profile 一律在 `.cache/e2e-browser/`。
- 快取：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；yarn 一律用 `npx --yes yarn@1.22.22`，安裝用 `--frozen-lockfile`。
- **不新增 dependency**；`package.json`、`yarn.lock` 不得變動。
- 產品 commit 訊息只用英文，Conventional Commits。
- 不動 fix-3 的建置修正：`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**` 一律不改。
- 產品程式碼**只**允許改 `src/pages/content/holodex/audio-lock/contracts.ts`、`state.ts`、`controller.ts`。`holodex-adapter.ts`、`players.ts`、`twitch-audio-lock.ts`、`holodex-inject.ts`、`audio-lock-settings.ts`、`contentScript.ts`、`src/utils/**` 都不動。
- 既有 117 個 audio-lock 測試不得變紅、不得刪除或改弱斷言。若某個既有測試和主計畫第 209 行衝突，必須停下來寫進報告，不可自行改測試。
- `docs/plans/evidence/**`、`.ref/` 唯讀。`tests/e2e-browser/audio-lock/fakes.js` 保持和 `docs/plans/evidence/twitch-audio-lock-fix-3/harness/fakes.js` 逐位元相同。
- MVP 擴充 `/Applications/Extensions/holodex-plus-audiolock-chrome` 只能唯讀載入，不能修改、移動或寫入。

## 回合與額度上限

- 本任務已失敗 1 次（Codex 第 4 輪）。**實作最多再 2 輪**（Cursor 實作 → Codex 驗收算 1 輪）。驗收 FAIL 累計 3 次就停止，不開下一輪，由協調者回報 Fi。
- **Cursor 每輪**：工作時間上限 90 分鐘；e2e `run.mjs` 最多 10 次（每次本身有 240 秒全域逾時，外層再包 280 秒）；`yarn build` 最多 6 次。
- **Codex 每輪**：驗收上限 60 分鐘；e2e 最多 8 次。
- 超過上限就停在目前狀態寫報告，不硬做。
- 如果在任何一輪發現方案 A 在真實 holodex.net 上不足以讓 YT 保有聲音（例如還有第三條路徑會寫 `SET_STORE_MUTED`），先把追蹤證據寫進報告的「新發現」段落，**不要**自行改 bootstrap、silence 政策或意圖窗。

## Review Focus

1. **Twitch 是 active 而且晚綁定**：真實 Holodex 的 `content.video` 是物件，`providerFromContent` 會把未註冊的 Twitch 猜成 youtube。late-bind 的比對只用 key＋contentId，不比 provider → 任務 1 的 state 測試 `rebound_late_bind_ignores_guessed_provider`。
2. **真的換片或換 provider 不能被「承接」**：contentId 不同時，仍要進 silence，不可沿用舊 active → 任務 1、2 的 `rebound_ignores_content_change` 與 `active_content_change_still_enters_silence`。
3. **重新綁定後不能誤觸降級**：`STORE_DID_NOT_SETTLE` 計時器若還指著舊 identity，500ms 後不應降級，也不應印 warn → 任務 2 的 `late_bind_rebound_does_not_degrade`。
4. **重新綁定後 Twitch 首播或自己取消靜音仍要被壓回**：active 修正後，原本的防搶邏輯要繼續生效 → 任務 2 的 `late_bind_then_twitch_first_play_cannot_steal`。
5. **使用者真的選 Twitch 仍要能切換**：面板 `setMuted(false)` 要切到 Twitch，YT 被設為靜音 → 任務 2 的 `late_bind_panel_unmute_twitch_switches`。

---

## 檔案

| 檔案 | 動作 | 用途 |
| --- | --- | --- |
| `src/pages/content/holodex/audio-lock/contracts.ts` | 修改（`LockEvent` union，約第 105–160 行） | 新增 `BINDING_REBOUND` 事件型別 |
| `src/pages/content/holodex/audio-lock/state.ts` | 修改（`transition` 新增一個 case） | 純函式：把 active 換成新 identity，舊 grant／intent 失效 |
| `src/pages/content/holodex/audio-lock/controller.ts` | 修改（`syncBindings` 第 747–766 行、新增 `reboundActive()`、`processLayout` 第 820–828 行） | 同內容重建改送 `BINDING_REBOUND`；late-bind 修正幽靈 active |
| `tests/audio-lock/state.test.ts` | 修改（新增測試，不改既有） | `BINDING_REBOUND` 純函式測試 |
| `tests/audio-lock/rebind.test.ts` | 新增 | controller 層級的時序重現測試（M1、M2，修正前 FAIL） |
| `tests/e2e-browser/audio-lock/run.mjs` | 修改 | reload 前、reload 後到開始播放前，都取樣 store `muted`；修 6 個 lint 錯誤 |
| `tests/e2e-browser/audio-lock/compare.mjs` | 修改 | 新增「沒有播放就被靜音」的判定與表格列 |
| `tests/e2e-browser/README.md` | 修改 | 說明新增的取樣、判定與「連續 3 次」指令 |
| `docs/plans/reports/twitch-audio-lock-impl-5.md` | 新增 | 實作報告 |
| `docs/plans/reports/e2e-fix4/` | 新增 | 3 次 fix 與 MVP、none 的原始 JSON |

---

## 步驟

### 任務 1：state 層 `BINDING_REBOUND`

**Files:**
- Modify: `src/pages/content/holodex/audio-lock/contracts.ts`（`LockEvent`）
- Modify: `src/pages/content/holodex/audio-lock/state.ts`（`transition`）
- Test: `tests/audio-lock/state.test.ts`

**Interfaces:**
- Produces（contracts.ts，加進 `LockEvent` union）：
  ```ts
  | {
      type: "BINDING_REBOUND";
      now: number;
      previous: CellIdentity;
      identity: CellIdentity;
      reason: "remount" | "late-bind";
    }
  ```
- Produces（state.ts）：`transition(state, BINDING_REBOUND)` 的規則：
  1. `!state.extensionEnabled` 時原樣回傳（`effects: []`）。
  2. 不論 active 是誰，都把 `cells[identity.key]` 重設成 `emptyCellRuntime()`，取代原本 `CELL_REMOVED` 對非 active 格做的清理。
  3. 符合條件才替換 active。條件是 `state.active` 不為 null、`state.active.key === identity.key`、`state.active.contentId === identity.contentId`、`!sameIdentity(state.active, identity)`，而且：
     - `reason === "remount"`：另外要求 `sameIdentity(state.active, previous)`，且 `identityCore(previous) === identityCore(identity)`。
     - `reason === "late-bind"`：另外要求 `sameIdentity(state.active, previous)`。**不比 provider**，因為 snapshot 的 provider 可能是猜的。
  4. 替換時：`bumpEpoch`；`active = identity`；`selection`、`mode` 不變；`selectionGrant` 的 identity key 等於 `identity.key` 時清掉；`intent` 的 identity key 等於 `identity.key` 時清掉。`effects` 一律是空陣列（不送任何 mute 或 unmute）。
  5. 不符合條件：除了第 2 點以外原樣回傳，`effects: []`。

- [ ] **Step 1：在 `state.test.ts` 新增 5 個失敗測試**（放在既有 `describe` 的最後，沿用該檔的 helper 與 identity 寫法）
  - `rebound_remount_replaces_active_and_bumps_epoch`：在 `selected`／`locked` 狀態下，active 是 `{a, yt1, youtube, gen 1}`，送 `remount` 事件，`identity` 為 gen 3。`expect(next.active).toEqual(gen3)`、`expect(next.epoch).toBe(prev.epoch + 1)`、`expect(next.selection).toBe("selected")`、`expect(next.mode).toBe("locked")`、`expect(effects).toEqual([])`。
  - `rebound_clears_grant_and_intent_for_same_key`：狀態先帶 key a 的 `selectionGrant` 和 `intent`。事件後 `expect(next.selectionGrant).toBeNull()`、`expect(next.intent).toBeNull()`。另外再測一個 key b 的 `intent`，事件後要保留。
  - `rebound_late_bind_ignores_guessed_provider`：active 是 `{b, tw1, provider:"youtube", gen 1}`，`identity` 是 `{b, tw1, provider:"twitch", gen 2}`，reason 為 `late-bind`。`expect(next.active).toEqual(identity)`。
  - `rebound_ignores_content_change`：`identity.contentId` 不同（`yt2`）。`expect(next.active).toEqual(prev.active)`、`expect(next.epoch).toBe(prev.epoch)`。
  - `rebound_without_matching_active_only_resets_runtime`：分兩種情況，active 為 null，以及 active 是別的 key。`expect(next.active).toEqual(prev.active)`，而且 `next.cells[identity.key]` 等於 `emptyCellRuntime()`。

- [ ] **Step 2：確認失敗**
  Run：`npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/state.test.ts`
  Expected：新 5 個 FAIL（TypeScript 型別錯誤或斷言失敗），既有 28 個 PASS。

- [ ] **Step 3：實作 contracts 型別與 `transition` 的 `case "BINDING_REBOUND"`**（照 Interfaces 規則；用既有 `bumpEpoch`、`patchCell`／`emptyCellRuntime`、`sameIdentity`、`identityCore`）

- [ ] **Step 4：確認通過**
  Run：同 Step 2。Expected：33 passed。

- [ ] **Step 5：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/contracts.ts src/pages/content/holodex/audio-lock/state.ts tests/audio-lock/state.test.ts
  git commit -m "fix(audio-lock): add BINDING_REBOUND transition for re-bound active cells"
  ```

### 任務 2：controller 在同步 binding 時重新綁定 active

**Files:**
- Modify: `src/pages/content/holodex/audio-lock/controller.ts`
- Test: `tests/audio-lock/rebind.test.ts`（新增）

**Interfaces:**
- Consumes：任務 1 的 `BINDING_REBOUND` 事件。
- Produces（controller.ts 內部，不 export）：`const reboundActive = (): void`。行為如下：
  - 若 `state.active` 為 null 就 return。
  - 若 `lastBindings` 裡已經有任何 binding 和 `state.active` `sameIdentity`，就 return。
  - 取 `binding = lastBindings.get(state.active.key)`；若不存在，或 `binding.identity.contentId !== state.active.contentId`，就 return。
  - 否則送 `transition(state, { type: "BINDING_REBOUND", now: now(), previous: state.active, identity: binding.identity, reason: "late-bind" })`，`state = result.state`，再 `void applyEffects(result.effects)`。
  - 若 `storeSettleTarget` 和 `previous` 是 `sameIdentity`，把 `storeSettleTarget` 改成新 identity、`storeSettleEpoch` 改成新的 `state.epoch`，計時器本身不重設。
  - **不要**呼叫 `armStoreSettle`／`armSelectionSettle`。`applyEffects` 開頭取的 `prevActive` 已經是新 identity，所以 `onActiveChanged` 不會重新計時。
- 修改點：
  1. `syncBindings` 的「identity changed」分支（`controller.ts:747-766`）：若 `identityCore(old.identity) === identityCore(neu.identity)`，就不送 `CELL_REMOVED`，改送 `BINDING_REBOUND`（`reason: "remount"`，`previous: old.identity`，`identity: neu.identity`）。port 與 settle timer 的清理、unpatch、`installBinding(neu)` 照舊。core 不同（換片、換 provider）時維持原本的 `CELL_REMOVED`。
  2. `syncBindings` 結尾（`controller.ts:768-770` 迴圈之後）呼叫 `reboundActive()`。
  3. `processLayout` 在 `checkStoreSettle(snapshot)` 之前（`controller.ts:827` 前）呼叫 `reboundActive()`。
  4. `identityCore` 要從 `./contracts` import。

- [ ] **Step 1：新增 `tests/audio-lock/rebind.test.ts`，寫 6 個失敗測試**
  檔頭沿用 `controller.test.ts` 的 `beforeEach`/`afterEach`（fake timers、清 DOM、`handle.dispose()`）。fixture 只用 `tests/audio-lock/fixtures.ts` 現有的 export，不改 fixtures。`controller.test.ts` 的 `setupEnv`（第 395–427 行）沒有 export，請在 `rebind.test.ts` 內複製一份同名的區域 helper，不要改 `controller.test.ts`。面板操作照 `controller.test.ts:239-245` 的寫法：`const ev = createPanelEvent(true); beginPanelDispatch(ev, true); await flushMicrotasks(); cell.setMuted(false); endPanelDispatch(ev);`。共用情境 `lateBindEnv()`：
  1. `createFakeStore({ muteOthers: true, cells: [] })` 加上 `createFakeMultiviewRoot(store, [])`，`history.pushState` 到 `/multiview`。
  2. `createAudioLockController`、`setEnabled(true)`、`__tryDiscover()`，然後 `advanceTimersByTimeAsync(0)`。
  3. 依序 `store.commit("multiview/setLayoutContent", { a: { id: "yt1", type: "video", video: "yt-a", muted: false }, b: { id: "tw1", type: "video", video: "twitch/b", muted: true } })` 和 `store.commit("multiview/setLayout", [{ i: "a" }, { i: "b" }])`，再 `advanceTimersByTimeAsync(0)`。這時 active 是從 snapshot 選出的 gen 1。
  4. 用 `createFakeVideoCell({ ..., parentEl: multiview.$el, readyBeforeInstall: false })` 建 a（YT SDK `muted:false`）和 b（Twitch SDK `muted:true`）。依 a、b 的順序 push 進 `multiview.$children` 和 `$refs.videoCell`，讓 walk 先拜訪 b。然後 `advanceTimersByTimeAsync(20)`。
  5. `fireReady(ytPlayer)`、`fireReady(twPlayer)`，再 `advanceTimersByTimeAsync(3000)`。

  測試：
  - `late_bind_keeps_snapshot_selected_youtube_audible`（M1，修正前 FAIL）：`expect(store.state.multiview.layoutContent.a.muted).toBe(false)`、`expect(...b.muted).toBe(true)`、`expect(handle.__getState().active).toEqual(handle.__lastBindings.get("a")!.identity)`、`expect(ytSdk.muteCalls).toBe(0)`。
  - `same_content_remount_keeps_active`（M2，修正前 FAIL）：`setupEnv([{ key: "a", provider: "youtube", muted: false }, { key: "b", provider: "twitch", muted: true }])`（cell 已掛好），discover 後 active 是 a。移除 `cellA.$el`，建一個同 key、同 content 的新 VideoCell 和新 YT player（`readyBeforeInstall:false`），換掉 `multiview.$children` 和 `$refs.videoCell`。`advanceTimersByTimeAsync(20)`，`fireReady` 新 player，再 `advanceTimersByTimeAsync(3000)`。`expect(a.muted).toBe(false)`、`expect(state.selection).toBe("selected")`、`expect(state.active!.generation).toBe(handle.__lastBindings.get("a")!.identity.generation)`。
  - `active_content_change_still_enters_silence`（迴歸保護，修正前後都 PASS）：一般環境，active 是 a，`replaceCellContent(env, "a", { provider: "youtube", contentId: "yt-other" })`，推進計時器後 `expect(state.selection).toBe("silence")`、`expect(state.active).toBeNull()`。
  - `late_bind_rebound_does_not_degrade`：`lateBindEnv()` 後再 `advanceTimersByTimeAsync(TIMING.STORE_SETTLE_MS + TIMING.HEARTBEAT_MS)`。`expect(state.mode).toBe("locked")`，並用 `vi.spyOn(console, "warn")` 確認沒有 `"[Holodex+ AudioLock]"` 的呼叫。
  - `late_bind_then_twitch_first_play_cannot_steal`：`lateBindEnv()` 後設 `cellB.firstPlay = true`、呼叫 `cellB.updatePausedState(false)`，再呼叫 `cellB.setMuted(false)`（非面板，模擬 Twitch 自己取消靜音），推進 3000ms。`expect(a.muted).toBe(false)`、`expect(state.active!.key).toBe("a")`。
  - `late_bind_panel_unmute_twitch_switches`：`lateBindEnv()` 後用上面的面板寫法對 `cellB.setMuted(false)`，推進 3000ms。`expect(state.active!.key).toBe("b")`、`expect(a.muted).toBe(true)`、`expect(b.muted).toBe(false)`。

- [ ] **Step 2：確認失敗**
  Run：`npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/rebind.test.ts`
  Expected：至少 `late_bind_keeps_snapshot_selected_youtube_audible`、`same_content_remount_keeps_active` 兩個 FAIL，錯誤是 `expected true to be false`（a.muted）。把輸出摘要貼進報告。

- [ ] **Step 3：照 Interfaces 修改 `controller.ts`**

- [ ] **Step 4：確認通過，並跑全套**
  Run：`npx --yes yarn@1.22.22 test:audio-lock`
  Expected：6 files，117＋5＋6＝**128 passed**，0 failed、0 skipped。既有 117 個的名字和數量不變。
  Run：`npx --yes yarn@1.22.22 typecheck:audio-lock`。Expected：exit 0。

- [ ] **Step 5：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/rebind.test.ts
  git commit -m "fix(audio-lock): keep active cell across late binding and same-content remount"
  ```

### 任務 3：e2e harness 檢查「沒有播放就被靜音」，並修本輪 lint

**Files:**
- Modify: `tests/e2e-browser/audio-lock/run.mjs`
- Modify: `tests/e2e-browser/audio-lock/compare.mjs`
- Modify: `tests/e2e-browser/README.md`

**Interfaces（新增到 result JSON 的欄位）：**
- `result.prePlay: Array<{ t: number; tag: "pre-reload" | "post-reload-settle" | "pre-play"; storeA?: boolean; storeB?: boolean; ytN: number; twN: number; err?: string }>`
- `result.checks.preReloadSamples`、`result.checks.preReloadYtStoreMuted`：tag 為 `pre-reload` 的總數，以及其中 `storeA === true` 的數量。
- `result.checks.prePlaySamples`、`result.checks.prePlayYtStoreMuted`：tag 為 `post-reload-settle` 或 `pre-play` 的總數，以及其中 `storeA === true` 的數量。
- `timeline` 與既有 checks 的意義、取樣節奏都不變（仍是 168＋20 個取樣），才能和 MVP 證據並列。

- [ ] **Step 1：`run.mjs` 新增取樣函式 `samplePre(tag, ms)`**
  每 250ms 執行一次 `E(...)`，讀 `layoutContent.a/b.muted`；`window.__fake` 不存在時 `ytN`、`twN` 記 -1。eval 丟例外（頁面正在 reload）時推入 `{ t, tag, err }`，不中斷流程。表達式可參考證據 `docs/plans/evidence/twitch-audio-lock-fix-4/run-trace.mjs` 的 `preReload`，但**不要**照抄 `/tmp` profile 路徑。

- [ ] **Step 2：`run.mjs` 在三個地方取樣**
  - 第 83 行 `await sleep(1500)` 改成 `await samplePre('pre-reload', 3000)`。等待時間拉長，好涵蓋 YT 和 TW 的 READY。
  - 第 89 行 settle 迴圈裡的 `await sleep(8000)` 改成 `await samplePre('post-reload-settle', 8000)`。
  - 第 90 行 `await sleep(1500)` 改成 `await samplePre('pre-play', 1500)`。
  - 在 `checks.initial` 之後計算 Interfaces 列出的 4 個 checks。

- [ ] **Step 3：`run.mjs` 修 6 個 lint 錯誤（不改行為）**
  - 第 23 行 `m.error ? p.rej(...) : p.res(...)` 改成 `if/else`。
  - 第 29–32、76 行的空 `catch {}` 改成 `catch { /* ignore */ }`。

- [ ] **Step 4：`compare.mjs` 新增判定與表格列**
  - `passCandidate` 新增失敗理由：
    - `preReloadYtStoreMuted`：`c.preReloadYtStoreMuted !== 0` 或 `!(c.preReloadSamples >= 10)`。
    - `prePlayYtStoreMuted`：`c.prePlayYtStoreMuted !== 0` 或 `!(c.prePlaySamples >= 30)`。
    - `initialYtStoreMuted`：`c.initial?.storeA === true`。
  - `rows` 在 `'頁面腳本有跑'` 之後新增三列：`'reload 前 YT 被設靜音取樣'`（顯示 `muted/samples`）、`'reload 後播放前 YT 被設靜音取樣'`（同上）、`'播放前初始 YT store'`（`c.initial?.storeA` 的字串）。舊 JSON（例如 MVP 證據）沒有這些欄位時顯示 `—`。
  - candidate 以外的欄位只顯示，不影響 exit code（維持原本規則）。

- [ ] **Step 5：README 更新**
  說明新增的三段取樣、三個新判定，並加上「連續 3 次」的指令（見「測試」段落）。

- [ ] **Step 6：lint**
  Run：
  ```bash
  node .cache/audio-lock-lint/run.cjs                       # 既有音訊鎖範圍，含新 rebind.test.ts
  node .cache/audio-lock-lint/run.cjs --max-warnings 0 --ext .ts,.mjs \
    tests/e2e-browser/audio-lock/run.mjs tests/e2e-browser/audio-lock/compare.mjs
  ```
  Expected：兩者都是 0 errors、0 warnings。`.cache/audio-lock-lint/` 是之前輪次留在 worktree 的臨時 lint 環境（主計畫決定 8）。如果它不存在，記成 blocker，**不要**安裝 `@typescript-eslint/*`，也不要改 `package.json`。
  `fakes.js`（逐位元保持和證據相同）與 `vite.config.base.ts`（2 個 unused import，`dev` 分支本來就有）不在這輪的 lint 範圍，報告裡照實列出。

- [ ] **Step 7：Commit**
  ```bash
  git add tests/e2e-browser/audio-lock/run.mjs tests/e2e-browser/audio-lock/compare.mjs tests/e2e-browser/README.md
  git commit -m "test(e2e): assert YouTube store is never muted before playback"
  ```

### 任務 4：建置、連續 3 次 e2e、並列 MVP、寫報告

- [ ] **Step 1：建置與產物測試**
  `npx --yes yarn@1.22.22 build`，再跑 `npx --yes yarn@1.22.22 test:artifacts`。Expected：兩個 build exit 0；artifacts 10 pass。
- [ ] **Step 2：連續 3 次 fix e2e**（指令見「測試」）。3 次都要 `compare.mjs` exit 0。任一次失敗就從頭重新計算「連續 3 次」，同時注意本輪 10 次的額度。
- [ ] **Step 3：MVP 與 none 各跑 1 次**，用 compare 產生五欄並列表（fix-1、fix-2、fix-3、MVP 現場、none）。
- [ ] **Step 4：把 5 份原始 JSON 存到 `docs/plans/reports/e2e-fix4/`**（`fix-1.json`、`fix-2.json`、`fix-3.json`、`mvp.json`、`none.json`），並記錄 SHA-256。
- [ ] **Step 5：寫 `docs/plans/reports/twitch-audio-lock-impl-5.md`**，內容包括：測試數量（修正前 FAIL 的輸出摘要、修正後 128 passed）、typecheck、lint、build、artifacts、3 次 e2e 與並列表、每次 e2e 的秒數與 exit code、e2e／build 使用次數、偏離、lint 範圍外的已知項目、新發現。
- [ ] **Step 6：Commit**
  ```bash
  git add docs/plans/reports/twitch-audio-lock-impl-5.md docs/plans/reports/e2e-fix4
  git commit -m "docs: add twitch-audio-lock implementation report 5"
  ```

---

## 測試

| 層級 | 指令 | 通過標準 |
| --- | --- | --- |
| 單元（修正前） | `npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/rebind.test.ts tests/audio-lock/state.test.ts` | 只套用測試、還沒改 src 時：`late_bind_keeps_snapshot_selected_youtube_audible`、`same_content_remount_keeps_active` 和任務 1 的新測試 FAIL |
| 單元（修正後） | `npx --yes yarn@1.22.22 test:audio-lock` | 6 files、128 passed、0 failed／skipped；既有 117 個不變 |
| 型別 | `npx --yes yarn@1.22.22 typecheck:audio-lock` | exit 0 |
| lint | 任務 3 Step 6 的兩條指令 | 0 errors／0 warnings |
| 建置 | `npx --yes yarn@1.22.22 build`、`npx --yes yarn@1.22.22 test:artifacts` | exit 0；10 pass |
| e2e ×3 | 見下方 | 3 次 compare 都 exit 0 |
| 對照 | MVP、none 各 1 次 | MVP 只能因 `flags.v3/newHandle` 失敗；none 顯示 Twitch 搶聲 |

e2e 指令（每次 `run.mjs` 本身 240 秒逾時；外層用既有 `.cache/run-with-timeout.py` 或等效方式限 280 秒）：

```bash
export npm_config_cache=$PWD/.cache/npm YARN_CACHE_FOLDER=$PWD/.cache/yarn TMPDIR=$PWD/.cache/tmp
mkdir -p "$TMPDIR" .cache/e2e-browser
for n in 1 2 3; do
  node tests/e2e-browser/audio-lock/run.mjs fix-$n dist_chrome .cache/e2e-browser/fix-$n.json || exit 1
  node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix-$n.json \
    docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json || exit 1
done
node tests/e2e-browser/audio-lock/run.mjs mvp /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/mvp.json
node tests/e2e-browser/audio-lock/run.mjs none none .cache/e2e-browser/none.json
node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix-1.json .cache/e2e-browser/fix-2.json \
  .cache/e2e-browser/fix-3.json .cache/e2e-browser/mvp.json .cache/e2e-browser/none.json
```

最後一條 compare 的 exit code 只看第一欄（fix-1）。fix-2、fix-3 用前面迴圈的個別 compare 判定。

## 驗收條件

Codex 驗收時，以下每一項都要**自己實跑**確認，不採信實作報告的數字。任何一項不符即 FAIL。

1. **根因修正存在且範圍最小**：`git diff 7e718a7..HEAD -- src` 只動 `contracts.ts`、`state.ts`、`controller.ts`；`syncBindings` 的同內容分支不再送 `CELL_REMOVED`；有 `reboundActive()`，並在 `syncBindings` 結尾和 `processLayout` 都有呼叫。bootstrap fallback、`PLAYER_READY` 正規化規則、silence 政策、`TIMING` 常數沒有改動。
2. **單元測試**：把本輪 src 改動 revert 掉（只保留新測試），`rebind.test.ts` 的 `late_bind_keeps_snapshot_selected_youtube_audible` 和 `same_content_remount_keeps_active` 會 FAIL；套回後全套 **128 passed**，既有 117 個測試名稱與數量不變，沒有 skip 或 only。
3. **typecheck、build、artifacts** 都通過；`package.json`、`yarn.lock`、`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**` 沒有改動；`fakes.js` 和證據逐位元相同。
4. **lint**：任務 3 Step 6 的範圍是 0 errors、0 warnings；範圍外的 `fakes.js`（5）與 `vite.config.base.ts`（2）照實記錄，不算本輪缺陷。
5. **e2e，fix build 連續 3 次通過**，情境與 MVP 相同：YouTube 先播，Twitch 晚 3 秒播；Twitch 自己取消靜音 1 次；靜音延遲 2.5 秒，每 4 秒自己取消靜音，共 6 次。每一次都要符合：
   - `preReloadYtStoreMuted = 0`（reload 前、沒有播放時，YT 格 store 從未被設成 true），`preReloadSamples ≥ 10`；
   - `prePlayYtStoreMuted = 0`，`prePlaySamples ≥ 30`；`checks.initial.storeA` 不是 true；
   - `afterBothPlay`、`afterSelfUnmute1`、`afterLaggedRepeats` 的 audible 都是 `YT`（YouTube 一直有聲，Twitch 被壓回靜音）；
   - `ytMutedSamples = 0`，`samples ≥ 150`（預期 168）；`everStolenDuringLag = 0`；
   - `afterUserUnmuteTwitch.audible = TW`（使用者真的點進 Twitch 並取消靜音時要切換）；
   - `flags.v3`、`flags.newHandle` 都是 true；errors 為空；沒有 SyntaxError；`[Holodex+ AudioLock]` 警告數 0。
6. **和 MVP 並列**：同一時段跑的 MVP（`/Applications/Extensions/holodex-plus-audiolock-chrome`，唯讀載入）和 none 各一次，加上 3 次 fix，用 `compare.mjs` 產出並列表。fix 三欄的行為列（Twitch 晚播後、自己取消靜音後、延遲＋重複後、被搶次數、YT 靜音取樣、使用者點 Twitch 後）要和 MVP 一致（YT／YT／YT／0／0/168／TW）。MVP 只能因 `flags.v3/newHandle` 判 FAIL；none 要顯示 Twitch 搶聲。
7. **額度與邊界**：e2e 次數、build 次數、工作時間都在「回合與額度上限」內；Chrome profile 只在 `.cache/e2e-browser/`，結束後沒有 `prof-*` 殘留；沒有 push、PR、merge、notarize、sudo；沒有寫入 worktree 以外的位置。
8. **報告**：`docs/plans/reports/twitch-audio-lock-impl-5.md` 和 `docs/plans/reports/e2e-fix4/*.json` 已提交，JSON 的 SHA-256 和報告一致。

Firefox 真機載入和 Fi 在 M1 Vivaldi 的實測仍是交付後的人工項目，本輪不宣稱完成。

---

## 待 Fi 決定

| # | 問題 | 採用的假設 | 選錯的影響 |
| --- | --- | --- | --- |
| 1 | 同內容的 VideoCell 或 player 重建時，要承接 active，還是進 silence？ | 承接（照主計畫第 209 行）。目前程式進 silence 是實作偏離規格，不是 Fi 的決定。 | 如果 Fi 其實要 silence，M2 不修，改成只修 M1；但 Holodex 重建 cell 時仍會把有聲格靜音並存進 localStorage。 |
| 2 | `fakes.js` 的 5 個 lint 錯誤要不要修？ | 不修。它是證據的逐位元複製、會被注入頁面的 fixture，排除在 lint 範圍外並照實記錄。 | 若要修，只能加 `/* eslint-disable */` 或改寫，失去和證據逐位元相同的保證；只會增加一個小 commit。 |
| 3 | `vite.config.base.ts` 原本就有的 2 個 unused import 要不要順手修？ | 不修。`dev` 分支本來就有，而且 fix-3 規定不再碰建置設定。 | 若要修，是對上游檔案的一個獨立 `style` commit，風險很低。 |
| 4 | 連續 3 次 e2e 中途失敗 1 次怎麼算？ | 嚴格計算：從頭重算「連續 3 次」，不以多數決通過；受單輪 e2e 額度限制。 | 太嚴可能因為 holodex.net 網路波動用完額度而判 FAIL；太鬆則可能放過時序問題。 |
| 5 | `providerFromContent` 把真實 Holodex 的物件型 `video` 猜成 youtube，要不要這輪修？ | 不修（只動 3 個檔的最小改動）。late-bind 比對改成不看 provider，就能避開它對 active 的影響。 | 如果之後別的路徑依賴 snapshot 的 provider（例如未註冊的 Twitch 新格），可能還有小偏差，需要另開修正。 |
| 6 | e2e 的 reload 前等待從 1500ms 改成 3000ms 取樣，可以嗎？ | 可以。fix、MVP、none 用同一份 harness，比較仍然公平；timeline 的 168 個取樣不變。 | 若 Fi 要求和舊證據的時間軸完全一致，需要改回 1500ms，但這樣可能來不及涵蓋 READY。 |

主計畫決定紀錄 1–8（含 2500ms 意圖窗、只 warn 一次、降級政策）**全部維持，不需要改動**。
