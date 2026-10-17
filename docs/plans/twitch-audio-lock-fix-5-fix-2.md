# Twitch audio lock fix-5 第 3 輪修正計畫（fix-5-fix-2）：iframe 之間直接換焦點沒有意圖、fallback 從未對 Twitch 送靜音，以及 live harness 量測修正

> 執行者是 Cursor，驗收者是 Codex。逐任務實作，步驟用 checkbox（`- [ ]`）追蹤。實作偏離本計畫時，寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-8.md` 的「偏離」段落。不要回頭改本計畫、`docs/plans/twitch-audio-lock-fix-5.md`、`docs/plans/twitch-audio-lock-fix-5-fix-1.md`、主計畫或既有報告／審查。

**Goal：** 焦點已在 Twitch iframe 時直接點 YouTube iframe 取消靜音（頂層沒有新的 window `blur`），也要在 2000ms 內切回 YouTube、Twitch 靜音；查明 fallback 模式為什麼從未對 Twitch 送 SetMuted，能定位就在本輪修；live harness 補上 review-7 的兩個量測缺陷與 Twitch 空白 iframe 的重載。門檻照 fix-5 驗收條件 5、6、7。

**Architecture：** 產品主修在 `controller.ts`：新增「焦點所在 iframe 追蹤」——在兩個做選聲決定的入口（`reconcileCell` 讀播放器之前、`setMuted` wrapper 送 `OBSERVED_MUTED` 之前）同步讀 `document.activeElement`；它是另一個已綁定格的 iframe（和上次記錄的格不同）時，送一次 `IFRAME_INTENT`（`source:"iframe"`）。`onBlur` 也更新同一個「上次記錄的格」，所以同一格不會重複刷新；hidden、disabled、degraded 不記錄；teardown 與焦點回到非 iframe 時清掉。fallback 先用唯讀診斷定位，再走本計畫預先寫好的分支修法（Y1–Y4），每個分支都有對應單元測試；定位不到就照實停在該項。

**Tech Stack：** 既有 TypeScript、Vitest＋jsdom（`vitest.audio-lock.config.ts`）、既有 `tests/e2e-browser/audio-lock/live.mjs`（Node 內建模組＋CDP pipe）、`live-compare.mjs`。不新增 dependency。

**依據：** `docs/plans/twitch-audio-lock-fix-5.md`（以下稱「原計畫」）驗收條件 5、6、7；`docs/plans/twitch-audio-lock-fix-5-fix-1.md`（上一輪計畫）；`docs/plans/reviews/twitch-audio-lock-impl-review-7.md`（第 2 輪驗收 FAIL：1 high、2 medium，fallback 未達門檻）與其真直播 JSON `docs/plans/reviews/e2e-fix5-review-2/*.json`。

日期：2026-10-18。分支 `gixiphy/twitch-audio-lock`，規劃基準 HEAD `29aed7a`；本計畫的 docs commit 是這一輪的基準。fix-5 已失敗 2／3，**本輪是最後一輪**：本輪 Codex 驗收若仍 FAIL，流程停下來由協調者回報 Fi，不再自動開第 4 輪。

## 根因（規劃時唯讀確認）

### 1. high：iframe→iframe 換焦點沒有頂層 blur

review-7 `normal-2.scenarios.c[1]`：harness 保留 Twitch iframe 焦點後，以受信任點擊點 YouTube iframe 的靜音鈕。焦點從 Twitch iframe 移到 YouTube iframe，頂層 window 沒有新的 `blur`（頂層早已失焦）。輸入後 53ms YouTube 有聲，472ms 被壓回；Twitch 全程有聲，store `a:true,b:false`，`muteDelta:0`。

`src/pages/content/holodex/audio-lock/controller.ts @ 29aed7a`：

| 行 | 內容 |
| --- | --- |
| `:561–627` | `reconcileCell`：`:570` `entry.port.readMuted()`，`:617` `pollObservation(...)` → `OBSERVED_MUTED origin:"poll"`。Holodex `MediaControls.vue` 每 1 秒對每格呼叫 `manualCheckMuted()`（`.ref/holodex-twitch-audio.md` 第 6 行），被 `installBinding` 的 wrapper（`:657`）導到這裡 |
| `:665–698` | `setMuted` wrapper：非面板時 `:686` 送 `OBSERVED_MUTED origin:"refresh"`。YouTube 取消靜音的邊緣可能從這裡進來（Holodex 讀到 YouTube 變化後呼叫 `cell.setMuted(false)`），不一定經過輪詢 |
| `:1204–1224` | `onBlur`：`schedule(...,0)` 後讀 `doc.activeElement`，是某格 iframe 就送 `IFRAME_INTENT`。**只在頂層 window `blur` 時觸發** |
| `:1226–1234` | `onFocusIn`：焦點到非 iframe 元素時清掉 `source:"iframe"` 的 intent |
| `:1255–1271` | listener 註冊與 disposer |
| `:964–1000` | `teardownSession` |

`state.ts:585–596` `IFRAME_INTENT` 設 `expiresAt = now + TIMING.USER_INTENT_MS`（`contracts.ts:215`，2500）。`state.ts:690–703`：`muted:false` 邊緣要 `tokenValid`（`state.ts:161–166`：未消耗、未過期、同一格）且 `prev === true` 才選中；否則 `desiredMute` 為 `muted` → `MUTE_PLAYER`，就是 472ms 的壓回。

HTML 規範：焦點在子 browsing context 時，外層 document 的 `activeElement` 是那個 iframe 元素；焦點換到另一個 iframe 時 `activeElement` 跟著換，但頂層 window 不再收到 `blur`。review-7 的 `focusEvents`（`a924c11` 每 50ms 記 `active-change`）在 c2 也顯示 activeElement 從 Twitch iframe 變成 YouTube iframe。

**選用的接法（方案 A）：在決策入口同步檢查，不另開計時器。** 所有可能把 YouTube／Twitch 取消靜音邊緣送進狀態機的路徑只有兩條（`:617`、`:686`；`grep -n "OBSERVED_MUTED\|pollObservation(" controller.ts` 規劃時確認只這兩處）。在這兩處的 transition 之前呼叫 `noteFocusedIframe(now)`，可保證「邊緣被處理時，intent 已依當下焦點建立」，不受 Holodex 1 秒輪詢與 `setMuted` 呼叫順序影響；也不需要新的計時器與 teardown 計時器清理。

| 方案 | 內容 | 評估 |
| --- | --- | --- |
| **A（採用）** | 決策入口同步讀 `activeElement`；換到另一格的 iframe 才送 intent；`onBlur` 共用同一個 `lastFocusKey` | 不增計時器；intent 一定早於邊緣；同一格不刷新 |
| B | session 期間另開 250ms 計時器輪詢 `activeElement` | 邊緣若在兩次 tick 之間進來（`setMuted` 路徑），intent 可能晚到；多一個要清理的計時器。只作為 A 在真直播仍失敗時的偏離選項，需寫入報告 |
| C | 意圖窗改長或「焦點在 iframe 內就永遠有效」 | 違反 2500ms、同一格不持續刷新；不採用 |

### 2. medium：c2 零取樣誤判（harness）

review-7 發現 2 指 `live.mjs @d680a7d :424–430` 與 `:643–646`。驗收 harness `a924c11` 已改：`live.mjs @29aed7a :657–672`，c 每輪在輸入**前**啟動 50ms collector，c2 用 `toggle.clickAt` 為 `t`，等到 `t+2000` 才停止並以 `s.t>=t && s.t-t<=2000` 判斷。規劃判斷**看起來已涵蓋**，但要 Cursor 用離線反例實證（任務 4 Step 1）。

### 3. medium：H3 允許清單過寬（harness）

`live.mjs @29aed7a :70–73` 仍是 `['this.player.getCurrentTime is not a function','fetchVideoData']`，`:703` 對 message 做 substring；`fetchVideoData` 只要出現在 stack 字串就豁免任何訊息。「同輪 MVP 也出現」只寫在註解（`:704`），沒有程式檢查。**未涵蓋，本輪要修。**

### 4. fallback 從未對 Twitch 送靜音（尚未定位）

review-7 `fallback.json`：`updateStateMessages:209`、`twitchCommandsReceived {mute:0,unmute:0}`；情境 a Twitch 有聲 173 筆；store `a` 全程 `false`、YouTube 全程有聲；唯一 AudioLock 警告被記成 `[Holodex+ AudioLock] Object`（`live.mjs:167–171` 只取 `a.value ?? a.description`，物件參數的 `code` 遺失），與 `[Holodex+] Activated` 同毫秒，最可能是 `twitch-guard-unavailable`（fallback 模式 `live.mjs:230–234` 把 `window.Twitch` 定義成不可設定，`twitch-embed.ts:94–136` 的 `defineProperty` 會丟錯並警告），但目前無法證明。

fallback 模式下 guard 沒裝上 → Twitch 建構時沒有 `muted:true` 也沒有 `__v_skip` → Vue 觀察 SDK（`twitchObserved:true`、`vIsRefErrors:1201`）→ Twitch 以有聲開播。正確行為應是：Twitch port 走 iframe 管道（`players.ts:236–240` `useIframeChannel`），`readViaIframe`（`:246–252`）讀到 `muted:false` → `OBSERVED_MUTED` → `desiredMute` 為 `muted` → `MUTE_PLAYER` → `postTwitchSetMuted`（`players.ts:312–313`、`twitch-embed.ts:176–198`）。指令 0 表示這條鏈在某處斷了。

讀程式碼後最可能的斷點（依可能性排序），以及唯讀可辨識的訊號：

| # | 假設 X | 可辨識訊號（任務 3 診斷要記的欄位） |
| --- | --- | --- |
| X1 | Twitch port 一直沒綁定：Vue 觀察 SDK 時 `TwitchPlayer` 的 `ready` 沒有 `$emit` 或 `cell.twPlayer !== playerComponent.player`，`tryBind`（`players.ts:206–234`）回 false → `readMuted` 回 `not-ready`（`reconcileCell :575` 靜默 return）、`mute()` 回 false | `ports.get('b').isBound() === false`；`state.cells.b` 不存在或 `lastObservedMuted` 未定義；`cell.twPlayer === $refs.player.player` 為 false 或 `$refs.player.player` 不是物件 |
| X2 | 綁定了，但 `twitchIframe(binding)`（`players.ts:126–137`，在 `playerComponent.$el` 裡找第一個 `iframe`）找不到或找到別的 iframe → `readTwitchIframeState` 回 null → `UNTRUSTED_POLL`；`postTwitchSetMuted` 送到錯的 window 或回 false | `isBound()===true`；`playerComponent.$el.querySelector('iframe')` 是 null 或 `src` 不是 `player.twitch.tv`，或不是 harness 觀察的那個 iframe；`lastMuteAt` 有更新但 iframe 指令 0 |
| X3 | Twitch 格沒進 `lastBindings`（`holodex-adapter.ts:305–340` `isVideoCell` 某條件不成立，例如 `$refs.player` 缺）或 `manualCheckMuted` wrapper 沒被呼叫 → 從沒 reconcile | `lastBindings` 沒有 `b`；或有 `b` 但 `cells.b.lastObservedMuted` 一直未定義而 `isBound()===true` |
| X4 | 狀態機在 `bootstrap`／沒有 `active`（例如校準時 `setMuteOthers(false→true)` 後 `STORE_SNAPSHOT`（`state.ts:469–501`）沒有重新選中 YouTube）→ `desiredMute` 回 `unassigned`（`state.ts:63–66`）→ 不靜音。normal 模式 Twitch 以 `muted:true` 建構，所以 a 看不出來 | `state.selection==='bootstrap'` 或 `state.active` 為 null／不是 a；`cells.b.lastObservedMuted===false` |
| X5 | 其他（`muteInFlight` 卡住、`settleUntil`、epoch 不符、session degraded 等） | `mode`、`muteInFlight`、`settleUntil`、`lastMuteEpoch`、`epoch`、警告 code |

診斷手段：產品的 `window.__HDX_AUDIO_LOCK_HANDLE__`（`twitch-audio-lock.ts:66–79`）只是外層 wrapper，但它的 `setEnabled` 閉包裡有 `controller`，而 `controller` 上有測試用唯讀掛鉤 `__getState`、`__ports`、`__lastBindings`（`controller.ts:1320–1337`，production build 也存在）。harness 可經 CDP `Runtime.getProperties` 讀 `setEnabled` 的 `[[Scopes]]` 取得 `controller` 的 objectId，再 `Runtime.callFunctionOn` 讀狀態。這是唯讀觀察，不改產品行為（任務 3）。

### 5. normal-1／3 的 Twitch 空白 iframe

review-7：iframe URL 正確、document `interactive`、`body` 空字串、`<video>` 0。`live.mjs:483–486` 在校準前 `waitPlaying('twitch')` 失敗就 SKIP。本輪允許整頁重載最多 1 次再判 SKIP（任務 4 H14），picks 不變，仍計 1 次 e2e 額度。

## Global Constraints

- 禁止 push、開 PR、merge（不合併任何分支、不碰 remote），也不提議；禁止公證（notarize）、sudo；不建立或切換分支；不另開 worktree。
- 所有寫入限於本 worktree；commit 寫入主 repo 的 Git metadata 屬允許範圍。禁止刪除 worktree 以外的任何東西。Chrome 暫存 profile 一律放 `.cache/e2e-browser/`，結束時刪除（正常、FAIL、例外、逾時都刪）。**不碰 Fi 的 Vivaldi 或 Chrome profile。**
- 真直播瀏覽器測試**只在 M5** 跑，暫存 profile（Fi 已核准）。不在 M1 跑；不碰 Microlife／Chorus 專案、Orca 的安裝。
- 快取：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；yarn 一律 `npx --yes yarn@1.22.22`，需要安裝時用 `--frozen-lockfile`。
- **不新增 dependency**；`package.json`、`yarn.lock` 不改。
- commit 訊息只用英文，Conventional Commits。
- 產品程式碼**只**允許改：
  - `src/pages/content/holodex/audio-lock/controller.ts`：新增 `lastFocusKey` 與 `noteFocusedIframe`；在 `reconcileCell`（`:561–627`）讀播放器前、`setMuted` wrapper（`:675–698`）送 `OBSERVED_MUTED` 前各呼叫一次；`onBlur`（`:1204–1224`）、`onFocusIn`（`:1226–1234`）、`teardownSession`（`:964–1000`）只加 `lastFocusKey` 的更新／清除。分支 Y3 另允許新增「Twitch `UPDATE_STATE` 到達時 reconcile 該格」的訂閱與其 disposer。
  - `src/pages/content/holodex/audio-lock/players.ts`：只在分支 Y1／Y2 被診斷選中時改 `tryBind`（`:206–234`）或 `twitchIframe`（`:126–137`）。
  - `src/pages/content/holodex/audio-lock/twitch-embed.ts`：只在分支 Y3 被選中時新增 `UPDATE_STATE` 訂閱 API（不改既有驗證條件、不改 SetMuted 格式）。
  - `src/pages/content/holodex/audio-lock/state.ts`：只在分支 Y4 被選中時改 `STORE_SNAPSHOT` 重新選中的那段（`:469–501`／`applySnapshotSelection`）。
  - 其他 src 一律不動（含 `contracts.ts`／`TIMING`、`holodex-adapter.ts`、`twitch-audio-lock.ts`、`holodex-inject.ts`、`custom-vite-plugins.ts`、`vite.config.*.ts`）。`onPointerDown`、listener 註冊清單、`IFRAME_INTENT` 的 2500ms 不動；不新增 window `focus` listener；不新增計時器（方案 B 只能作為寫入「偏離」的備案）。
- 測試只允許改：`tests/audio-lock/twitch-broken.test.ts`（新增測試）、`tests/audio-lock/fixtures.ts`（只新增 helper，不改既有 helper 行為）、`tests/e2e-browser/audio-lock/live.mjs`、`tests/e2e-browser/audio-lock/live-compare.mjs`、`tests/e2e-browser/README.md`（只改「Live players」一節）。`tests/build-artifacts/**`、`run.mjs`、`compare.mjs` 不動；`fakes.js` 和 `docs/plans/evidence/twitch-audio-lock-fix-3/harness/fakes.js` 逐位元相同。
- 既有測試名稱、斷言一律不改、不刪、不 skip／only。
- `docs/plans/evidence/**`、`docs/plans/reviews/**`、`.ref/` 唯讀。
- MVP 擴充 `/Applications/Extensions/holodex-plus-audiolock-chrome` 只能透過 CDP `Extensions.loadUnpacked` 唯讀載入；跑前跑後 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort` 比對完全相同（review-7 記錄為 28 檔）。
- 不要改成方案 D（帶 `muted=true` 重新載入 iframe）；不要為了讓 fallback 通過而改 harness 的 fallback 觸發方式或判準。
- harness 的診斷只能讀，不能呼叫會改狀態的產品函式（不呼叫 `__setState`、`__applyEffects`、`__reconcile`、`__installBindings`、`__tryDiscover`、`setEnabled`、port 的 `mute`／`unmute`）。

## 回合與額度上限

- fix-5 系列已失敗 2／3，**本輪是第 3 輪，也是最後一輪**。本輪 Codex 驗收若 FAIL，協調者停止流程並回報 Fi，不再自動開新一輪。
- **Cursor 本輪**：工作時間上限 **90 分鐘**；e2e 合計最多 **12 次**（假播放器 `run.mjs`、真直播 `live.mjs` 都算，含 fallback 診斷、MVP、SKIP、例外中止；H14 的頁內重載不另計）；`yarn build` 最多 4 次。必跑：fallback 診斷 1、假播放器 3、真直播 normal 3、fallback 1、MVP 1，共 9 次，剩 3 次給重試／harness 除錯。
- **Codex 本輪**：驗收上限 **60 分鐘**；e2e 合計最多 **8 次**（假 3＋normal 3＋fallback 1＋MVP 1，不留重試；任一次未達門檻即 FAIL）。
- 每次真直播 e2e 內層 300 秒全域逾時（H14 重載後仍是同一個 300 秒）；外層 `perl -e 'alarm 320; exec @ARGV' --`。
- 超過上限就停在目前狀態寫報告，不硬做。

## Review Focus

1. **iframe→iframe 反向切換**：焦點已在 Twitch iframe、沒有頂層 `blur`，直接在 YouTube iframe 取消靜音 → 2000ms 內 YouTube 有聲、Twitch 靜音；healthy SDK 與 postMessage（SDK 被 Vue 觀察）兩條路徑 → 任務 1 前兩個測試。
2. **意圖不被放寬**：焦點停在同一格不會一直刷新 intent；2500ms 到期照舊；hidden／disabled 不記錄；teardown 後重建不殘留 → 任務 1 後三個測試。
3. **fallback 診斷誠實**：結論要有診斷 JSON 欄位支撐；分支修法要有修正前 FAIL 的單元測試；定位不到就照實寫並停在該項。
4. **harness 量測**：c2 不會零取樣；H3 只豁免 fetchVideoData 的 null-property 與 getCurrentTime 兩種訊息，且要同輪 MVP 也出現；AudioLock 警告要保留 code。

---

## 檔案

| 檔案 | 動作 | 用途 |
| --- | --- | --- |
| `src/pages/content/holodex/audio-lock/controller.ts` | 修改 | `lastFocusKey`、`noteFocusedIframe`；兩個決策入口呼叫；`onBlur`／`onFocusIn`／`teardownSession` 同步 `lastFocusKey`；（分支 Y3）`UPDATE_STATE` 觸發 reconcile |
| `src/pages/content/holodex/audio-lock/players.ts` | 條件修改（Y1／Y2） | Twitch 無 ready 訊號時以 iframe 狀態綁定；iframe 查找範圍 |
| `src/pages/content/holodex/audio-lock/twitch-embed.ts` | 條件修改（Y3） | `UPDATE_STATE` 訂閱 API |
| `src/pages/content/holodex/audio-lock/state.ts` | 條件修改（Y4） | `muteOthers` 重新開啟後重新選中 |
| `tests/audio-lock/fixtures.ts` | 修改（只新增 helper） | `moveFocusToIframeWithoutBlur(iframe)` |
| `tests/audio-lock/twitch-broken.test.ts` | 修改（新增 5 個固定測試＋分支測試） | 見任務 1、任務 3 Step 4 |
| `tests/e2e-browser/audio-lock/live.mjs` | 修改 | H9–H15 |
| `tests/e2e-browser/audio-lock/live-compare.mjs` | 修改 | H3 的 MVP 同訊息核對、新欄位顯示 |
| `tests/e2e-browser/README.md` | 修改（「Live players」一節） | 記錄 H9–H15 |
| `docs/plans/reports/twitch-audio-lock-impl-8.md` | 新增 | 實作報告（含 fallback 診斷結論） |
| `docs/plans/reports/e2e-fix5-fix2/*.json` | 新增 | 本輪所有 e2e 原始 JSON（含診斷、FAIL／SKIP／例外） |

---

## 步驟

### 任務 0：開工檢查

- [ ] **Step 1**：`git log --oneline -1` 應是本計畫的 docs commit；`git status` 乾淨。
- [ ] **Step 2**：記下開始時間；建立額度表（e2e 0／12、build 0／4）。
- [ ] **Step 3**：MVP 資料夾 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort > .cache/e2e-browser/mvp-before.sha`，記錄檔數。
- [ ] **Step 4**：`npx --yes yarn@1.22.22 test:audio-lock` 記錄基準數（review-7 為 8 files／167 passed）。

### 任務 1：iframe 焦點意圖的單元測試（先寫，修正前要 FAIL）

**Interfaces（新增於 `fixtures.ts`）：**

```ts
// 模擬「焦點已在某個跨網域 iframe，使用者直接點另一個 iframe」：
// 只改 document.activeElement，不派送 window blur／focus／focusin。
export function moveFocusToIframeWithoutBlur(iframe: HTMLIFrameElement): void;
```

- [ ] **Step 1：helper**：沿用 `focusIframeAndBlurWindow` 的作法（`vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe)`），但**不派送任何事件**。註解寫明用途。
- [ ] **Step 2：新增測試**（放在 `describe("twitch broken SDK / no-degrade")` 內，沿用 `setupBrokenEnv`、`makeHandle`、`postTwitchUpdateState`、`pollSeconds`、`flushMicrotasks`；每個測試都掛 window `blur`／`focusin` 計數 listener，斷言本測試的「iframe→iframe」步驟後兩者都沒有增加）。共同前置：Twitch b 已是 active（照 `reverse_switch_youtube_iframe_intent_mutes_twitch`（`twitch-broken.test.ts:489–526`）的作法 `__setState` 成 `selected`、`active=b`、`epoch:1`），YouTube a 已觀察到 `muted:true`（先 `manualCheckMuted` 一次），且已用 `focusIframeAndBlurWindow(Twitch iframe)` 讓焦點在 Twitch，接著 `advanceTimersByTimeAsync(3000)` 讓這個 Twitch intent 過期。

  | 測試名稱 | 設定與步驟 | 斷言 | 修正前預期 |
  | --- | --- | --- | --- |
  | `iframe_to_iframe_focus_without_blur_switches_to_youtube_healthy` | `setupBrokenEnv({ healthyTwitch: true, twitchBroken: false, twitchMuted: false })`。`moveFocusToIframeWithoutBlur(a 的 iframe)`；YouTube `rawMuted=false`；`pollSeconds(env, handle, 2)` | `active.key === "a"`；Twitch SDK `rawMuted === true`（或 `muteCalls` 增加）；store `a.muted === false`、`b.muted === true`；YouTube 沒有被送 mute（`youtubeRawFor` 的 mute 呼叫數不變）；blur／focusin 計數未增加 | FAIL（active 仍是 b，YouTube 被壓回） |
  | `iframe_to_iframe_focus_without_blur_switches_to_youtube_broken_twitch` | `setupBrokenEnv()`（SDK 被 Vue 觀察，走 iframe 管道）；Twitch 狀態以 `postTwitchUpdateState(b 的 iframe,{muted:false})` 建立。其餘同上 | `active.key === "a"`；`postSpies.get("b")` 至少一次 `params === true`；store 同上；計數未增加 | FAIL |
  | `focused_iframe_intent_not_refreshed_while_focus_stays` | healthy。`moveFocusToIframeWithoutBlur(a 的 iframe)` 後先 `pollSeconds(env, handle, 3)`（YouTube 仍靜音，intent 在第一次決策入口建立後過期）；再把 YouTube `rawMuted=false`，`pollSeconds(env, handle, 2)` | active 仍是 b；YouTube 被送靜音（mute 呼叫數增加）；store `a` 不變成 `false` | PASS（修正前沒有焦點追蹤；修正後要維持 PASS，證明同一格不刷新） |
  | `focused_iframe_ignored_when_hidden_or_disabled` | healthy。兩段：(1) `vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")` 後 `moveFocusToIframeWithoutBlur(a)`、YouTube 取消靜音、poll 2 秒；(2) 還原 visible、`handle.setEnabled(false)` 再 `setEnabled(true)` 前後各做一次同樣操作（disabled 期間的那次不得建立 intent） | (1) active 仍是 b、`__getState().intent` 不是 a 的 iframe intent；(2) disabled 期間 `intent` 為 null | PASS（守住邊界，兩邊都 PASS） |
  | `focused_iframe_tracking_resets_after_teardown` | healthy。焦點在 a 的 iframe（`moveFocusToIframeWithoutBlur`）、poll 一次後，觸發 teardown（`window.dispatchEvent(new Event("pagehide"))`），再 `pageshow`（`persisted:true`）重建 session，重新 `__setState` 成 active=b；不移動焦點，YouTube 取消靜音、poll 2 秒 | active 變成 a（teardown 已清掉 `lastFocusKey`，重建後第一次看到 a 的 iframe 算一次換焦點） | FAIL（修正前沒有焦點追蹤）；若 `pageshow` 在 jsdom 不能重建 session，改用 `handle.setEnabled(false)`／`true` 觸發 `teardownSession`，在報告寫明 |

- [ ] **Step 3：修正前跑**：`npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`。Expected：表中標 FAIL 的 3 個測試 FAIL，原因是 `active` 不是 a／YouTube 被送靜音，**不是** import 或 helper 錯誤；標 PASS 的 2 個 PASS。輸出摘要寫進報告。
- [ ] **Step 4**：不 commit，進任務 2。

### 任務 2：iframe 焦點意圖的產品修正（`controller.ts`）

- [ ] **Step 1：新增追蹤狀態與 helper**（放在 `reconcileCell` 定義之前，約 `:560`，避免 TDZ）：

  ```ts
  // Cross-origin iframe -> iframe focus moves fire no top-level blur, so the
  // decision points read activeElement and record intent on a change of cell.
  let lastFocusKey: string | null = null;

  const noteFocusedIframe = (t: number) => {
    if (!enabled || disposed) return;
    if (state.mode === "degraded" || state.mode === "disabled") return;
    if (doc.visibilityState === "hidden") return;
    const active = doc.activeElement;
    if (!active || active.tagName !== "IFRAME") {
      lastFocusKey = null;
      return;
    }
    for (const [key, binding] of lastBindings) {
      const el = (binding.cell as { $el?: Element }).$el;
      if (el && el.contains(active)) {
        if (key === lastFocusKey) return;
        lastFocusKey = key;
        const result = transition(state, {
          type: "IFRAME_INTENT",
          now: t,
          identity: binding.identity,
          source: "iframe",
        });
        state = result.state;
        return;
      }
    }
  };
  ```

  實作可微調寫法以符合周邊風格，但語意必須是：只有「換到另一個已綁定格的 iframe」才送；同一格不刷新；非 iframe 時重設；hidden／disabled／degraded 不記錄也不改 `lastFocusKey`。
- [ ] **Step 2：決策入口**：
  - `reconcileCell`：在 `:570` `await entry.port.readMuted()` **之前**呼叫 `noteFocusedIframe(t)`（`t` 是 `:566` 已有的 `now()`）。
  - `setMuted` wrapper：只在 `value === false`、要送 `OBSERVED_MUTED`（`:686`）之前呼叫 `noteFocusedIframe(now())`；面板分支（`hasPanelDispatch()`）不呼叫。
- [ ] **Step 3：`onBlur`**：找到格後送 intent 的同時設 `lastFocusKey = key`（`for` 改成取 key）；其餘邏輯不變。**仍然每次 blur 都送**（保留 fix-1 的修正；blur 本身就是一次新的使用者動作）。
- [ ] **Step 4：`onFocusIn`**：activeElement 不是 IFRAME 時，除了既有清 intent，也設 `lastFocusKey = null`。
- [ ] **Step 5：`teardownSession`**：兩個分支都加 `lastFocusKey = null`。
- [ ] **Step 6：跑測試**：`npx --yes yarn@1.22.22 test:audio-lock`。Expected：8 files 全部 passed、0 failed／skipped；總數＝基準＋5（預期 172；分支測試另計）。
- [ ] **Step 7**：`npx --yes yarn@1.22.22 typecheck:audio-lock` exit 0。
- [ ] **Step 8：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/fixtures.ts tests/audio-lock/twitch-broken.test.ts
  git commit -m "fix(audio-lock): record intent when focus moves between player iframes"
  ```

### 任務 3：fallback 診斷與分支修正

- [ ] **Step 1：harness 唯讀診斷（`live.mjs`，H12）**
  - 新增 `readLockDiagnostics()`：
    1. `Runtime.evaluate('window.__HDX_AUDIO_LOCK_HANDLE__?.setEnabled')`（不加 `returnByValue`）取得 objectId。
    2. `Runtime.getProperties({objectId, ownProperties:false})`，從 `internalProperties` 的 `[[Scopes]]` 逐一 `getProperties`，找出值是物件、且有 `__getState` 函式的那個（變數名可能被壓縮，**用形狀找，不用名字**）。
    3. `Runtime.callFunctionOn({objectId: controllerId, functionDeclaration, returnByValue:true})`，函式內只讀：`__getState()` 的 `mode`、`selection`、`active?.key`、`muteOthers`、`epoch`、`intent`（identity key、source、expiresAt、consumed）、每格 `cells[k]` 的 `lastObservedMuted`、`lastMuteAt`、`lastMuteEpoch`、`muteInFlight`、`settleUntil`、`consecutiveFailures`、`unsettledMuteCount`；`__ports` 每格 `isBound()`；`__lastBindings` 每格 `provider`、`identity.key`、`cell.twPlayer === playerComponent.player`（try/catch）、`typeof playerComponent.player`、`playerComponent.$el.querySelector('iframe')?.src`、該 iframe 是否等於頁面上 `player.twitch.tv` 的 iframe。
    4. 任何一步失敗回 `{ ok:false, step, error }`，不丟例外、不中止情境。
  - 呼叫時機：fallback 與 normal 都記（normal 作對照）：情境 a 加入 Twitch 後每 1 秒一次共 10 次、a 結束、b 點擊前後各一次、c 每輪輸入前與 +2000ms。存到 `result.lockDiagnostics: [{t, phase, ...}]`。
  - `sampleOnce` 的 `store` 增加 `b`（Twitch 格的 `muted`）與 `bExists`。
  - 依 Global Constraints，**不呼叫**任何會改狀態的掛鉤。
- [ ] **Step 2：警告保留 code（H11）**：`Runtime.consoleAPICalled` 處理（`live.mjs:167–171`）對 `type==='object'` 的參數用 `a.preview?.properties` 組成 `{name:value}` 字串（例如 `[Holodex+ AudioLock] {code:twitch-guard-unavailable,adapterVersion:1}`）；沒有 preview 時保留 `a.description`。另存 `audioLockWarningCodes: string[]`。情境 e（`:719–722`）改用 code 判斷：fallback 只允許 `twitch-guard-unavailable`。
- [ ] **Step 3：跑 fallback 診斷 1 次**（任務 2 的 build 之後；計入 e2e 與 build 額度）：
  ```bash
  npx --yes yarn@1.22.22 build
  perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs live-fix-fallback-diag dist_chrome .cache/e2e-browser/live-fix-fallback-diag.json --mode=fallback
  ```
  依 `lockDiagnostics` 與 `audioLockWarningCodes` 對照「根因 4」的 X1–X5 表判定，結論（含引用的 JSON 欄位與值）寫進報告「fallback 診斷」段。若訊號仍不足，可在 harness 再加唯讀欄位重跑 1 次（用掉重試額度），仍不足就跳到 Step 5。
- [ ] **Step 4：依診斷選分支（只做被證據支持的那一個或幾個；每個都先寫修正前 FAIL 的單元測試，再改 src）**

  | 若診斷指向 | 則改（Y） | 對應單元測試（新增於 `twitch-broken.test.ts`；修正前 FAIL） |
  | --- | --- | --- |
  | X1：`isBound()===false`、`cells.b` 無觀察 | **Y1**：`players.ts` `tryBind`（`:206–234`）在 Twitch、無 `readySignal`、`lateBindReady` 為 false 時，若 `twitchIframe(binding)` 的 `readTwitchIframeState` 已有狀態（iframe 確實在送 `UPDATE_STATE`），改走 iframe 管道：`iframeChannel = true`、`boundInstance = player 物件或 null`、`fireOnReadyOnce()`。`useIframeChannel` 在 `boundInstance` 為 null 時仍以 `iframeChannel` 為準 | `fallback_twitch_binds_from_iframe_state_without_ready_signal`：`setupBrokenEnv()` 但不 `fireReady` Twitch、讓 `cell.twPlayer` 和 `playerComponent.player` 不相等；YouTube a active；`postTwitchUpdateState(b,{muted:false})`；poll 2 秒 → `postSpies.get("b")` 有 `params===true` |
  | X2：已綁定但 iframe 找不到／不是同一個 | **Y2**：`players.ts` `twitchIframe`（`:126–137`）改成先找 `playerComponent.$el` 內 `iframe[src^="https://player.twitch.tv/"]`，找不到再找 `binding.cell.$el` 內同 selector；不再取「第一個 iframe」 | `fallback_twitch_iframe_found_outside_player_component_el`：fixture 把 Twitch iframe 移到 cell `$el` 而不在 player component `$el`（或在前面插一個非 Twitch iframe）；poll → 有 `params===true` 的 postMessage |
  | X3：`lastBindings` 有 b 且已綁定，但從未 reconcile（`lastObservedMuted` 未定義） | **Y3**：`twitch-embed.ts` 新增 `onTwitchIframeState(cb: (source: object) => void): () => void`（在既有 listener 驗證通過、寫入 `iframeStates` 之後呼叫訂閱者，例外吞掉）；`controller.ts` 在 session 開始時訂閱，對 `source === twitchIframe.contentWindow` 的已綁定 Twitch 格呼叫 `reconcileCell(identity)`（已有 `inFlightReads` 去重），disposer 在 `teardownSession` 取消。若 `lastBindings` 根本沒有 b，屬 adapter 契約問題，**不在本輪修**，照實寫入報告並停在此項 | `twitch_update_state_reconciles_without_native_poll`：broken env；YouTube a active；不呼叫 b 的 `manualCheckMuted`；`postTwitchUpdateState(b,{muted:false})`、`advanceTimersByTimeAsync(1500)` → 有 `params===true` 的 postMessage |
  | X4：`selection==='bootstrap'` 或 `active` 不是 a，而 YouTube 正在有聲播放 | **Y4**：`state.ts` `STORE_SNAPSHOT`（`:469–501`）／`applySnapshotSelection`：`muteOthers` 由 false 變 true 時，依 store 中唯一 `muted:false` 的格重新選中（和 discovering 時的規則一致）。先寫重現診斷到的狀態序列的測試，最小修改 | `mute_others_reenabled_reselects_audible_cell_and_mutes_late_twitch`：YouTube a 有聲、`setMuteOthers(false)`→`true`、之後加入有聲 Twitch b → 2 秒內 Twitch 收到靜音（healthy 與 broken 各一個 `it`，或同一個測試兩段） |
  | X5 或無法對應 | 不改 src。報告寫明觀察到的所有欄位、排除了哪些 X、仍不知道什麼 | 無 |

  - 每個被選中的分支：修正前跑單一測試檔確認新測試 FAIL（原因是沒有送靜音，不是 helper 錯誤）→ 改 src → 全套 passed → typecheck → commit：
    ```bash
    git add <被改的 src 檔> tests/audio-lock/twitch-broken.test.ts tests/audio-lock/fixtures.ts
    git commit -m "fix(audio-lock): <依分支描述，例如 bind twitch iframe channel from update state>"
    ```
  - 不得同時套用沒有證據支持的分支「保險」。
- [ ] **Step 5：無法定位時**：不改 src、不調整 fallback 判準；照常跑任務 5 的 fallback 驗證 1 次並如實記錄 FAIL；報告「fallback 診斷」段明說「未定位」與缺的訊號。

### 任務 4：live harness 修正（`live.mjs`、`live-compare.mjs`）

- [ ] **Step 1：H9 核對 c2 同步取樣（review-7 發現 2）**：讀 `live.mjs:657–672` 與 `toggleMute`（`:404–445`）。用離線反例實證（可參考或重寫 `.cache/review7/harness-probes.mjs`；新探針放 `.cache/fix2/`，不提交）：把 c 迴圈的 collector＋判定抽出，餵一個「真相在 `clickAt+1950ms` 切換、`toggleMute` 本身耗時 2000ms」的假 `sampleOnce`／`toggleMute`，確認 `switchedInMs` 為約 1950 而不是 null。另確認 `samples` 只採計 `s.t >= t` 的筆數、`t` 取自 `toggle.clickAt`（輸入當下）而非 toggle 回傳時間。已涵蓋就在報告寫「確認方法／結果／未修改」；未涵蓋才補，並以同一個反例證明修正後通過。
- [ ] **Step 2：H10 收窄 H3 允許清單（review-7 發現 3）**：
  - `HOST_EXCEPTION_ALLOWLIST` 改成結構化規則：
    ```js
    const HOST_EXCEPTION_ALLOWLIST = [
      { id: 'getCurrentTime', message: /^TypeError: this\.player\.getCurrentTime is not a function\b/, frame: null },
      { id: 'fetchVideoData-null', message: /^TypeError: Cannot read properties of null \(reading '[^']+'\)/, frame: /\bfetchVideoData\b/ },
    ];
    ```
    `message` 只比對例外訊息的**第一行**；`frame` 比對 `exceptionDetails.stackTrace.callFrames[].functionName`（在 `Runtime.exceptionThrown` 處理時另存 `functionNames` 陣列；沒有 callFrames 時才退回比對 description 第一個 `at` 行）。兩者都要符合才算該規則。
  - f 的判定（`:692–716`）：`newHost` 每筆都要符合某條規則，記下 `allowlistId`；其他 host 例外照舊 FAIL。
  - 「同輪 MVP 也出現」：`live-compare.mjs` 在比較時，對每份非 MVP JSON 的 `scenarios.f.newHostExceptions`，檢查 MVP JSON 的 `pageExceptions` 有同 `allowlistId`（以同規則判定）的例外；沒有就把該份的 f 在並列表顯示為 `FAIL (allowlist not seen in MVP)`，並讓 compare 的 PASS streak 不計入該份。live.mjs 單跑時 f 記 `needsMvpConfirmation: [allowlistId...]`。
  - 離線反例（`.cache/fix2/`）：`Error: unexpected non-null regression`＋stack 含 `fetchVideoData` → 不豁免；`TypeError: Cannot read properties of null (reading 'length')` 而 `functionName` 不是 `fetchVideoData` → 不豁免；兩者都符合 → 豁免。報告列結果。
- [ ] **Step 3：H11、H12**：見任務 3 Step 1、Step 2（同一支檔案，若任務 3 已做，這裡只核對）。
- [ ] **Step 4：H13 指令紀錄跨階段保存**：`refreshCounters` 讀回 `twitchCommandLog`／`updateStates` 時，以 `{phase, entries}` 追加到 `result.commandLogByPhase`／`updateStatesByPhase`，reload（d）後不覆寫前一段；既有 `twitchCommandLog`／`updateStates` 欄位維持現況（相容 live-compare）。
- [ ] **Step 5：H14 Twitch 空白 iframe 整頁重載 1 次**：校準前 `waitPlaying('twitch')` 失敗（`:483–486`）時，先記 `frameDiagnostics`；若 Twitch iframe `src` 正確且（iframe document `body` 空或 `<video>` 數 0），執行一次 `Page.reload`（同 picks、同 profile），重新走「等 YouTube iframe → `waitPlaying('youtube')` → `addTwitch()` → `waitPlaying('twitch')`」；仍失敗才 SKIP。記錄 `twitchMountRetry: { attempted, reason, firstDiagnostics, secondResult }`。限制：只在情境 a 開始前（`scenarioAStarted === false`）允許；情境 a 之後的 Twitch 空白照原判準 FAIL，不重載。重載仍在同一個 300 秒逾時內、同一次 e2e 額度。
- [ ] **Step 6：H15 live-compare 顯示**：並列表加 `audioLockWarningCodes`、`twitchMountRetry.attempted`、fallback 的 `lockDiagnostics` 摘要（a 結束時 `mode／selection／active／b.isBound／b.lastObservedMuted`）、f 的 `allowlistId` 與 MVP 核對結果。仍是「第一份 PASS 時 exit 0」的既有語意，另加 streak 計算不把 MVP 核對失敗的 f 算 PASS。
- [ ] **Step 7：README「Live players」**：補 H9–H15。
- [ ] **Step 8**：`node --check tests/e2e-browser/audio-lock/live.mjs`、`node --check tests/e2e-browser/audio-lock/live-compare.mjs` exit 0；能跑的話 `npx --yes yarn@1.22.22 eslint tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs`（跑不起來照實記錄）。
- [ ] **Step 9：Commit**（H11／H12 若在任務 3 已獨立 commit，這裡只 commit 其餘部分）
  ```bash
  git add tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs tests/e2e-browser/README.md
  git commit -m "test(e2e): narrow host exception allowlist and add read-only lock diagnostics"
  ```

建議順序：任務 1 → 任務 2 → 任務 3 Step 1–2（先 commit `test(e2e): add read-only audio lock diagnostics`）→ build → 任務 3 Step 3 診斷 → 任務 3 Step 4／5 → 任務 4 → 任務 5。

### 任務 5：建置與 e2e（M5）

- [ ] **Step 1**：最後一次 src 改動後 `npx --yes yarn@1.22.22 build`（Chrome＋Firefox）、`npx --yes yarn@1.22.22 test:artifacts`。Expected：exit 0；artifacts 10 passed。
- [ ] **Step 2：假播放器 ×3**：README 既有的 `for n in 1 2 3` 迴圈（`run.mjs` → `compare.mjs` 對照 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`），3 次 `compare.mjs` exit 0。
- [ ] **Step 3：真直播 normal 連續 3 次 PASS**：
  ```bash
  perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs live-fix-$n dist_chrome .cache/e2e-browser/live-fix-$n.json
  ```
  picks 不變（YouTube `1-LpQekNa9g`、Twitch `eslcs`）。SKIP 不算數也不中斷連續；FAIL 從頭算；每次都計入額度。c2 的 `switchedInMs` 與 `focusEvents` 要能看出「沒有新的頂層 blur」。
- [ ] **Step 4：真直播 fallback 1 次 PASS**：同上加 `--mode=fallback`，label `live-fix-fallback`。前提 `twitchObserved=true`、`vIsRefErrors>0`。和 Step 3 分開記錄、不能互抵。任務 3 Step 3 的診斷那次**不算**這一次。
- [ ] **Step 5：MVP 1 次對照**：label `live-mvp`，extension `/Applications/Extensions/holodex-plus-audiolock-chrome`，同一組 picks；跑完 a、b、b′、c×3、d、e、f（各自照實）；預期 c FAIL；記錄 `vIsRefErrors`、`centerClickSwitch`。前後 SHA 清單比對完全相同。
- [ ] **Step 6**：`node tests/e2e-browser/audio-lock/live-compare.mjs .cache/e2e-browser/live-fix-1.json .cache/e2e-browser/live-fix-2.json .cache/e2e-browser/live-fix-3.json .cache/e2e-browser/live-fix-fallback.json .cache/e2e-browser/live-mvp.json`（檔名依實際 label），輸出貼進報告。
- [ ] **Step 7**：所有 e2e JSON（含診斷、FAIL／SKIP／例外與假播放器）複製到 `docs/plans/reports/e2e-fix5-fix2/`，報告列 SHA-256。`.cache/e2e-browser/` 沒有殘留 `live-prof-*`。

### 任務 6：報告

- [ ] **Step 1：寫 `docs/plans/reports/twitch-audio-lock-impl-8.md`**：
  - 根因確認（引用本計畫檔案:行號）、任務 1 修正前 FAIL 摘要、修正後測試數、typecheck、build 次數、artifacts、假播放器 ×3。
  - **fallback 診斷**：引用的 JSON 欄位與值、X1–X5 判定、採用的 Y 分支（或「未定位」）、分支測試修正前 FAIL 摘要。
  - 每次真直播（mode、picks、秒數、exit、verdict、a／b／c1–c3／d／e／f／g、`twitchMountRetry`）；c2 的 `switchedInMs` 與焦點事件；fallback 的 `twitchCommandsReceived`、`audioLockWarningCodes`。
  - H9 確認表（確認方法／結果／是否修改）、H10 離線反例結果、host 例外逐筆與 `allowlistId`、MVP 是否也有。
  - MVP SHA 比對、e2e／build 次數、工作時間、偏離、新發現。
- [ ] **Step 2**：不要在 `twitch-embed.ts` 檔頭寫回「已驗證」；情境 g 真的 PASS 只在報告記錄。
- [ ] **Step 3：Commit**
  ```bash
  git add docs/plans/reports/twitch-audio-lock-impl-8.md docs/plans/reports/e2e-fix5-fix2
  git commit -m "docs: add twitch-audio-lock implementation report 8"
  ```

---

## 測試

| 層級 | 指令 | 通過標準 |
| --- | --- | --- |
| 單元（修正前） | `npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`（只套新測試、src 為基準） | `iframe_to_iframe_focus_without_blur_switches_to_youtube_healthy`、`iframe_to_iframe_focus_without_blur_switches_to_youtube_broken_twitch`、`focused_iframe_tracking_resets_after_teardown` FAIL，原因是沒切回 YouTube／YouTube 被壓回；`focused_iframe_intent_not_refreshed_while_focus_stays`、`focused_iframe_ignored_when_hidden_or_disabled` PASS |
| 單元（分支，修正前） | 同上，只套該分支測試 | 被選中的 Y 分支測試 FAIL，原因是 Twitch 沒收到靜音 |
| 單元（修正後） | `npx --yes yarn@1.22.22 test:audio-lock` | 8 files 全部 passed、0 failed／skipped；總數＝基準（167）＋5＋分支測試數；既有測試名稱與斷言不變 |
| 型別 | `npx --yes yarn@1.22.22 typecheck:audio-lock` | exit 0 |
| 建置 | `npx --yes yarn@1.22.22 build`、`npx --yes yarn@1.22.22 test:artifacts` | exit 0；artifacts 10 passed |
| harness 語法 | `node --check` 兩支 live 腳本 | exit 0 |
| harness 離線反例 | `.cache/fix2/` 探針（不提交） | c2 晚切換不誤判；H3 兩個反例不豁免、正例豁免 |
| 假播放器 ×3 | README 迴圈 | 3 次 `compare.mjs` exit 0 |
| 真直播 normal ×3（M5） | `live.mjs` | 連續 3 次 `verdict:"PASS"` |
| 真直播 fallback ×1（M5） | `live.mjs --mode=fallback` | 1 次 `verdict:"PASS"`，情境 g 成立 |
| MVP 對照 ×1（M5） | `live.mjs` 載入 MVP | 跑完 a–f，c 照實（預期 FAIL） |

## 驗收條件

Codex 驗收時，以下每一項都要**自己實跑**確認，不採信實作報告的數字。任何一項不符即 FAIL。**本輪是 fix-5 最後一輪：FAIL 時協調者停止並回報 Fi，不再開新一輪。**

1. **範圍**：`git diff <本計畫 commit>..HEAD -- src` 只動 Global Constraints 允許的位置：`controller.ts` 的 `lastFocusKey`／`noteFocusedIframe`、兩個決策入口的呼叫、`onBlur`／`onFocusIn`／`teardownSession` 的 `lastFocusKey` 行，以及（只在報告的診斷證據選中時）Y1／Y2 的 `players.ts`、Y3 的 `twitch-embed.ts` 訂閱與 controller 訂閱、Y4 的 `state.ts` 那段。報告沒有證據支持的分支改動一律算超出範圍。`TIMING` 沒變；`onPointerDown`、listener 清單沒變；沒有新增 window `focus` listener 或計時器（若以方案 B 偏離，報告要有真直播證據說明 A 無效）。`package.json`、`yarn.lock`、`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**`、`run.mjs`、`compare.mjs` 沒變；`fakes.js` 與證據逐位元相同；`docs/plans/evidence/**`、`docs/plans/reviews/**` 沒被改。
2. **單元測試**：把本輪 src 改動 revert、只保留測試，「測試」段列為修正前 FAIL 的測試都 FAIL，原因符合；列為 PASS 的兩邊都 PASS。套回後全套 passed，總數＝基準＋5＋分支測試數，既有測試名稱與斷言沒變，沒有 skip／only。新增的 iframe→iframe 測試確實沒有派送 window `blur`／`focusin`（看測試程式碼與計數斷言）。
3. **typecheck、Chrome／Firefox build、artifacts** 都 exit 0；兩支 live 腳本 `node --check` exit 0。
4. **假播放器 e2e**：fix build 連續 3 次 `compare.mjs` exit 0（原計畫驗收 4 的每一條）。
5. **真直播 normal**：照原計畫驗收條件 5 的 a–f 與校準，fix build 連續 3 次 `verdict:"PASS"`。c 含 3 輪反向切換（面板、YouTube iframe、面板），每輪 Twitch 在 2000ms 內靜音、YouTube 有聲，之後 5 秒不反彈；c2 必須是「焦點保留在 Twitch iframe 後直接點 YouTube iframe」且輸入前後沒有新的頂層 `blur`（以 `focusEvents` 確認），否則該輪不算數。b 的切換要有對應 `UPDATE_STATE muted:false`，且之後 3 秒內沒有擴充送出的 SetMuted `true`（以 `commandLogByPhase`／`twitchCommandLog` 判斷）。f 的例外依 H10：`extensionExceptions` 與未分類例外 0，host 例外每筆都符合結構化允許清單**而且同輪 MVP 也出現同 `allowlistId`**。H14 的重載只允許在情境 a 之前、最多 1 次，且有 `twitchMountRetry` 紀錄。
6. **真直播 fallback**：照原計畫驗收條件 6，fix build 1 次 `verdict:"PASS"`，和第 5 項分開記錄、不能互抵；`audioLockWarningCodes` 只有 `twitch-guard-unavailable`；c 每輪 `twitchCommandsReceived.mute` 有增加且由 iframe `<video>` 獨立確認。任務 3 的診斷那一次不算。
7. **fallback 診斷**：報告的診斷結論能由提交的 `live-fix-fallback-diag.json`（`lockDiagnostics`、`audioLockWarningCodes`）對得上；採用的 Y 分支和證據一致；若寫「未定位」，src 沒有 fallback 相關改動，且第 6 項照實 FAIL。
8. **MVP 對照**：照原計畫驗收條件 7：同一組 picks 在 M5 跑一次 MVP，a–f 都有結果，`vIsRefErrors` 與 `centerClickSwitch` 有記錄，c 照實列出（預期 FAIL）；MVP 資料夾前後 SHA 清單相同。
9. **harness**：H9 有確認表與離線反例結果；H10 的兩個反例實跑不豁免、正例豁免；警告保留 code；診斷只讀（程式碼中沒有呼叫 `__setState`、`__applyEffects`、`__reconcile`、`__installBindings`、`__tryDiscover`、`setEnabled`、port `mute`／`unmute`）；情境例外記在 `scenarioErrors` 而不是整輪中止。
10. **額度與邊界**：e2e、build 次數與工作時間都在「回合與額度上限」內；真直播只在 M5；`.cache/e2e-browser/` 沒有殘留 profile；沒有碰 Fi 的瀏覽器 profile、Microlife／Chorus、Orca 安裝；沒有 push、PR、merge、notarize、sudo；沒有寫入 worktree 以外的位置。
11. **報告**：`docs/plans/reports/twitch-audio-lock-impl-8.md` 與 `docs/plans/reports/e2e-fix5-fix2/*.json` 已提交，JSON 的 SHA-256 和報告一致。

Fi 在 M1 Vivaldi 的實測與 Firefox 真機載入，仍是交付後的人工項目，本輪不宣稱完成。

---

## 待 Fi 決定

| # | 問題 | 採用的假設 | 選錯的影響 |
| --- | --- | --- | --- |
| 1 | 焦點追蹤會把「程式把焦點移到某格 iframe」（例如 Holodex 或其他腳本呼叫 `iframe.focus()`）也當成一次意圖（2.5 秒）。 | 接受：fix-1 的每次 blur 記錄已有同樣性質；只在「換到另一格」時送一次，不持續刷新；正常使用未見程式聚焦。 | 若 Holodex 會自動聚焦 Twitch iframe，可能在 2.5 秒內把 Twitch 自己的取消靜音誤判成使用者操作。要防就改成需配合 pointer／可見輸入跡象，屬下一階段。 |
| 2 | 使用者點 Twitch 播放後焦點一直留在 Twitch iframe、超過 2.5 秒才點 Twitch 靜音鈕（同一格、沒有 blur、沒有換焦點）。 | 本輪仍不支援：照「同一格不持續刷新」與 2500ms 意圖窗，和 MVP 一樣抓不到（沿用 fix-1 待決 1）。 | Fi 若常這樣用仍會被壓回；要支援需放寬意圖規則。 |
| 3 | 情境 a 開始後才出現的 Twitch 空白 iframe（URL 正確、body 空、video 0）。 | 照原判準 FAIL，不重載（重載會破壞 a 的前提）；只有校準前允許重載 1 次。 | 外部因素可能讓一輪 normal FAIL 並打斷連續 3 次；額度可能不夠。 |
| 4 | fallback 診斷若指向 X3 中「Twitch 格沒進 `lastBindings`」（adapter 契約）或 X5。 | 本輪不修 adapter、不擴大範圍；報告寫明，fallback 驗收照實 FAIL。 | fix-5 會以 fallback 未達門檻收尾，需 Fi 決定是否接受「只交付 normal」或另開工作。 |
| 5 | 本輪為 fix-5 最後一輪；若 normal 因外部因素（直播下架、廣告、Holodex 改版）無法連續 3 次 PASS 而額度用完。 | 照額度停止、寫報告；Codex FAIL 後流程停止，由協調者回報 Fi，不自動開第 4 輪、不換方案 D。 | 交付延後，等 Fi 決定下一步（換 picks、放寬門檻或接受部分交付）。 |
