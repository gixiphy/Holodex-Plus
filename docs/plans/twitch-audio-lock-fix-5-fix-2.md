# Twitch audio lock fix-5 第 3 輪修正計畫（fix-5-fix-2）：iframe 之間直接換焦點的意圖、fallback 從未送出靜音指令的診斷，以及 harness 判準收窄

> 執行者是 Cursor，驗收者是 Codex。逐任務實作，步驟用 checkbox（`- [ ]`）追蹤。實作偏離本計畫時，寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-8.md` 的「偏離」段落。不要回頭改本計畫、`docs/plans/twitch-audio-lock-fix-5.md`、`docs/plans/twitch-audio-lock-fix-5-fix-1.md`、主計畫或既有報告／審查。

**Goal：** 在真的 `player.twitch.tv` iframe 上：(1) 焦點已在 Twitch iframe 時，使用者直接點 YouTube iframe 自己的靜音鈕取消靜音（頂層沒有新的 window `blur`），Twitch 也要在 2000ms 內被靜音、YouTube 保持有聲；(2) 找出 fallback 模式（SDK 被 Vue 觀察）下 Twitch 從未收到 SetMuted 指令的原因，若是產品 bug 就在本輪修；(3) harness 的 c2 取樣與 H3 例外允許清單不再誤判；(4) Twitch iframe 空白掛載時整頁重載 1 次再判 SKIP。門檻照原計畫驗收條件 5、6、7，不放寬。

**Architecture：** 產品只動兩處，而且第二處要診斷確認後才動：(A) `controller.ts` 新增「焦點 iframe 追蹤」：在既有的每格輪詢（`reconcileCell`）讀播放器**之前**、以及 `setMuted` wrapper 送 `OBSERVED_MUTED` 之前，檢查 `document.activeElement`；只有它**換成另一個已綁定格的 iframe** 時才送 `IFRAME_INTENT`（`source:"iframe"`，2500ms 到期不變）；同一個 iframe 不重複刷新；hidden／disabled／Mute Others 關閉時不記；session 開始時以當下焦點為基準，teardown 清掉。(B) `players.ts` `tryBind`：若診斷確認「SDK 壞掉時 READY 永遠不會觸發、`cell.twPlayer` 一直沒設」，對「已被 Vue 觀察、形狀是 Twitch Player、而且格內有合法 `player.twitch.tv` iframe」的實例，不等 READY 直接走 iframe 管道綁定。harness 只改 `live.mjs`、`live-compare.mjs`、README，另外新增可離線測試的例外分類模組。

**Tech Stack：** 既有 TypeScript、Vitest＋jsdom（`vitest.audio-lock.config.ts`，`restoreMocks: true`）、既有 `tests/e2e-browser/audio-lock/live.mjs`（Node 內建模組＋CDP pipe）、`node --test`（Node 內建），不新增 dependency。

**依據：** `docs/plans/twitch-audio-lock-fix-5.md`（以下稱「原計畫」）、`docs/plans/twitch-audio-lock-fix-5-fix-1.md`（以下稱「上一輪計畫」）、`docs/plans/reviews/twitch-audio-lock-impl-review-7.md`（第 2 輪驗收 FAIL：1 high／2 medium，以下稱 review-7）、`docs/plans/reviews/e2e-fix5-review-2/*.json`（review-7 的真直播 JSON）。

日期：2026-10-18。分支 `gixiphy/twitch-audio-lock`，規劃基準 HEAD `29aed7a`；本計畫的 docs commit 是這一輪的基準。**fix-5 已失敗 2／3，這一輪是最後一輪。**

## 根因（規劃時唯讀確認）

### 1. high：iframe 到 iframe 的焦點切換沒有任何意圖來源

`src/pages/content/holodex/audio-lock/controller.ts @ 29aed7a`：

| 行 | 內容 |
| --- | --- |
| `:562–634` | `reconcileCell`：`:566` 取時間 → `:570` `await entry.port.readMuted()` → `:575` `not-ready` 直接 return → `:576–585` `untrusted` 送 `UNTRUSTED_POLL` → `:615–623` `pollObservation`（`OBSERVED_MUTED origin:"poll"`）。它由 wrapper `manualCheckMuted`（`:658–665`）觸發，也就是 Holodex 每秒對各格的輪詢（原計畫任務 3 Step 2 的模型；normal-2 c2 的「53ms 出聲、472ms 壓回」就是這條路） |
| `:666–697` | `setMuted` wrapper：非面板來源時送 `OBSERVED_MUTED origin:"refresh"`（`:686–695`） |
| `:1177–1202` | `onPointerDown`：只在頂層收到受信任 `pointerdown` 時記意圖；點跨網域 iframe 不會把 pointerdown 送到頂層 |
| `:1204–1224` | `onBlur`：window `blur` 後讀 `activeElement`，是某格 iframe 就送 `IFRAME_INTENT`。**這是 iframe 意圖唯一的來源** |
| `:1226–1234` | `onFocusIn`：焦點回到非 iframe 元素時清掉 iframe 來源的意圖 |
| `:1255–1271` | listener 註冊：`click`×2、`pointerdown`、`blur`、`focusin`、`pageshow`、`pagehide` |

`state.ts:585–597` `IFRAME_INTENT` 設 `expiresAt = now + TIMING.USER_INTENT_MS`（2500）；`state.ts:690–703` `muted:false` 要 `tokenValid`（`:161–166`：同格、未過期、未消耗）、`prev === true`、`settleUntil <= now` 才選中，否則 `desiredMute` 是 muted → `MUTE_PLAYER`（`:732–736`）壓回。

焦點已在 Twitch iframe 時，頂層 window 已經是失焦狀態。這時點 YouTube iframe，焦點從一個子 frame 移到另一個子 frame，頂層**不會**再收到 `blur`，也沒有 `focusin`／`pointerdown`。所以沒有 YouTube 意圖，YouTube 的 `muted:false` 被當成「自己取消靜音」壓回。review-7 normal-2 `scenarios.c[1]`：受信任按鈕、`keyAt:null`、輸入後 53ms YouTube 有聲、472ms 再被靜音、Twitch 全程有聲、`muteDelta:0`。外層 document 的 `activeElement` 在焦點進入子 frame 時會是那個 iframe 元素（HTML Standard），所以頂層可以靠輪詢 `activeElement` 看到「iframe 換了」。

既有單元測試的 `focusIframeAndBlurWindow`（`tests/audio-lock/fixtures.ts:851–855`）每次都派送 window `blur`，涵蓋不到這個序列。

### 2. fallback：UPDATE_STATE 持續到達，但 Twitch 收到的 SetMuted 是 0／0

review-7 `fallback.json`：`twitchObserved:true`、`vIsRefErrors:1201`、`updateStateMessages:209`（`updateStates` 從第 4 筆起就是 `muted:false`）、`twitchCommandsReceived {mute:0, unmute:0}`、a 的 Twitch 有聲取樣 173／179、store `a:false` 全程。唯一的 `[Holodex+ AudioLock]` 警告在 `[Holodex+] Activated` 之前（`t=1792265974577`），但被收集器記成 `Object`，code 遺失（`live.mjs:168` 把 object 參數轉成 `description`）。

程式碼路徑（`src/pages/content/holodex/audio-lock/players.ts @ 29aed7a`）：

| 行 | 內容 |
| --- | --- |
| `:144–153` | `lateBindReady`（Twitch）：只有 `cell.twPlayer === playerComponent.player` 才算 ready。`cell.twPlayer` 是 VideoCell 收到 `ready` 事件才設（fixtures 檔頭 `VideoCell.vue:210-216`） |
| `:211–238` | `tryBind`：`:214` `if (!(readySignal \|\| lateBindReady(binding))) return false;` → 沒有 READY 就**不綁定**，連 iframe 管道（`:218–226`）都走不到 |
| `:254–264` | `readySignal` 只來自 `playerComponent.$on("ready")` |
| `:271–281` | `readMuted`：`tryBind()` 為 false 時回 `not-ready` |
| `:309–313` | `mute`：`tryBind()` 為 false 時回 `false`，**不送 postMessage** |

而 controller 在 `not-ready` 時直接 return（`controller.ts:575`），不送 `UNTRUSTED_POLL`、不送 `MUTE_PLAYER`。原計畫的根因寫明「SDK 的接收端 `_handleResponses` 第一行就讀 `_embedWindow` 而丟錯」；Twitch embed 的 READY 也是經過 `_handleResponses` 派送的 iframe 訊息，所以 SDK 被 Vue 觀察時，**READY 很可能永遠不會觸發** → `ready` 不會 emit → `twPlayer` 不會設 → port 永遠不綁定 → 0 指令。這和 a 的 173 筆雙聲、b 失敗（讀不到 Twitch）、c1／c3 前提不成立全部一致。

單元測試沒抓到：`tests/audio-lock/twitch-broken.test.ts:26–103` 的 `setupBrokenEnv` 走 `createFakeVideoCell` 預設 `readyBeforeInstall`（`fixtures.ts:454–456`），broken SDK 也照樣 `fireReady`，把這個缺口蓋掉了。

**這只是規劃時從程式碼推得的最可能原因，沒有 runtime 證據。** 本輪先用任務 3 的診斷確認，再依結果走分支，不能直接當結論。其他候選與排除理由：

| 代號 | 假設 | 和 0／0 的關係 | 本計畫的處理 |
| --- | --- | --- | --- |
| **X1** | READY 不觸發 → port 不綁定 → `not-ready` | 完全吻合 | 確認後改 Y1（任務 4） |
| X2 | port 有綁定，但 `readTwitchIframeState` 一直讀不到（WeakMap key 不符） | 不吻合：讀不到會回 `untrusted` → `UNTRUSTED_POLL` → 每個 epoch 盲靜音一次，至少會有 1 筆 mute | 不預先修；診斷若顯示 port 已綁定，照「無法定位」處理 |
| X3 | `b` 的 wrapper 沒裝上（adapter 沒發現這格） | 吻合 | adapter 不在本輪允許範圍：報告寫明、停在該項 |
| X4 | 進了 degraded（那筆 `Object` 警告其實是 degraded 類） | 吻合 | 診斷取得 code 後報告；不預先修 |
| X5 | 擴充有送，但 harness 的 iframe 指令計數 listener 沒掛到新 iframe | 只影響量測 | 修 harness，不修產品 |

### 3. medium：c2 零取樣（review-7 發現 2）

受審版 `live.mjs @ d680a7d` 在 toggle 整段 await 完才開始取樣。`a924c11` 已改成：c 每輪先啟動 50ms 的並行 collector（`live.mjs:655–656 @ 29aed7a`），c2 以 `toggle.clickAt` 為起點（`:663`），`switched` 只看 `[t, t+2000]` 的取樣（`:667`）。**看起來已涵蓋**，但沒有離線反例佐證；另外 toggle 在 1000ms 內沒看到變化時會補送鍵盤 `m`（`:432–439`），c2 的計時起點仍是 click，沒有記錄是否靠 `m` 才切換。任務 1 要先核對，未涵蓋的才補。

### 4. medium：H3 允許清單太寬（review-7 發現 3）

`live.mjs:70–73 @ 29aed7a` 仍是 `['this.player.getCurrentTime is not a function', 'fetchVideoData']`，`:703` 對含 stack 的整段 message 做 substring 比對；而且「同輪 MVP 也出現同一訊息」的條件只寫在註解（`:704`），沒有實作。

### 5. 真直播穩定性

review-7 normal-1／3 都是 `no-live-twitch` SKIP（`live.mjs:483–486`）：Twitch iframe URL 正確、document `interactive`、body 空字串、video 0；YouTube 正常。和產品無關，但吃掉額度、也中斷了連續 PASS 的機會。

## 修法比較

| 方案 | 內容 | 評估 |
| --- | --- | --- |
| **A1（採用）** | 在 `reconcileCell` 讀播放器之前、`setMuted` wrapper 送 `OBSERVED_MUTED` 之前，呼叫 `syncFocusedIframeIntent()`。它比對 `activeElement` 和上次記下的 iframe，換成另一個已綁定格的 iframe 時送一次 `IFRAME_INTENT` | 輪詢本身就是每秒定時；而且意圖一定在同一次輪詢的 `OBSERVED_MUTED` **之前**建立，不會有「另一個 timer 晚一步才記意圖」的競態。不新增 timer，teardown 不需要多清 |
| A2 | 另開 250ms timer 輪詢 `activeElement` | 也能做；但意圖可能比 YouTube 的輪詢晚到，最壞要等下一輪 `muted:false`（YouTube 已被壓回，`prev` 會變 false，選不到）。多一個要在 teardown／disable 清的 timer。不採用 |
| A3 | 只要焦點停在某格 iframe 就一直視為意圖 | 等於讓意圖無限期有效，違反 2500ms 窗與「同一格不持續刷新」。不採用 |
| **B1（診斷為 X1 才採用）** | `tryBind` 在 Twitch、沒有 READY 的情況下，如果實例被 Vue 觀察（`isVueObserved`）、有 `setMuted` 函式、格內 iframe 是 `https://player.twitch.tv`，就直接設 `iframeChannel = true` 綁定並 `fireOnReadyOnce()` | 和原計畫備案 B 的設計一致（讀 iframe `UPDATE_STATE`、postMessage 送指令、讀不到時每個 epoch 盲靜音一次）。限定「被 Vue 觀察」，SDK 正常時仍等 READY，normal 路徑不變 |
| B2 | 收到該 iframe 第一筆合法 `UPDATE_STATE` 才綁定 | 較保守，但 iframe 一直不送狀態時就完全不盲靜音，違反原計畫的備案設計。不採用 |

**不要**把 A1 的追蹤和 `onBlur` 合併成「去重」：`onBlur` 維持上一輪的行為（每次 blur 都送意圖），只是順便更新追蹤值，讓下一次輪詢不會對同一個 iframe 再刷新一次。

## Global Constraints

- 禁止 push、開 PR、merge（不合併任何分支、不碰 remote）、公證（notarize）、sudo；不建立或切換分支；不另開 worktree。
- 所有寫入限於本 worktree；commit 寫入主 repo 的 Git metadata 屬允許範圍。禁止刪除 worktree 以外的任何東西。Chrome 暫存 profile 一律放 `.cache/e2e-browser/`，結束時刪除（正常、FAIL、例外、逾時都刪）。**不碰 Fi 的 Vivaldi 或 Chrome profile。**
- 真直播瀏覽器測試**只在 M5** 跑，暫存 profile（Fi 已核准）。不在 M1 跑；不碰 Microlife／Chorus 專案、Orca 的安裝。
- 快取：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；yarn 一律 `npx --yes yarn@1.22.22`，需要安裝時用 `--frozen-lockfile`。暫存腳本、離線反例放 `.cache/fix5-fix2/`（不提交）。
- **不新增 dependency**；`package.json`、`yarn.lock` 這一輪都不改。
- commit 訊息只用英文，Conventional Commits。
- 產品程式碼**只**允許改：
  - `src/pages/content/holodex/audio-lock/controller.ts`：新增 `lastFocusedFrame` 與 `syncFocusedIframeIntent`；在 `reconcileCell`（`:562` 起）讀播放器之前、`setMuted` wrapper（`:686` 的 `OBSERVED_MUTED` 之前）各呼叫一次；`onBlur`（`:1204–1224`）只多「更新 `lastFocusedFrame`」，送意圖的邏輯不變；`onFocusIn`（`:1226–1234`）只多「清 `lastFocusedFrame`」；`beginSession`（`:1044` 起）設基準、`teardownSession`（`:964` 起）清掉。可以把 `onBlur` 裡「找包含此 iframe 的格」抽成共用函式。listener 註冊（`:1255–1271`）**不動**、不新增 window `focus` listener、不新增 timer。
  - `src/pages/content/holodex/audio-lock/players.ts`：**只有任務 3 診斷為 X1 時**，改 `tryBind`（`:211–238`），照方案 B1。
  - 其他 src 一律不動（含 `state.ts`、`contracts.ts`／`TIMING`、`twitch-embed.ts`、`holodex-adapter.ts`、`twitch-audio-lock.ts`、`holodex-inject.ts`、`custom-vite-plugins.ts`、`vite.config.*.ts`）。
- 測試只允許改：`tests/audio-lock/twitch-broken.test.ts`（新增測試；`setupBrokenEnv` 只新增選填參數，預設行為不變）、`tests/audio-lock/fixtures.ts`（只新增 helper，不改既有 helper 行為）、`tests/e2e-browser/audio-lock/live.mjs`、`tests/e2e-browser/audio-lock/live-compare.mjs`、新增 `tests/e2e-browser/audio-lock/live-exceptions.mjs` 與 `tests/e2e-browser/audio-lock/live-exceptions.test.mjs`、`tests/e2e-browser/README.md`（只改「Live players」一節）。`tests/build-artifacts/**`、`run.mjs`、`compare.mjs` 不動；`fakes.js` 保持和 `docs/plans/evidence/twitch-audio-lock-fix-3/harness/fakes.js` 逐位元相同。
- 既有測試名稱、斷言一律不改、不刪、不 skip／only。
- harness 的診斷只能**讀**頁面狀態（Vue 元件欄位、store、DOM、console、既有 listener 的計數），不能包裝、替換或呼叫產品與 Holodex 的函式，不能 commit store mutation 以外的新操作（既有情境步驟照舊）。
- `docs/plans/evidence/**`、`docs/plans/reviews/**`、`.ref/` 唯讀。
- MVP 擴充 `/Applications/Extensions/holodex-plus-audiolock-chrome` 只能透過 CDP `Extensions.loadUnpacked` 唯讀載入；跑前跑後 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort` 比對完全相同（review-7 記錄為 28 檔）。資料夾不存在時照原計畫 Global Constraints 的替代路徑處理。
- 不要自己改成原計畫的方案 D（帶 `muted=true` 重新載入 iframe）；`__v_skip` 或 postMessage 在真 iframe 無效時照實寫「新發現」。

## 回合與額度上限

- fix-5 系列已失敗 2／3，**本輪是第 3 輪、最後一輪**。若本輪 Codex 驗收仍 FAIL，流程**停下來**，由協調者回報 Fi，**不再自動開新一輪**（不寫 fix-5-fix-3、不再派工）。
- **Cursor 本輪**：工作時間上限 **90 分鐘**；e2e 合計最多 **12 次**（假播放器 `run.mjs` 與真直播 `live.mjs` 都算，含 fallback、MVP、診斷、SKIP、例外中止）；`yarn build` 最多 **4 次**。必跑：fallback 診斷 1（任務 3）、假播放器 3、真直播 normal 3、fallback 1、MVP 1，共 9 次，剩 3 次給重試。
- **Codex 本輪**：驗收上限 **60 分鐘**；e2e 合計最多 **8 次**（假播放器 3＋normal 3＋fallback 1＋MVP 1，不留重試；任一次未達門檻即 FAIL）。
- 每次真直播 e2e 內層 300 秒全域逾時；外層再包 `perl -e 'alarm 320; exec @ARGV' --`。任務 2 H5 的整頁重載在同一次執行裡，不另計次數，也不延長 300 秒。
- 超過上限就停在目前狀態寫報告，不硬做。

## Review Focus

1. **iframe→iframe、沒有頂層 blur 的反向切換**：Twitch 被選中、焦點在 Twitch iframe，使用者直接點 YouTube iframe 取消靜音 → 2 秒內 Twitch 靜音、YouTube 有聲 → 任務 5 的 `iframe_to_iframe_focus_reverse_switch_healthy_twitch`、`iframe_to_iframe_focus_reverse_switch_broken_twitch`，真直播 c2。
2. **意圖沒有被放寬**：焦點一直停在同一個 iframe 時，輪詢不能每秒刷新意圖；hidden、disabled、session 開始前就在的焦點都不能產生意圖 → `focused_iframe_poll_does_not_refresh_same_cell_intent`、`focused_iframe_poll_ignored_when_hidden_or_preexisting`，以及上一輪的 `repeated_blur_intent_still_expires_after_2500ms`。
3. **fallback 不靠臆測**：產品修改要有 harness 診斷的 runtime 證據（任務 3 的 `fallbackProbe`），單元測試要重現同一個條件（READY 從未觸發）；診斷不成立就不改 `players.ts`。
4. **Twitch placeholder 不被誤綁**：TwitchPlayer 的 `player` 在 SDK 載入前是 `{}`，被 Vue 觀察時也有 `__ob__`；B1 不能把它當成 Twitch Player → `twitch_placeholder_player_without_ready_is_not_bound`。
5. **harness 不誤判**：c2 正確切換時一定有取樣；H3 只豁免 fetchVideoData 的 null-property 例外與 getCurrentTime，而且同輪 MVP 也要出現同一訊息 → 任務 1、2 與 `live-exceptions.test.mjs`。

---

## 檔案

| 檔案 | 動作 | 用途 |
| --- | --- | --- |
| `src/pages/content/holodex/audio-lock/controller.ts` | 修改（`reconcileCell` `:562` 起、`setMuted` wrapper `:686` 附近、`onBlur` `:1204–1224`、`onFocusIn` `:1226–1234`、`beginSession` `:1044` 起、`teardownSession` `:964` 起） | 焦點 iframe 追蹤：iframe 換成另一格時送 `IFRAME_INTENT` |
| `src/pages/content/holodex/audio-lock/players.ts` | 修改（`tryBind` `:211–238`）**僅限診斷為 X1** | SDK 被 Vue 觀察、READY 不會觸發時，直接走 iframe 管道綁定 |
| `tests/audio-lock/fixtures.ts` | 修改（只新增 helper） | `moveFocusToIframeWithoutBlur(iframe)` |
| `tests/audio-lock/twitch-broken.test.ts` | 修改（`setupBrokenEnv` 新增選填 `readyNever`、`twitchPlaceholder`；新增 4＋2 個測試） | iframe→iframe 反向切換（healthy、broken）、不刷新／不誤記；X1 重現與 placeholder 防護 |
| `tests/e2e-browser/audio-lock/live-exceptions.mjs` | 新增 | 頁面例外分類與 H3 允許清單（純函式，`live.mjs` 與 `live-compare.mjs` 共用） |
| `tests/e2e-browser/audio-lock/live-exceptions.test.mjs` | 新增 | `node --test`：review-7 的反例與允許案例 |
| `tests/e2e-browser/audio-lock/live.mjs` | 修改 | 核對 c2 取樣、H3 收窄、console 警告 code、Twitch 空白掛載重載 1 次、fallback 唯讀診斷、跨階段 log 保留 |
| `tests/e2e-browser/audio-lock/live-compare.mjs` | 修改 | 顯示 `fallbackProbe` 摘要、c2 `inputFallback`、f 的 MVP 同訊息比對 |
| `tests/e2e-browser/README.md` | 修改（「Live players」一節） | 記錄上述行為與判準 |
| `docs/plans/reports/twitch-audio-lock-impl-8.md` | 新增 | 實作報告（含診斷結論） |
| `docs/plans/reports/e2e-fix5-fix2/*.json` | 新增 | 本輪所有 e2e 原始 JSON（含診斷、FAIL／SKIP／例外） |

---

## 步驟

### 任務 0：開工檢查

- [ ] **Step 1**：`git log --oneline -1` 應是本計畫的 docs commit；`git status` 乾淨。
- [ ] **Step 2**：記下開始時間；建立額度表（e2e 0／12、build 0／4）。
- [ ] **Step 3**：MVP 資料夾 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort > .cache/e2e-browser/mvp-before.sha`，記錄檔數。
- [ ] **Step 4**：`npx --yes yarn@1.22.22 test:audio-lock`，記下基準數字（review-7 記錄 8 files／167 passed）。

### 任務 1：核對 c2 取樣（review-7 發現 2），只補沒涵蓋的部分

- [ ] **Step 1：讀程式碼核對**（`live.mjs @ 29aed7a`），每一條寫進報告的確認表：

  | 確認點 | 位置 | 預期 |
  | --- | --- | --- |
  | collector 在輸入**之前**啟動，每 ~50ms 取樣，直到輸入後滿 2000ms | `:655–665` | 已涵蓋 |
  | c2 的計時起點是 `toggle.clickAt`（受信任點擊的時間），不是 toggle 回傳時間 | `:663` | 已涵蓋 |
  | `switched` 只取 `[t, t+2000]` 內 `ytAudible && tw.muted===true` 的第一筆 | `:667` | 已涵蓋 |
  | toggle 在 1000ms 內沒看到變化時補送 `m`，c2 有沒有記錄、計時起點是否跟著改 | `:432–439`、`:663` | **未涵蓋**：補 Step 2 |

- [ ] **Step 2：補強**：c2 若 `toggle.keyAt !== null`（靠 `m` 才切換），計時起點改成 `keyAt`，結果加 `inputFallback: true`；`keyAt === null` 時 `inputFallback: false`。不加第三次輸入。
- [ ] **Step 3：離線反例**：在 `.cache/fix5-fix2/c2-sampling.mjs` 用假的 `readVideo`／`clickAt`（真相在輸入後 1950ms 切換、每次讀取耗時 100ms）跑 c2 的取樣邏輯，證明 `switched` 不是 null、`switchedInMs` 在 1950–2050 之間；再跑一個 2100ms 才切換的版本，證明判 FAIL。若 `.cache/review7/harness-probes.mjs` 存在可以參考，但不要改它。把兩個結果寫進報告（不提交腳本）。

### 任務 2：harness 補強（`live.mjs`、`live-exceptions.mjs`）

- [ ] **Step 1：H3 收窄（review-7 發現 3）**：新增 `tests/e2e-browser/audio-lock/live-exceptions.mjs`，export：
  ```js
  // exceptionDetails: CDP Runtime.exceptionThrown 的 params.exceptionDetails
  export function classifyException(exceptionDetails) // → { kind: 'extension'|'host'|'unclassified', firstLine, frames: [{functionName,url}], allowId: string|null }
  export const HOST_EXCEPTION_ALLOWLIST // [{ id, firstLine: RegExp, frame: (frames) => boolean }]
  export function mvpHasSameHostException(entry, mvpHostExceptions) // → boolean，以 allowId＋firstLine 比對
  ```
  - `firstLine`＝`exception.description`（沒有就用 `text`）的第一行；`frames`＝`stackTrace.callFrames` 的 `{functionName, url}`。**不要**再對含 stack 的整段字串做 substring。
  - 允許清單只有兩項，兩個條件都要成立：
    - `null-length-fetchVideoData`：`firstLine` 符合 `/^TypeError: Cannot read properties of null \(reading '[^']+'\)$/`，而且 `frames` 裡有 `functionName` 以 `fetchVideoData` 結尾、`url` 以 `https://holodex.net/assets/` 開頭的 frame。
    - `getCurrentTime-not-function`：`firstLine === "TypeError: this.player.getCurrentTime is not a function"`，而且所有 frame 的 `url` 都以 `https://holodex.net/assets/` 開頭。
  - 分類照上一輪計畫 H3（`chrome-extension://` 或訊息含 `AudioLock`／`Holodex+` → extension；所有 frame 都在 `https://holodex.net/assets/` → host；其餘 unclassified）。
  - `live.mjs` 改用這個模組：`pageExceptions` 每筆存 `firstLine`、`frames`、`allowId`；刪掉 `:70–73` 的舊常數。情境 f：`extensionExceptions` 新增 0、unclassified 新增 0、host 新增的每一筆 `allowId !== null`，而且 YouTube 仍有聲，才算 live 端的 f PASS；結果另列 `hostAllowedPendingMvp`（需要 MVP 同訊息確認的清單）。
  - **MVP 同輪比對在 `live-compare.mjs` 做**：對每份 fix 結果，`hostAllowedPendingMvp` 的每一筆都要在 MVP JSON 的 `hostExceptions` 找到同 `allowId`＋`firstLine`（`mvpHasSameHostException`）；有任何一筆找不到，並列表的 f 顯示 `FAIL(mvp-missing)`，該份 fix 結果**不算 PASS**。並列表加一欄 `effectiveVerdict`（live verdict 與這項比對的合成），驗收以 `effectiveVerdict` 為準。
- [ ] **Step 2：`live-exceptions.test.mjs`（`node --test`）**，至少：
  - `rejects_non_null_error_with_fetchVideoData_in_stack`：`Error: unexpected non-null regression`、frame 有 `fetchVideoData` → `allowId === null`（review-7 的反例）。
  - `rejects_null_error_outside_fetchVideoData`：`Cannot read properties of null (reading 'length')`，frame 只有其他函式 → `allowId === null`。
  - `accepts_null_length_in_fetchVideoData`：用 review-7 `fallback.json` `hostExceptions[0].raw` 的真實形狀 → `allowId === "null-length-fetchVideoData"`。
  - `accepts_getCurrentTime_from_host_assets`、`rejects_getCurrentTime_from_extension_frame`。
  - `mvp_match_requires_same_allowId_and_firstLine`。
- [ ] **Step 3：AudioLock 警告的 code**：`Runtime.consoleAPICalled`（`:166–175`）遇到 `type === 'object'` 的參數時，先用 `preview.properties` 取出 `code`；沒有 preview 時用 `Runtime.callFunctionOn({ objectId, functionDeclaration: 'function(){try{return JSON.stringify(this)}catch(e){return null}}', returnByValue: true })`。`audioLockWarnings` 每筆加 `code`（取不到就 `null`）。情境 e 改用 `code` 判斷：normal／MVP 照舊（degraded 類 code 不允許）；fallback 只允許 `code === "twitch-guard-unavailable"`，`code === null` 的 AudioLock 警告**算 FAIL**（保守，不猜）。
- [ ] **Step 4：H5 Twitch 空白掛載重載 1 次**：校準階段 `waitPlaying('twitch')` 失敗時（`:483–486`），先讀 Twitch iframe session 的診斷（`document.readyState`、`document.body?.innerHTML.length`、`document.querySelectorAll('video').length`、`location.href`）。若 iframe URL 符合 picks、但 body 為空或 video 數 0，就 `Page.reload` 整頁一次，從「開 multiview、設定 layout、YouTube 開播」重新跑到 `addTwitch()`／`waitPlaying('twitch')`；記錄 `twitchMountRetry: { at, diagnosticsBefore, diagnosticsAfter, recovered }`。第二次仍失敗才 `SKIP no-live-twitch`、exit 4。只在校準階段做（情境 a 已開始後不重載，維持原判準），picks 不變，同一次執行、仍計 1 次額度。
- [ ] **Step 5：fallback 唯讀診斷 `fallbackProbe`**（只在 `--mode=fallback`；MVP 與 normal 也可以記，但只在 fallback 用來判斷）：在 a 結束、b 結束、c 每輪輸入前各取一次，存到 `result.fallbackProbe[]`。頁面端以 `Runtime.evaluate` 讀（不呼叫任何元件方法），從 `#app.__vue__` 往下找 `$options.name === "VideoCell"` 且 `item.i === "b"` 的元件 `cell`，`p = cell.$refs?.player`、`inst = p?.player`：
  - `twPlayerSet: cell.twPlayer != null`、`twPlayerIsInstance: cell.twPlayer === inst`
  - `instHasOb: Object.prototype.hasOwnProperty.call(inst, "__ob__")`、`instHasSetMuted: typeof inst?.setMuted === "function"`、`instHasGetMuted`
  - `readyListeners: (p?._events?.ready || []).length`（Vue 2 的事件表；1 以上代表擴充有掛 `ready` listener）
  - `iframeOrigin`（`p.$el.querySelector("iframe")` 的 `new URL(src).origin`）、`iframeCount`
  - `wrapperInstalled: typeof cell.manualCheckMuted === "function" && !cell.manualCheckMuted.name.startsWith("bound ")`（Vue 綁定的原生方法 name 是 `bound manualCheckMuted`；擴充 patch 後的名稱不同）
  - store `b.muted`、`muteOthers`；當下 `twitchCommandsReceived`、最後一筆 `UPDATE_STATE` 的 `muted`；目前為止的 `audioLockWarnings` code 清單
- [ ] **Step 6：跨階段 log 保留**：`refreshCounters` 每次把 `twitchCommandLog`、`updateStates` 的快照連同階段名稱存到 `result.logsByPhase[phase]`（a、b、c1–c3、d 前、d 後、f），reload 後不覆寫前一階段（review-7 的追溯限制）。
- [ ] **Step 7：`live-compare.mjs`**：並列表加 `effectiveVerdict`、`fHostMvpMatch`、c2 的 `inputFallback`、`twitchMountRetry.recovered`、fallback 的 `fallbackProbe` 最後一筆摘要（`twPlayerSet`／`instHasOb`／`readyListeners`／`wrapperInstalled`）。只有第一份 `effectiveVerdict === "PASS"` 時 exit 0。
- [ ] **Step 8：README「Live players」**：補 c2 計時起點與 `inputFallback`、H3 新規則與 MVP 比對、警告 code、Twitch 空白重載、`fallbackProbe` 欄位意義。
- [ ] **Step 9**：`node --check tests/e2e-browser/audio-lock/live.mjs`、`node --check tests/e2e-browser/audio-lock/live-compare.mjs`、`node --test tests/e2e-browser/audio-lock/live-exceptions.test.mjs` 都 exit 0。能跑的話 `npx --yes yarn@1.22.22 eslint tests/e2e-browser/audio-lock/*.mjs`（跑不起來照實記錄）。
- [ ] **Step 10：Commit**
  ```bash
  git add tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs tests/e2e-browser/audio-lock/live-exceptions.mjs tests/e2e-browser/audio-lock/live-exceptions.test.mjs tests/e2e-browser/README.md
  git commit -m "test(e2e): narrow host exception allowlist and add fallback probe"
  ```

### 任務 3：fallback 診斷（先診斷，不改產品）

- [ ] **Step 1：離線讀 review-7 既有資料**（`.cache/fix5-fix2/diag-review7.py`，不提交）：從 `docs/plans/reviews/e2e-fix5-review-2/fallback.json` 列出 `updateStates` 的 `muted` 時間序列、`twitchCommandLog`、`focusEvents`、`audioLockWarnings` 的時間與 `[Holodex+] Activated` 的先後、a 每筆取樣的 store `b`。寫進報告「診斷」段。這一步預期**不足以**區分 X1／X3／X4（沒有 code、沒有元件欄位）。
- [ ] **Step 2：單元重現 X1 的條件（修正前要 FAIL）**：`setupBrokenEnv` 新增選填 `readyNever?: boolean`：為 `true` 時 cell b 用 `readyBeforeInstall: false` 建立、測試全程不呼叫 `fireReady`（`cell.twPlayer` 保持 `null`）。新增測試：

  | 測試名稱 | 設定 | 斷言 | 修正前預期 |
  | --- | --- | --- | --- |
  | `broken_twitch_without_ready_event_binds_via_iframe_channel` | `setupBrokenEnv({ readyNever: true, twitchMuted: false })`（brokenByVue）；store a `false`、b 不帶 `muted`（模擬 guard 失效時 Twitch 以未靜音建構）；enabled、Mute Others 開；`postTwitchUpdateState(b iframe, { muted:false })`；`pollSeconds(3)` | `postSpies.get("b")` 有 `params === true` 的呼叫 ≥ 1；`__getState().mode !== "degraded"`；`console.warn` 沒有 degraded 類 code；store a 不是 `true` | FAIL（0 次 postMessage） |
  | `twitch_placeholder_player_without_ready_is_not_bound` | `setupBrokenEnv({ readyNever: true, twitchPlaceholder: true })`：b 的 `playerComponent.player` 是帶 `__ob__` 的 `{}`（`createFakePlayerComponent(..., { sdkLoaded:false })` 後補 `__ob__`）；`pollSeconds(3)` | `postSpies.get("b")` 0 次；不 degraded、沒有警告 | PASS（保護 B1 的條件；修正前後都 PASS，報告註明） |

  跑 `npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`，記錄第一個 FAIL 的原因（要是「沒有送出 postMessage」，不是 import／helper 錯誤）。**這兩個測試先不 commit**，等 Step 4 決定（暫存方式見任務 5 Step 7）。
- [ ] **Step 3：真直播診斷 1 次**（計入額度）：先完成任務 5 的產品修正與 `npx --yes yarn@1.22.22 build`（build 1／4），以避免多 build 一次；任務 5 不影響 Twitch 綁定。然後：
  ```bash
  perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs live-fix-diag dist_chrome .cache/e2e-browser/live-fix-diag.json --mode=fallback
  ```
  讀 `fallbackProbe`、`audioLockWarnings[].code`、`twitchCommandsReceived`。
- [ ] **Step 4：依診斷分支**（結論寫進報告「診斷」段，附 JSON 欄位原值）：

  | 診斷結果 | 判定 | 本輪動作 |
  | --- | --- | --- |
  | `twPlayerSet:false`、`instHasOb:true`、`instHasSetMuted:true`、`readyListeners ≥ 1`、`wrapperInstalled:true`、`twitchCommandsReceived.mute === 0`、沒有 degraded 類 code | **X1 成立** | 做任務 4（Y1）；Step 2 的兩個測試一起 commit |
  | `wrapperInstalled:false` | X3（adapter 沒裝 wrapper） | 不改產品（adapter 不在本輪範圍）；報告寫明，fallback 項停在「已定位、未修」；Step 2 的測試不 commit |
  | 有 `twitch-guard-unavailable` 以外的 AudioLock code | X4 | 不改產品；報告列 code 與時間；停在該項 |
  | `twPlayerSet:true` 而且 mute 仍是 0 | X2／未知 | 照「無法定位」處理：報告明說，停在該項 |
  | `twitchCommandsReceived.mute > 0` 而且 Twitch `<video>` 被靜音 | 診斷版本已不重現（例如 X5 量測） | 報告寫明；不改產品；照常跑任務 6 的 fallback 判定 |
  | 其他組合或診斷那次 SKIP | 未定位 | 可以用 1 次重試額度再跑一次診斷；仍無法定位就報告明說、停在該項，不硬湊 PASS |

  「停在該項」的意思是：不改 `players.ts`，fallback 仍照任務 6 跑 1 次並照實記錄（預期 FAIL），其餘任務照常完成；報告與驗收都不得宣稱 fallback PASS。

### 任務 4：Y1 產品修正（只有任務 3 判定 X1 時）

- [ ] **Step 1：`players.ts` `tryBind`（`:211–238`）**：在 `:214` 的 ready 檢查之前，對 Twitch 加一條不等 READY 的綁定路徑：
  ```ts
  const observedTwitchWithIframe = (): boolean => {
    if (binding.provider !== "twitch") return false;
    const instance = binding.playerComponent.player;
    if (!instance || typeof instance !== "object") return false;
    if (typeof (instance as { setMuted?: unknown }).setMuted !== "function") return false;
    if (!isVueObserved(instance as object)) return false;
    const iframe = twitchIframe(binding);
    if (!iframe) return false;
    try {
      return new URL(iframe.src).origin === TWITCH_PLAYER_ORIGIN;
    } catch {
      return false;
    }
  };
  ```
  `readySignal || lateBindReady(binding)` 都不成立、但 `observedTwitchWithIframe()` 成立時：`iframeChannel = true`、`boundInstance = instance`、`fireOnReadyOnce()`、回 `true`（`methods` 保持 `null`；`readMuted`／`mute`／`restoreSelectedAudio` 已經在 `useIframeChannel()` 為 true 時走 iframe 管道）。`TWITCH_PLAYER_ORIGIN` 從 `./twitch-embed` import（已 export），不在 `players.ts` 硬寫 Twitch embed 的 namespace／eventName。其他路徑（SDK 正常、YouTube、READY 之後缺方法）不變。
- [ ] **Step 2**：`npx --yes yarn@1.22.22 test:audio-lock`。Expected：全部 passed；任務 3 Step 2 兩個測試都 PASS。
- [ ] **Step 3：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/players.ts tests/audio-lock/twitch-broken.test.ts
  git commit -m "fix(audio-lock): bind Vue-observed Twitch players without READY"
  ```
  之後要重新 build（build 2／4）才能跑任務 6。

### 任務 5：焦點 iframe 追蹤（high）

**Interfaces（新增於 `fixtures.ts`）：**

```ts
// 模擬「焦點已在某個子 frame，使用者直接點另一個跨網域 iframe」：只改 activeElement，不派送 blur／focus／focusin／pointerdown。
export function moveFocusToIframeWithoutBlur(iframe: HTMLIFrameElement): void;
```

- [ ] **Step 1：helper**：`vi.spyOn(document, "activeElement", "get").mockReturnValue(iframe)`，不派送任何事件。測試裡另掛 window `blur`／`focusin` 計數 listener，斷言兩者都是 0。
- [ ] **Step 2：新增測試**（放在 `describe("twitch broken SDK / no-degrade")` 內，沿用 `setupBrokenEnv`、`makeHandle`、`postTwitchUpdateState`、`pollSeconds`）：

  | 測試名稱 | 設定與序列 | 斷言 | 修正前預期 |
  | --- | --- | --- | --- |
  | `iframe_to_iframe_focus_reverse_switch_healthy_twitch` | `setupBrokenEnv({ healthyTwitch: true, twitchBroken: false, twitchMuted: false })`；store a `true`、b `false`；`__setState` 為 locked／selected、active=b、epoch 1。YouTube `rawMuted=true` 後 `a.manualCheckMuted()`（建立 `lastObservedMuted=true`），推進 1600ms。(1) `focusIframeAndBlurWindow(b iframe)`、推進 0（使用者先前點了 Twitch）；推進 3000ms（Twitch 意圖過期）。(2) `moveFocusToIframeWithoutBlur(a iframe)`；(3) YouTube `rawMuted=false`（在 YouTube iframe 內取消靜音）；`pollSeconds(2)` | active 是 a；Twitch SDK `rawMuted === true`；YouTube `rawMuted === false`，而且 (3) 之後 YouTube 的 `muteCalls` 沒增加；store a `false`、b `true`；(2) 之後 blur／focusin 計數 0 | FAIL（YouTube 被壓回、active 仍是 b） |
  | `iframe_to_iframe_focus_reverse_switch_broken_twitch` | 同上，但 `setupBrokenEnv()`（SDK 被 Vue 觀察）；Twitch 狀態用 `postTwitchUpdateState(b iframe, { muted:false })` 建立；(3) 之後在 Twitch 收到 `params === true` 時再送 `postTwitchUpdateState(b iframe, { muted:true })`（模擬 iframe 套用） | active 是 a；`postSpies.get("b")` 在 (3) 之後有 `params === true`；YouTube 沒被壓回（同上）；store a `false`、b `true` | FAIL |
  | `focused_iframe_poll_does_not_refresh_same_cell_intent` | healthy Twitch、active=b、YouTube `lastObservedMuted=true`。`moveFocusToIframeWithoutBlur(a iframe)` 後焦點**一直**停在 a iframe，每秒輪詢共 3 秒（`pollSeconds(3)`，YouTube 仍 muted）；之後 YouTube `rawMuted=false`、`pollSeconds(2)` | active 仍是 b；YouTube 被靜音回去（`muteCalls` 增加或 `rawMuted === true`）；Twitch 沒被靜音 | PASS（修正前沒有意圖；修正後意圖只在第一次看到時建立、2500ms 後過期，不被輪詢刷新） |
  | `focused_iframe_poll_ignored_when_hidden_or_preexisting` | 兩段：(i) `vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")`，`moveFocusToIframeWithoutBlur(a iframe)`，同時 YouTube `rawMuted=false`，`pollSeconds(2)`；(ii) 新環境：`setEnabled(true)` **之前**就 `moveFocusToIframeWithoutBlur(a iframe)`，enable／discover 後 active=b，YouTube `rawMuted=false`、`pollSeconds(2)` | 兩段都是 active 仍是 b、YouTube 被壓回 | PASS（保護條件；修正前後都 PASS，報告註明） |

  另外確認上一輪的 `repeated_blur_intent_still_expires_after_2500ms` 在修正後仍 PASS（`onBlur` 更新追蹤值，輪詢不會對同一個 iframe 再刷新意圖）。
- [ ] **Step 3：修正前跑**：`npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`。Expected：前兩個新測試 FAIL，原因是 active 不是 a／YouTube 被壓回，**不是** import 或 helper 錯誤；後兩個 PASS。寫進報告。
- [ ] **Step 4：`controller.ts` 實作**：
  - 在 `onBlur` 附近新增 `let lastFocusedFrame: Element | null = null;`，和 `findBindingForFrame(active: Element): CellBinding | null`（從 `onBlur` 現有的 `for (const [, binding] of lastBindings)`＋`el.contains(active)` 抽出來，`onBlur` 改用它，行為不變）。
  - 新增：
    ```ts
    const syncFocusedIframeIntent = () => {
      if (!enabled || !state.muteOthers) return;
      if (doc.visibilityState === "hidden") return;
      const active = doc.activeElement;
      if (!active || active.tagName !== "IFRAME") {
        lastFocusedFrame = null;
        return;
      }
      if (active === lastFocusedFrame) return;
      lastFocusedFrame = active;
      const binding = findBindingForFrame(active);
      if (!binding) return;
      state = transition(state, {
        type: "IFRAME_INTENT",
        now: now(),
        identity: binding.identity,
        source: "iframe",
      }).state;
    };
    ```
  - `reconcileCell`：在 `run` 裡、`await entry.port.readMuted()`（`:570`）之前呼叫 `syncFocusedIframeIntent()`。`setMuted` wrapper：在 `hasPanelDispatch()` 判斷之後、送 `OBSERVED_MUTED`（`:686`）之前呼叫。
  - `onBlur`：找到格之後、送 `IFRAME_INTENT` 的同時設 `lastFocusedFrame = active`（送意圖的條件與次數不變，仍是每次 blur 都送）。
  - `onFocusIn`：焦點到非 iframe 元素時，除了清 iframe 意圖，也設 `lastFocusedFrame = null`。
  - `beginSession`（`:1044` 起，建立 `session` 之後）：`lastFocusedFrame = doc.activeElement?.tagName === "IFRAME" ? doc.activeElement : null`（session 開始前就在的焦點只當基準，不產生意圖）。`teardownSession`（兩個分支都要）：`lastFocusedFrame = null`。
  - 不新增 listener、不新增 timer、不改 `TIMING`、不改 `state.ts`。
- [ ] **Step 5：跑測試**：`npx --yes yarn@1.22.22 test:audio-lock`。Expected：8 files、全部 passed、0 failed／skipped；總數＝任務 0 Step 4 的基準＋4（任務 4 有做時再＋2）。另外 `grep -rn "focus()\|activeElement" tests/audio-lock/*.test.ts`，確認沒有既有測試把焦點留在 iframe 而受新行為影響；若有，報告逐條說明為何仍 PASS。
- [ ] **Step 6**：`npx --yes yarn@1.22.22 typecheck:audio-lock` exit 0。
- [ ] **Step 7：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/fixtures.ts tests/audio-lock/twitch-broken.test.ts
  git commit -m "fix(audio-lock): record intent when focus moves between cell iframes"
  ```
  任務 3 Step 2 的兩個測試（和 `setupBrokenEnv` 的 `readyNever`／`twitchPlaceholder` 選項）不能進這個 commit：跑完紅燈後先把它們從 `twitch-broken.test.ts` 剪到 `.cache/fix5-fix2/x1-tests.ts.txt`（**不要用 git stash**），這個 commit 之後，任務 3 判定 X1 時再貼回、隨任務 4 commit；不是 X1 就不貼回。

### 任務 6：建置與 e2e（M5）

執行順序：任務 2 → 任務 5 → build（1／4）→ 任務 3 Step 3 診斷 → 任務 3 Step 4 →（X1 時）任務 4 → build（2／4）→ 本任務。

- [ ] **Step 1**：`npx --yes yarn@1.22.22 build`（Chrome＋Firefox）、`npx --yes yarn@1.22.22 test:artifacts`。Expected：exit 0；artifacts 10 passed。
- [ ] **Step 2：假播放器 ×3**：README 既有的 `for n in 1 2 3` 迴圈（`run.mjs` → `compare.mjs` 對照 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`），3 次 `compare.mjs` exit 0。
- [ ] **Step 3：真直播 normal 連續 3 次 PASS**：
  ```bash
  perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs live-fix-$n dist_chrome .cache/e2e-browser/live-fix-$n.json
  ```
  同一組 picks（YouTube `1-LpQekNa9g`、Twitch `eslcs`）。SKIP 不算數也不中斷連續；FAIL 從頭算；每次都計入額度。
- [ ] **Step 4：真直播 fallback 1 次**：同上加 `--mode=fallback`，label `live-fix-fallback`。前提 `twitchObserved=true`、`vIsRefErrors>0`。和 Step 3 分開記錄、不能互抵。任務 3 判定不是 X1 時仍要跑，照實記錄。
- [ ] **Step 5：MVP 1 次對照**：label `live-mvp`，extension `/Applications/Extensions/holodex-plus-audiolock-chrome`，同一組 picks。跑完 a、b、b′、c×3、d、e、f；預期 c FAIL；記錄 `vIsRefErrors`、`centerClickSwitch`、`hostExceptions`。跑完後 `find … | sort` 和 `mvp-before.sha` 比對完全相同。
- [ ] **Step 6**：`node tests/e2e-browser/audio-lock/live-compare.mjs .cache/e2e-browser/live-fix-1.json .cache/e2e-browser/live-fix-2.json .cache/e2e-browser/live-fix-3.json .cache/e2e-browser/live-fix-fallback.json .cache/e2e-browser/live-mvp.json`，輸出貼進報告（含 `effectiveVerdict`、`fHostMvpMatch`）。
- [ ] **Step 7**：所有 e2e JSON（含診斷、FAIL／SKIP／例外與假播放器）複製到 `docs/plans/reports/e2e-fix5-fix2/`，報告列 SHA-256。`.cache/e2e-browser/` 沒有殘留 `live-prof-*`。

### 任務 7：報告

- [ ] **Step 1：寫 `docs/plans/reports/twitch-audio-lock-impl-8.md`**：
  - 根因確認（附本計畫的檔案:行號）；任務 1 確認表與離線反例結果。
  - **診斷段**：任務 3 Step 1 的既有資料整理、Step 3 的 `fallbackProbe` 原值、Step 4 判定（X1／X3／X4／未定位）與理由；若未修，明寫「fallback 未達門檻、原因已定位／未定位」。
  - 修正前 FAIL 摘要、修正後測試數、typecheck、build、artifacts、`node --test` 結果、假播放器 ×3。
  - 每次真直播（mode、picks、秒數、exit、verdict、`effectiveVerdict`、a／b／c1–c3／d／e／f／g）；c2 的 `switchedInMs`、`inputFallback`、焦點紀錄（點擊前 activeElement 是 Twitch iframe、之後是 YouTube iframe、期間 blur 次數）；`twitchMountRetry`。
  - host 例外逐筆（`allowId`、`firstLine`、MVP 是否有同訊息）；AudioLock 警告 code 清單。
  - MVP SHA 比對、e2e／build 次數、工作時間、偏離、新發現。
- [ ] **Step 2**：`twitch-embed.ts` 檔頭不動（本輪不在範圍）；即使情境 g PASS 也只在報告記錄。
- [ ] **Step 3：Commit**
  ```bash
  git add docs/plans/reports/twitch-audio-lock-impl-8.md docs/plans/reports/e2e-fix5-fix2
  git commit -m "docs: add twitch-audio-lock implementation report 8"
  ```

---

## 測試

| 層級 | 指令 | 通過標準 |
| --- | --- | --- |
| 單元（修正前） | `npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`（只套新測試、src 為基準） | `iframe_to_iframe_focus_reverse_switch_healthy_twitch`、`iframe_to_iframe_focus_reverse_switch_broken_twitch` FAIL，原因是 YouTube 被壓回／active 不是 a；`focused_iframe_poll_does_not_refresh_same_cell_intent`、`focused_iframe_poll_ignored_when_hidden_or_preexisting` PASS。X1 成立時另加：`broken_twitch_without_ready_event_binds_via_iframe_channel` FAIL（0 次 postMessage）、`twitch_placeholder_player_without_ready_is_not_bound` PASS |
| 單元（修正後） | `npx --yes yarn@1.22.22 test:audio-lock` | 8 files，全部 passed（預期 171＝167＋4；X1 成立時 173），0 failed／skipped；既有測試名稱與斷言全保留 |
| 型別 | `npx --yes yarn@1.22.22 typecheck:audio-lock` | exit 0 |
| 建置 | `npx --yes yarn@1.22.22 build`、`npx --yes yarn@1.22.22 test:artifacts` | exit 0；artifacts 10 passed |
| harness 語法與分類 | `node --check` 兩支 live 腳本；`node --test tests/e2e-browser/audio-lock/live-exceptions.test.mjs` | exit 0；任務 2 Step 2 列出的案例全過 |
| 假播放器 ×3 | README 迴圈 | 3 次 `compare.mjs` exit 0 |
| 真直播 normal ×3（M5） | `live.mjs` | 連續 3 次 `effectiveVerdict:"PASS"` |
| 真直播 fallback ×1（M5） | `live.mjs --mode=fallback` | 1 次 `effectiveVerdict:"PASS"`，情境 g 成立 |
| MVP 對照 ×1（M5） | `live.mjs` 載入 MVP | 跑完 a–f，c 照實（預期 FAIL），`hostExceptions` 有記錄 |

## 驗收條件

Codex 驗收時，以下每一項都要**自己實跑**確認，不採信實作報告的數字。任何一項不符即 FAIL。**本輪 FAIL 時流程停止，回報 Fi，不開新一輪。**

1. **範圍**：`git diff <本計畫 commit>..HEAD -- src` 只動 `controller.ts` 的焦點追蹤相關行（照 Global Constraints 列出的位置），以及（只有報告的診斷判定為 X1 時）`players.ts` 的 `tryBind`；沒有新增 listener 或 timer；`state.ts`、`contracts.ts`／`TIMING`、`twitch-embed.ts` 沒變；`"twitch-embed-player-proxy"`、`"UPDATE_STATE"` 和 SetMuted 的 `10` 在 src 裡仍只出現在 `twitch-embed.ts`。`package.json`、`yarn.lock`、`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**`、`run.mjs`、`compare.mjs` 沒變；`fakes.js` 和證據逐位元相同；`docs/plans/evidence/**`、`docs/plans/reviews/**` 沒被改。
2. **單元測試**：把本輪 src 改動 revert、只保留測試，「測試」段列為修正前 FAIL 的測試都 FAIL，原因符合；列為 PASS 的兩邊都 PASS。套回後全套 passed（預期 171，X1 時 173，或報告寫明的實跑數＝基準＋新增數），既有測試名稱與斷言沒變，沒有 skip／only。
3. **typecheck、Chrome／Firefox build、artifacts** 都 exit 0；兩支 live 腳本 `node --check` exit 0；`node --test tests/e2e-browser/audio-lock/live-exceptions.test.mjs` exit 0，而且包含 review-7 的反例（stack 含 `fetchVideoData` 的非 null 錯誤被拒絕）。
4. **harness 核對**：報告有任務 1 的確認表與離線反例結果；c2 從受信任輸入時間（用到 `m` 時是 `keyAt`）起算 2000ms，期間有取樣；H3 只豁免兩項允許清單、而且以 `live-compare.mjs` 對同輪 MVP 的比對決定 `effectiveVerdict`；AudioLock 警告有 code。
5. **假播放器 e2e**：fix build 連續 3 次 `compare.mjs` exit 0（原計畫驗收 4 的每一條）。
6. **真直播 normal**：照原計畫驗收條件 5 的 a–f 與校準，fix build 連續 3 次 `effectiveVerdict:"PASS"`。c 的 3 輪（面板、YouTube iframe、面板）每輪 Twitch 都在 2000ms 內靜音、YouTube 有聲、之後 5 秒不反彈；c2 的點擊前焦點是 Twitch iframe，點擊和取樣期間頂層沒有派送任何人為的 blur 或空白點擊。另外保留上一輪驗收 6 的補充：b 的切換要有對應的 `UPDATE_STATE muted:false`，而且之後 3 秒內沒有擴充送出的 SetMuted `true`；f 依任務 2 Step 1 判定。
7. **真直播 fallback**：照原計畫驗收條件 6，fix build 1 次 `effectiveVerdict:"PASS"`，和第 6 項分開記錄、不能互抵；e 只允許 `code === "twitch-guard-unavailable"`。報告的診斷段要和 JSON 的 `fallbackProbe` 一致；若報告判定「未定位」或「已定位未修」，本項直接 FAIL（不得用其他項目抵）。
8. **MVP 對照**：照原計畫驗收條件 7：同一組 picks 在 M5 跑一次 MVP，a–f 都有結果，`vIsRefErrors`、`centerClickSwitch`、`hostExceptions` 有記錄，c 照實列出（預期 FAIL）；MVP 資料夾前後 SHA 清單相同。
9. **額度與邊界**：e2e、build 次數與工作時間都在「回合與額度上限」內；真直播只在 M5；`.cache/e2e-browser/` 沒有殘留 profile；沒有碰 Fi 的瀏覽器 profile、Microlife／Chorus、Orca 安裝；沒有 push、PR、merge、notarize、sudo；沒有寫入 worktree 以外的位置。
10. **報告**：`docs/plans/reports/twitch-audio-lock-impl-8.md` 與 `docs/plans/reports/e2e-fix5-fix2/*.json` 已提交，JSON 的 SHA-256 和報告一致。

Fi 在 M1 Vivaldi 的實測與 Firefox 真機載入，仍是交付後的人工項目，本輪不宣稱完成。

---

## 待 Fi 決定

| # | 問題 | 採用的假設 | 選錯的影響 |
| --- | --- | --- | --- |
| 1 | 焦點追蹤會把「焦點換到另一格 iframe」當成 2.5 秒的使用者意圖。使用者只是點 YouTube 畫面（例如暫停），而 YouTube 剛好在這 2.5 秒內自己取消靜音，就會被當成使用者選聲。 | 接受：和 window `blur` 的既有語意相同（上一輪「待 Fi 決定」3），而且要同時符合「格之前是靜音」才會選中。 | 若 Fi 遇到 YouTube 自己搶聲，要改成只接受有可見輸入跡象（例如 hover 同一格）的焦點變化，需要再一輪。 |
| 2 | 上一輪「待 Fi 決定」1（點 Twitch 播放後焦點一直留在同一個 Twitch iframe、超過 2.5 秒才取消靜音）本輪仍不處理。 | 不處理：焦點沒有變化，任何以「變化」為準的偵測都抓不到；放寬會違反 2500ms 窗。 | 該用法仍會被壓回。 |
| 3 | fallback 的產品修正（Y1）要靠本輪 1 次真直播診斷才能決定；若診斷不是 X1，本輪 fallback 一定 FAIL，而本輪是最後一輪。 | 照規則不臆測：不是 X1 就不改產品、照實報告。 | fix-5 會以「normal 可能通過、fallback 未通過」結束，需要 Fi 決定 fallback（擴充晚注入、SDK 被觀察的情境）是否為交付必要條件。 |
| 4 | H5 只在校準階段遇到 Twitch 空白掛載時整頁重載 1 次；情境 a 之後的空白掛載仍照原判準 FAIL。 | 照協調者要求只放在掛載階段、picks 不變。 | 若 Twitch 在 a 重新加入時空白，該次仍會 FAIL 並中斷連續 PASS，只能用重試額度。 |
| 5 | H3 的 MVP 同訊息比對放在 `live-compare.mjs`（`effectiveVerdict`），不在單次 `live.mjs` 的 verdict。 | 採用：單次執行時還沒有 MVP 結果。 | 若 Fi 要求單次 verdict 就自足，需要多跑一次「不載入擴充」的對照（多 1 次 e2e）。 |
