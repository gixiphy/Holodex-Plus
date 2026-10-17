# Twitch audio lock 修正計畫 fix-5：真的 Twitch iframe 讓 YouTube 一直被靜音，以及反向切換

> 執行者是 Cursor，驗收者是 Codex。逐任務實作，步驟用 checkbox（`- [ ]`）追蹤。實作偏離本計畫時，寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-6.md` 的「偏離」段落。不要回頭改本計畫、主計畫或既有報告。

**Goal：** 在真的跨網域 `player.twitch.tv` iframe 上，Mute Others 開著時：YouTube 先播、Twitch 晚到也一直保持「YouTube 有聲、Twitch 靜音」；使用者主動取消 Twitch 靜音時切到 Twitch；使用者再取消 YouTube 靜音時，Twitch 在 2 秒內變靜音、YouTube 有聲（反向切換）。

**Architecture：** 根因是 Holodex 把 `Twitch.Player` 實例放進 Vue 2.7 reactive data，Vue 把裡面的跨網域 `WindowProxy` 包成 reactive getter，之後 Twitch SDK 每次讀 `_embedWindow` 都丟 SecurityError，所以 SDK 讀不到狀態、指令也送不出去。修法分三層：(1) 新模組 `twitch-embed.ts` 攔截 `window.Twitch.Player` 建構（移植 MVP），預設 `muted:true`，並在實例上標 `__v_skip`，讓 Vue 不觀察它，SDK 恢復正常；(2) Twitch 的 PlayerPort 偵測「實例已被 Vue 觀察」或「SDK 缺 `getMuted`／`setMuted`」時改用 iframe 管道：讀取改看 `twitch-embed.ts` 自己監聽、驗證過的 iframe `UPDATE_STATE` 訊息（不經過壞掉的 SDK getter），靜音／取消靜音直接用 postMessage 對 iframe 送 Twitch embed 指令；完全沒收到 iframe 狀態時才回「不可信」，改成盲靜音，失敗的送出依冷卻時間重試；(3) Twitch 格的讀取失敗、靜音失敗、靜音沒生效、SDK 契約不符，一律不進 degraded、不拆 wrapper、不退回 Holodex 原生處理。另外照 MVP 基準，bootstrap 時有非 Twitch 格就不讓 Twitch 首播搶選聲。fix-4 的狀態機、fix-3 的 classic IIFE 建置都保留。

**Tech Stack：** 既有 TypeScript、Vitest＋jsdom（`vitest.audio-lock.config.ts`）、既有假播放器 Chrome harness（`tests/e2e-browser/audio-lock/run.mjs`），新增一支真直播 CDP 腳本（Node 20 內建模組，不新增 dependency）。

**依據：** 主計畫 `docs/plans/twitch-audio-lock.md`、`docs/plans/twitch-audio-lock-fix-4.md`、證據 `docs/plans/evidence/twitch-audio-lock-fix-5/`（`ROOTCAUSE-3.md`、`mvp-holodex-inject.js`）、Fi 2026-10-18 00:20 的 MVP 反向切換回報。

日期：2026-10-18。分支 `gixiphy/twitch-audio-lock`，基準 head 是本計畫的 docs commit（父 commit `bdb28f0`）。

## 根因對照（規劃時唯讀確認）

### 上游原始碼（規劃時唯讀抓取，未存進 repo）

`.ref/holodex` 在本 worktree 是斷掉的 symlink，所以直接抓了線上檔案確認：

| 來源 | SHA-256 | 確認到的內容 |
| --- | --- | --- |
| `https://holodex.net/assets/TwitchPlayer.56c23ec6.js`（對應 `TwitchPlayer.vue`） | `174135fd7c93f82573eca14eb3f68ac26e0c9d4057e86cc88ba03bcbf1fa9883` | `data(){return {player:{}, ...}}`（第 41 行）；`watch.mute(e){this.player.setMuted(e)}`（第 58 行）；`beforeCreate` 裡 `this.player=new window.Twitch.Player(this.elementId,e)`，options 只有 `width/height/parent/autoplay:false`（第 86 行）；`isMuted(){return this.player.getMuted()}`；`setMute(e){this.player.setMuted(e)}` |
| `https://holodex.net/assets/vendor.be3ecd61.js`（Vue **2.7.8**） | `d2f876301d73299801a183429f3824c841d010f33e993aae3751becb517b9243` | `observe()`：`!(!isObject(t)\|\|isRef(t)\|\|t instanceof VNode)`，而且只有 `!t.__v_skip` 才 `new Observer(t)`。reactive getter 回傳前會呼叫 `isRef(value)`，也就是讀 `value.__v_isRef` |
| `https://player.twitch.tv/js/embed/v1.js` | `ab58dfe3c496f0b6ab2e2d4399257a2bb45b17ea0330aa50789c5ae142cce02f` | UMD 結尾 `e.Twitch=t()`（`e=globalThis`，是賦值，所以 setter 攔得到）。`Player` 是 ES class，`READY` 等常數是從父類 `Embed` 繼承的 static。內部 `_player._embedWindow = iframe.contentWindow`。`_sendCommand(e,t)` 是 `this._embedWindow.postMessage({eventName:e,params:t,namespace:"twitch-embed-player-proxy"},"*")`，`SetMuted` 的 enum 值是 `10`。`_handleResponses` 第一行就讀 `this._embedWindow`，條件是 `source === this._embedWindow`、`namespace:"twitch-embed-player-proxy"`、`eventName:"UPDATE_STATE"`，成立時 `this._playerState = Object.assign({}, this._playerState, t.params)`（產生**新物件**，`params` 合併進去）。預設 state 常數含 `muted:!1`、`volume:0`、`playback`。`getMuted()` 回傳 `_playerState.muted`，所以預設是 `false` |

推得的機制：`render()` 時 iframe 還是 same-origin 的 `about:blank`，所以 Holodex 賦值當下不會丟錯；iframe 導到 `player.twitch.tv` 後，同一個 `WindowProxy` 變成跨網域，之後任何人讀 `_embedWindow`，都會經過 Vue getter 的 `isRef()` 而丟 SecurityError。這跟主控台的 `_.get [as _embedWindow] (vendor.js) at _._handleResponses (v1.js)` 一致。結果：`getMuted()` 永遠是 `false`；`setMuted()`、`play()`、`setChannel()` 都在送出前就丟錯，Holodex 自己的 mute watcher 也一樣。

### fix-4 程式碼裡的對應位置

1. `src/pages/content/holodex/audio-lock/players.ts:74-87`（`bindTwitch`）：直接用 SDK 的 `getMuted`／`setMuted`。`:108-113` 把 `false` 當成「已知：沒靜音」，所以壞掉的 SDK 被當成「Twitch 自己取消靜音」。
2. `players.ts:252-264`（`mute`）：`setMuted(true)` 同步丟 SecurityError，被 `callMaybePromise`／`withTimeout` 轉成 `ok:false`。
3. `controller.ts:265-282`：每次 `ok:false` 就把 `consecutiveFailures` 加 1，到 3 次呼叫 `failSession("player-unavailable")`（`:279-281`）。`state.ts:597-608` 的 `MUTE_SENT` 同時累加 `unsettledMuteCount`，`state.ts:678-697` 到 3 次就以 `player-mute-did-not-settle` 進 degraded。**修正一點：** 依程式碼時序，通常是 `player-unavailable` 先到；`player-mute-did-not-settle` 是同一條路的另一個出口。兩個出口都要對 Twitch 封住。`controller.ts:537-555` 讀取 timeout／丟錯的計數也是同樣的出口。
4. `controller.ts:138-151`（`failSession`）、`:367-373` → `:909-950`（`teardownSession`）：degraded 時把所有 cell 的 wrapper 拆掉，Holodex 原生 `manualCheckMuted` 就回來了。`controller.ts:611-613` 在 degraded 時也直接呼叫原生方法。
5. Holodex 原生 `manualCheckMuted` 讀 `isMuted()`，拿到永遠是 `false` 的值；格子是 `muted=true`，所以被當成「使用者取消 Twitch 靜音」→ `setMuted(false)` → `muteOthers(Twitch)` → YouTube 的 store 變成 `muted=true`。Twitch 的 watcher `setMuted(false)` 又丟錯，所以 Twitch 實際上還是靜音，每秒輪詢都重複一次。這就是 Fi 看到的「Twitch 靜音、YouTube 一直被關掉」。

根因描述大致正確。補充兩點：(a) degraded 的代碼依時序多半是 `player-unavailable`；(b) Holodex 的 Twitch 是 `autoplay:false`。協調者 00:3x 實測：對 iframe 內 `<video>` 呼叫 `play()` 不會開始播（`readyState` 一直是 0、`currentSrc` 空），要用受信任滑鼠點播放器自己的播放鈕才會開始。「Twitch 一直靜音」比較可能是指令全部失效的副作用，不是鎖成功；真直播 e2e 要記錄 Twitch `<video>` 的 `paused`／`readyState` 來確認。

**iframe 狀態是獨立的讀取來源：** Twitch iframe 自己會對父頁 postMessage `UPDATE_STATE`；壞掉的是 SDK 的接收端（`_handleResponses` 讀 `_embedWindow` 丟錯），不是 iframe 送出。所以我們在頂層 window 自己掛一個 `message` listener，驗證 `origin`、`source`、`namespace`、`eventName`、`params.muted` 型別後記住最新狀態，就能在 SDK 壞掉時讀到 Twitch 的真實靜音狀態。iframe 在 SDK 壞掉時是否照常送 `UPDATE_STATE`、送的頻率，都**未驗證**，由真直播情境 g 記錄。

### MVP 為什麼反向切換失敗（讀 `mvp-holodex-inject.js` 確認）

MVP 沒有標 `__v_skip`，所以 SDK 一樣是壞的。使用者取消 YouTube 靜音時，Holodex 的 `muteOthers(YouTube)` 把 Twitch 的 store 設成 `muted=true`，Twitch watcher 呼叫 `this.player.setMuted(true)` 丟錯。MVP patch 過的 `manualCheckMuted` 讀 `isMuted()` 拿到 `false`，跟格子的 `true` 不一致，又沒有使用者意圖，就呼叫 `r.setMute(true)`，同樣丟錯，被 `catch` 吞掉，只印出 "re-mute failed"。所以 Twitch 一直有聲。這跟協調者的推測一致（只從程式碼確認，還沒在真 iframe 上看過）。

## 修法比較

| 方案 | 做法 | 結論 |
| --- | --- | --- |
| A. 修好 SDK（`__v_skip`） | 在 `Twitch.Player` 建構包裝裡，Holodex 賦值前於實例標不可列舉的 `__v_skip=true`。Vue 2.7.8 的 `observe()` 看到就跳過，`_embedWindow` 保持一般屬性，SDK、Holodex watcher、`play()` 全都恢復 | **採用為主修法**：一行就修到根因，連 Holodex 自己的呼叫一起修好。反向切換因為 Holodex watcher 恢復，可以在 1 秒內完成 |
| B. 自己走 iframe 管道 | 不經過 SDK：用 DOM 找 `player.twitch.tv` iframe，指令直接 `contentWindow.postMessage({eventName:10, params:bool, namespace:"twitch-embed-player-proxy"}, "https://player.twitch.tv")`；狀態由自己的 `message` listener 接收、驗證 iframe 的 `UPDATE_STATE` | **採用為備案**：在偵測到實例已被 Vue 觀察（例如擴充在播放器建立後才注入、Vue 不認 `__v_skip`），或 SDK 缺 `getMuted`／`setMuted` 時使用。讀得到 iframe 狀態時，選聲、取消靜音的切換、反向切換、靜音確認都走既有狀態機，行為和 SDK 正常時相同。格式依據上表的 v1.js，真直播情境 g 必須在真 iframe 上證明有效 |
| C. 以 MVP 為底重寫 | 丟掉 fix-4 狀態機，回到 MVP 結構，再加 `__v_skip` 和反向切換 | 不採用：fix-4 的 BINDING_REBOUND、bootstrap、store 收斂、128 個測試都要重來，fix-3 和 fix-4 驗收過的行為要重新證明，改動比 A＋B 大很多 |
| D. 重建 iframe | 對要靜音的 Twitch iframe 帶 `muted=true` 重新載入 | 不採用：畫面閃爍、直播重新緩衝、可能再出廣告；只在 A、B 都在真 iframe 上失敗時才考慮，列入「待 Fi 決定」 |

`__v_skip` 的取捨：
- **為什麼可以用：** Vue 2.7.8 的 `observe()`、深層 watcher 的 `traverse()`，看到 `__v_skip` 都會跳過。Holodex 對 `player` 沒有 deep watch，模板也不讀 `player` 的內容（TwitchPlayer 模板只有一個 `div`）。`data.player` 本身仍是 reactive 欄位，賦值、`delete this.player`（`beforeDestroy`）照常運作；它的 getter 讀 `instance.__v_isRef` 只會拿到 `undefined`。VideoCell 透過 `playerReady` 存進 `twPlayer` 時一樣會被跳過。
- **副作用要在真直播 e2e 確認：** mute watcher（store 改變 → `setMuted` 真的生效）、`ready` 事件與 `setQuality`、`play`／`pause`／`ended` 事件、刪除 Twitch 格（`destroy()`）、reload；換頻道（`setChannel` watcher）有第二台直播時才測，只記錄、不擋驗收。
- **保險：** 如果 Vue 版本不認 `__v_skip`，或實例在攔截前就建好了，實例上會有 `__ob__`。PlayerPort 用這一點判斷 SDK 不可信，自動切到備案 B。備案 B 是必須通過的行為，不是選配：真直播情境 g 會刻意讓 guard 失效，重現被 Vue 觀察的實例。

## Global Constraints

- 禁止 push、開 PR、merge（不合併任何分支、不碰 remote）、公證（notarize）、sudo；不建立或切換分支。
- 所有寫入限於本 worktree；commit 寫入主 repo 的 Git metadata 屬允許範圍。禁止刪除 worktree 以外的任何東西。Chrome 暫存 profile 一律放 `.cache/e2e-browser/`，結束時刪除。**不碰 Fi 的 Vivaldi 或 Chrome profile。**
- **真直播瀏覽器測試一律在 M5 上跑**（本 worktree 所在、有登入桌面 session 的機器；Fi 2026-10-18 00:56 指示）。不准在 M1 跑；M1 只用來放最後的 zip（不在本輪）。不碰 Microlife／Chorus 專案，不碰 Orca 的安裝。
- 快取：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；yarn 一律用 `npx --yes yarn@1.22.22`，安裝用 `--frozen-lockfile`。
- **不新增 dependency**；`yarn.lock` 不得變動。`package.json` 只允許新增一個 script `e2e:audio-lock:live`。
- 產品 commit 訊息只用英文，Conventional Commits。
- 不動 fix-3 的建置修正：`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**` 一律不改。新模組由 `holodex-inject.ts` 的 import 鏈打進同一個 classic IIFE。
- 產品程式碼**只**允許改：`audio-lock/contracts.ts`、`audio-lock/state.ts`、`audio-lock/controller.ts`、`audio-lock/players.ts`、`audio-lock/holodex-adapter.ts`（只新增一個 export `readMuteOthersHint`）、`twitch-audio-lock.ts`，以及新增 `audio-lock/twitch-embed.ts`。`holodex-inject.ts`、`audio-lock-settings.ts`、`contentScript.ts`、`src/utils/**` 不動。
- `TIMING` 常數不改（`USER_INTENT_MS` 維持 2500）。
- `docs/plans/evidence/**`、`.ref/` 唯讀。`tests/e2e-browser/audio-lock/fakes.js` 保持和 `docs/plans/evidence/twitch-audio-lock-fix-3/harness/fakes.js` 逐位元相同。
- MVP 擴充 `/Applications/Extensions/holodex-plus-audiolock-chrome`（M5 上，規劃時 2026-10-18 確認存在）只能透過 CDP `Extensions.loadUnpacked` 唯讀載入，不能修改、移動或寫入。若執行時 M5 上沒有這個資料夾：`docs/plans/evidence/twitch-audio-lock-fix-5/mvp-holodex-inject.js` 只有頁面腳本，不能單獨載入成擴充；此時停下 MVP 對照，請協調者把完整 MVP 資料夾放到 `docs/plans/evidence/twitch-audio-lock-fix-5/mvp-ext/`（協調者提交，實作者與驗收者唯讀），再從那裡唯讀載入，報告寫明實際路徑與 `find … -type f -exec shasum {} +` 結果。
- Twitch embed 的 postMessage 格式與 `UPDATE_STATE` 驗證只有一處定義（`twitch-embed.ts`），其他檔案不得硬寫 `"twitch-embed-player-proxy"`、`"UPDATE_STATE"` 或 `10`。

## 回合與額度上限

- fix-5 系列的失敗計數**從 0 開始**。實作最多 3 輪（Cursor 實作 → Codex 驗收算 1 輪），驗收 FAIL 累計 3 次就停止，不開下一輪，由協調者回報 Fi。
- **Cursor 每輪**：工作時間上限 90 分鐘；e2e 合計最多 10 次（假播放器 `run.mjs` 與真直播 `live.mjs` 都算，含 fallback 模式，SKIP 也算）；`yarn build` 最多 6 次。必跑：假播放器 3、真直播 normal 3、真直播 fallback 1、MVP 1，共 8 次，剩 2 次給重試。
- **Codex 每輪**：驗收上限 60 分鐘；e2e 合計最多 8 次（同樣 3＋3＋1＋1，不留重試；任一次 FAIL 即判 FAIL）。
- 每次真直播 e2e 本身有 300 秒全域逾時；外層再包 320 秒。
- 超過上限就停在目前狀態寫報告，不硬做。
- 若真 iframe 上 `__v_skip` 沒有讓 SDK 恢復（`twitchObserved=true`，或 `__v_isRef` 錯誤還在），**不要**自己改成方案 D。照實寫進報告「新發現」，再看備案 B 的情境結果。
- 若 fallback 模式下 iframe 一直沒送 `UPDATE_STATE`，或 postMessage 指令在真 iframe 上沒效，同樣不要自己改方案；情境 g 判 FAIL，寫進「新發現」，由協調者回報 Fi。

## Review Focus

1. **擴充比 Holodex 晚注入，或 Twitch 播放器已經先建好了**：實例已被 Vue 觀察，SDK 是壞的。不可以把 `getMuted()` 的 `false` 當真，也不可以進 degraded；但使用者在 Twitch 播放器自己的 UI 取消靜音仍要切到 Twitch，之後反向切換仍要成立 → 任務 2 的 `twitch_vue_observed_read_is_untrusted`、`twitch_vue_observed_read_uses_iframe_state`，任務 3 的 `broken_twitch_poll_never_degrades_or_warns`、`broken_twitch_user_unmute_in_iframe_switches_then_reverse`，真直播情境 g。
2. **備案的第一次送出失敗，或送出了但播放器沒套用**：失敗不能把整個 epoch 記成「已靜音」；讀得到 iframe 狀態時要一直重送到確認靜音 → 任務 3 的 `mute_sent_failure_keeps_epoch_retryable`、`untrusted_failed_post_is_retried_after_cooldown`、`iframe_state_mute_not_applied_keeps_retrying_until_confirmed`。
3. **Twitch SDK 契約不符（READY 後缺 `getMuted`／`setMuted`）**：不能 `failSession`、不能拆 wrapper 讓原生 `manualCheckMuted` 接手 → 任務 3 的 `twitch_missing_sdk_methods_never_falls_back_to_native`。
4. **Twitch 第一筆 UPDATE_STATE 到達前**：SDK 正常，但 `getMuted()` 還是預設的 `false`，不能拿來判斷「使用者取消靜音」→ 任務 2 的 `twitch_read_before_first_state_update_is_not_ready`。
5. **Twitch 一直不理靜音指令（廣告、播放器重載）**：SDK 正常，但讀到的仍是沒靜音。只能繼續依冷卻時間重送，不能降級、不能動 YouTube → 任務 3 的 `healthy_twitch_ignoring_mute_does_not_degrade`。
6. **只用 Holodex 面板以外的方式切回 YouTube**：使用者點 YouTube iframe 自己的靜音鈕取消靜音，也要觸發反向切換 → 任務 3 的 `reverse_switch_youtube_iframe_intent_mutes_twitch`，以及真直播情境 c 的 iframe 回合。
7. **偽造的 `message`**：其他 frame 或頁面腳本送假的 `UPDATE_STATE`，不能被當成 Twitch 狀態 → 任務 1 的 `twitch_state_listener_rejects_untrusted_messages`。
8. **設定關閉或 Mute Others 關閉時**：不應把 Twitch 預設成靜音，回到 Holodex 原生行為；`__v_skip` 仍然要標 → 任務 1 的 `guard_defaults_muted_true_only_when_lock_may_apply`。

---

## 檔案

| 檔案 | 動作 | 用途 |
| --- | --- | --- |
| `src/pages/content/holodex/audio-lock/twitch-embed.ts` | 新增 | 所有 Twitch embed 知識：`window.Twitch.Player` 建構攔截（`muted` 預設、`__v_skip`、記錄初始 state 參照）、`isVueObserved`、`isTwitchStateFresh`、`postTwitchSetMuted`、iframe `UPDATE_STATE` listener（`installTwitchStateListener`／`readTwitchIframeState`） |
| `src/pages/content/holodex/twitch-audio-lock.ts` | 修改（第 21–41 行附近） | 頂層 frame 先安裝 guard 與 state listener，再建 controller；記錄最後收到的設定值 |
| `src/pages/content/holodex/audio-lock/holodex-adapter.ts` | 修改（只新增 export） | `readMuteOthersHint(doc)`：同步讀 store 的 `muteOthers`，讀不到就回 `undefined` |
| `src/pages/content/holodex/audio-lock/contracts.ts` | 修改（`ReadMuted` 第 14–16 行、`CellRuntime` 第 54–64 行、`LockEvent` 第 103–163 行） | `ReadMuted` 新增 reason `"untrusted"`；`CellRuntime` 新增 `lastMuteEpoch`；`MUTE_SENT` 新增選填 `ok`；新增事件 `UNTRUSTED_POLL`；新增 `failuresDegrade(identity)` |
| `src/pages/content/holodex/audio-lock/players.ts` | 修改（`bindTwitch` 第 74–87 行、`tryBind` 第 190–205 行、`readMuted`／`mute`／`restoreSelectedAudio` 第 227–289 行） | Twitch 讀取的可信度判斷；SDK 不可信、丟錯或缺方法時，讀取改看 iframe 狀態，靜音／恢復改走 postMessage |
| `src/pages/content/holodex/audio-lock/state.ts` | 修改（`emptyCellRuntime`、`MUTE_SENT` 第 597–608 行、`OBSERVED_MUTED` 第 678–697 行、新增 `UNTRUSTED_POLL` case） | Twitch 不降級；送出失敗不鎖 epoch；完全讀不到狀態時每個 epoch 成功盲靜音一次 |
| `src/pages/content/holodex/audio-lock/controller.ts` | 修改（第 258–282 行、`maybeRestoreGrant` 第 396–416 行、`onContractMismatch` 第 514–519 行、`reconcileCell` 第 537–555 行、`muteOthers` wrapper 第 659–687 行、`armBootstrapFallback` 第 444–469 行） | Twitch 失敗與契約不符不計數、不降級；`MUTE_SENT` 帶 `ok`；不可信讀取送 `UNTRUSTED_POLL`；bootstrap 時 Twitch 首播不搶選聲 |
| `tests/audio-lock/fixtures.ts` | 修改 | `createTwitchSdk` 新增 `brokenByVue`；`createFakeVideoCell`／`setupEnv` 新增 `nativeCheckMuted`；watcher 套 try/catch；新增 `postTwitchUpdateState(iframe, params)` helper 模擬 iframe 送出 |
| `tests/audio-lock/twitch-embed.test.ts` | 新增 | guard、postMessage 格式、`UPDATE_STATE` listener 的驗證 |
| `tests/audio-lock/twitch-broken.test.ts` | 新增 | 真實故障的 controller 層級重現（修正前 FAIL）、備案的選聲與重試、契約不符、反向切換、bootstrap |
| `tests/audio-lock/players.test.ts`、`state.test.ts` | 修改（新增測試） | Twitch port 與 state 新行為 |
| `tests/audio-lock/controller.test.ts`、`players.test.ts`、`state.test.ts` | 修改（既有測試換 provider 或改 Twitch 預期，逐條列在任務 3） | 原本用「Twitch 失敗／契約不符」來觸發 degraded 的生命週期測試，改用 YouTube 觸發；Twitch 契約不符的 port 預期改成 iframe 管道 |
| `tests/e2e-browser/audio-lock/live.mjs` | 新增 | 真 Twitch＋真 YouTube 直播、M5 有畫面 Chrome、CDP 進 iframe 讀 `<video>`；`normal` 與 `fallback` 兩種模式 |
| `tests/e2e-browser/audio-lock/live-compare.mjs` | 新增 | 把多份 live 結果排成並列表 |
| `tests/e2e-browser/README.md` | 修改 | 說明真直播 e2e |
| `package.json` | 修改（只新增 script） | `"e2e:audio-lock:live": "node tests/e2e-browser/audio-lock/live.mjs fix dist_chrome .cache/e2e-browser/live-fix.json"` |
| `docs/plans/reports/twitch-audio-lock-impl-6.md`、`docs/plans/reports/e2e-fix5/` | 新增 | 實作報告與原始 JSON |

---

## 步驟

### 任務 1：Twitch.Player 建構攔截（`twitch-embed.ts`）

**Interfaces：**
- Produces（`audio-lock/twitch-embed.ts`）：
  - `export const TWITCH_PLAYER_ORIGIN = "https://player.twitch.tv"`
  - `export function installTwitchPlayerGuard(win: Window, shouldDefaultMute: () => boolean): void`
  - `export function isVueObserved(instance: object): boolean`
  - `export function isTwitchStateFresh(instance: object): boolean | null`（`null` 代表這個實例沒經過 guard）
  - `export function postTwitchSetMuted(iframe: HTMLIFrameElement | null | undefined, muted: boolean): boolean`
  - `export function installTwitchStateListener(win: Window, now: () => number): void`
  - `export function readTwitchIframeState(iframe: HTMLIFrameElement | null | undefined): { muted: boolean; volume: number | null; receivedAt: number } | null`
- Produces（`holodex-adapter.ts`）：`export function readMuteOthersHint(doc: Document): boolean | undefined`

- [ ] **Step 1：寫失敗測試 `tests/audio-lock/twitch-embed.test.ts`**（每個測試前後還原 `window.Twitch` 的 descriptor）
  - `guard_wraps_twitch_assigned_after_install`：先 install，再 `window.Twitch = { Player: FakeCtor }`；`new window.Twitch.Player("el", { channel: "c" })` 讓 FakeCtor 收到 `opts.muted === true`、`opts.channel === "c"`。
  - `guard_wraps_existing_twitch_global`：先有 `window.Twitch`，再 install；結果同上。重複 install 不會包兩層（FakeCtor 只被呼叫 1 次）。
  - `guard_defaults_muted_true_only_when_lock_may_apply`：`shouldDefaultMute` 回 `false` 時，`opts` 裡沒有 `muted`。
  - `guard_keeps_explicit_muted_option`：呼叫端傳 `muted:false` 時維持 `false`。
  - `guard_marks_instance_v_skip_non_enumerable`：實例 `__v_skip === true`，`Object.keys(inst)` 不含它。
  - `guard_preserves_statics_prototype_and_instanceof`：用 `class Base { static READY = "ready" }`、`class P extends Base {}` 當 Player；包過之後 `Twitch.Player.READY === "ready"`、`inst instanceof window.Twitch.Player`、`Object.getPrototypeOf(inst) === P.prototype`。
  - `twitch_state_fresh_tracks_player_state_replacement`：FakeCtor 有 `getPlayerState()`，回傳 `this._s`；建構後 `isTwitchStateFresh(inst) === false`；把 `inst._s` 換成新物件後是 `true`；有 `getPlayerState` 但沒經過 guard 的物件回 `null`。
  - `post_set_muted_uses_twitch_proxy_message_format`：jsdom iframe 的 `src` 是 `https://player.twitch.tv/?channel=x`，spy `contentWindow.postMessage`；`postTwitchSetMuted(iframe, true)` 回 `true`，呼叫參數完全等於 `({ eventName: 10, params: true, namespace: "twitch-embed-player-proxy" }, "https://player.twitch.tv")`。`src` 是 `https://www.youtube.com/embed/x` 或 `null` 時回 `false`、不呼叫。
  - `is_vue_observed_detects_ob_on_instance_or_inner_player`：實例自身有 own `__ob__`，或 `inst.getPlayer()` 回傳的物件有 own `__ob__`，都回 `true`；都沒有回 `false`；`getPlayer` 丟錯時回 `true`。
  - `twitch_state_listener_accepts_valid_update_state`：install listener 後，對 `window` dispatch `new MessageEvent("message", { origin: "https://player.twitch.tv", source: iframe.contentWindow, data: { namespace: "twitch-embed-player-proxy", eventName: "UPDATE_STATE", params: { muted: true, volume: 0.5 } } })`；`readTwitchIframeState(iframe)` 回 `{ muted: true, volume: 0.5, receivedAt: <now> }`。之後只送 `params: { currentTime: 3 }`（沒有 `muted`）時，保留上一筆的 `muted`（照 SDK 的合併語意）。另一個 iframe 回 `null`。重複 install 不會重複計數。
  - `twitch_state_listener_rejects_untrusted_messages`：以下各送一次，`readTwitchIframeState` 都維持 `null`：`origin` 是 `https://evil.example`；`source` 是 `window` 自己或另一個 iframe 的 `contentWindow`（而該 iframe `src` 不是 Twitch）；`namespace` 錯；`eventName` 不是 `UPDATE_STATE`；`params` 不是物件；`params.muted` 不是 boolean 且之前沒有紀錄；`data` 是字串。
- [ ] **Step 2：跑測試確認 FAIL**
  `npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/twitch-embed.test.ts`。Expected：模組不存在，全部 FAIL。
- [ ] **Step 3：實作 `twitch-embed.ts`**
  - 包裝用 `new Proxy(OriginalPlayer, { construct(target, args, newTarget) })`，不要像 MVP 那樣複製 own properties，靜態常數才能透過繼承保留。在 construct 裡把 `args[1]` 淺拷貝；`muted === undefined && shouldDefaultMute()` 時設成 `true`；`Reflect.construct(target, args, newTarget)`；在實例上 `Object.defineProperty(inst, "__v_skip", { value: true, configurable: true })`（try/catch）；用模組層級的 `WeakMap` 記住 `inst.getPlayerState?.()` 的初始參照。已包過的 Player 用 `WeakSet` 判斷，避免重複包。
  - 安裝：`win.Twitch` 已存在就把 `Player` 換成包過的（屬性不可寫時，比照 MVP 換成淺拷貝的新物件）。不存在就用 `Object.defineProperty(win, "Twitch", { configurable: true, enumerable: true, get, set })`，setter 收到值時包裝。defineProperty 失敗時只 `console.warn("[Holodex+ AudioLock]", { code: "twitch-guard-unavailable", adapterVersion: 1 })` 一次。
  - `isTwitchStateFresh`：`getPlayerState` 不是 function 回 `true`；沒有 WeakMap 記錄回 `null`；否則回「目前參照 !== 初始參照」。整段 try/catch，丟錯回 `false`。
  - `postTwitchSetMuted`：檢查 `new URL(iframe.src).origin === TWITCH_PLAYER_ORIGIN`，再呼叫 `iframe.contentWindow.postMessage(msg, TWITCH_PLAYER_ORIGIN)`；丟錯回 `false`。檔頭註解寫明格式來源（v1.js `_sendCommand`、`SetMuted=10`、`_handleResponses`），並標「以 fix-5 真直播情境 g 結果為準」。
  - `installTwitchStateListener`：用模組層級旗標避免重複安裝；`win.addEventListener("message", handler)`，不隨 `dispose()` 移除（和 guard 一樣是頁面生命週期）。handler 依序檢查：`event.origin === TWITCH_PLAYER_ORIGIN`；`event.source` 是物件；`data` 是物件、`data.namespace === "twitch-embed-player-proxy"`、`data.eventName === "UPDATE_STATE"`、`data.params` 是物件。通過後用 `WeakMap<object, State>`，以 `event.source`（iframe 的 `WindowProxy`，跨網域也能當 key、比較 identity）為 key 合併：`muted` 是 boolean 才更新，`volume` 是有限數字才更新，`receivedAt = now()`；第一次沒有 boolean `muted` 的訊息不建立紀錄。整段 try/catch，丟錯就忽略。
  - `readTwitchIframeState(iframe)`：`iframe.src` 的 origin 必須是 `TWITCH_PLAYER_ORIGIN`，再用 `iframe.contentWindow` 查 WeakMap；任何一步失敗回 `null`。因為 key 是「這個 iframe 的 contentWindow」，假訊息即使通過 origin 檢查（只有 `player.twitch.tv` 本身能做到），也只會寫到它自己的 key，不會影響別的格。iframe 被移除重建時 contentWindow 是新的，舊紀錄自然失效。
- [ ] **Step 4：`holodex-adapter.ts` 新增 `readMuteOthersHint`**：從 `doc.querySelector("#app")?.__vue__?.$store?.state?.multiview?.muteOthers` 取值，是 boolean 才回傳，其他情況或丟錯都回 `undefined`。
- [ ] **Step 5：`twitch-audio-lock.ts` 安裝 guard 與 listener**：在 `w.top !== w` 判斷**之後**、`__HDX_AUDIO_LOCK_HANDLE__` 檢查之前呼叫 `installTwitchPlayerGuard(w, () => lastEnabled !== false && readMuteOthersHint(w.document) !== false)` 和 `installTwitchStateListener(w, () => Date.now())`。`lastEnabled: boolean | null` 初值 `null`，在 `onMessage` 收到 config 和 `handle.setEnabled` 時更新。guard 不隨 `dispose()` 移除（整個頁面生命週期有效，報告寫明）。
- [ ] **Step 6：跑 Step 2 的指令**。Expected：11 passed。若 jsdom 的 `MessageEvent` 不接受 iframe `contentWindow` 當 `source`，改用 `Object.defineProperty(event, "source", …)` 建事件，寫進報告「偏離」。
- [ ] **Step 7：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/twitch-embed.ts src/pages/content/holodex/audio-lock/holodex-adapter.ts src/pages/content/holodex/twitch-audio-lock.ts tests/audio-lock/twitch-embed.test.ts
  git commit -m "fix(audio-lock): construct Twitch players muted and outside Vue reactivity"
  ```

### 任務 2：Twitch PlayerPort 不信任壞掉的 SDK

**Interfaces：**
- Consumes：任務 1 的 `isVueObserved`、`isTwitchStateFresh`、`postTwitchSetMuted`、`readTwitchIframeState`。
- Produces：`ReadMuted` 的 reason 多一個 `"untrusted"`（`contracts.ts`）。`createPlayerPort` 簽章不變。

Twitch port 的管道選擇（只寫在 `players.ts` 一處）：

| 條件 | 讀取 | 靜音／恢復 |
| --- | --- | --- |
| SDK 有方法、沒被 Vue 觀察 | SDK（第一筆 state 之前回 `not-ready`） | SDK；同步丟錯時改 postMessage |
| 被 Vue 觀察，或 READY 後缺 `getMuted`／`setMuted`，**而且**有 iframe 狀態 | iframe 狀態 → `{ kind: "known", muted }` | postMessage |
| 同上，但還沒有 iframe 狀態 | `{ kind: "unavailable", reason: "untrusted" }`（盲靜音） | postMessage |
| 找不到 Twitch iframe | `untrusted` | 回 `false`（可重試） |

- [ ] **Step 1：fixtures**：`createTwitchSdk` 新增 `brokenByVue?: boolean`。為 `true` 時，在 sdk 上定義不可列舉的 own `__ob__: {}`；`getMuted` 永遠回 `false`；`setMuted` 一律 `throw new DOMException("Blocked a frame with origin", "SecurityError")`，但仍要累加 `muteCalls`／`unmuteCalls`。另外把 fixture 的 `applyMuteProp` 包 try/catch，模擬 Vue watcher 的 errorHandler 吞錯。新增 `postTwitchUpdateState(iframe, params)`：對 `window` dispatch 任務 1 測試同格式的 `MessageEvent`（只在測試裡寫字串常數，src 仍只有 `twitch-embed.ts` 一處）。
- [ ] **Step 2：在 `players.test.ts` 新增失敗測試**
  - `twitch_vue_observed_read_is_untrusted`：`brokenByVue` 的 port、沒送過 `UPDATE_STATE`，`readMuted()` 回 `{ kind: "unavailable", reason: "untrusted" }`，而且不呼叫 `getMuted`（spy 次數 0）。
  - `twitch_vue_observed_read_uses_iframe_state`：同上，再對該格 iframe 送 `postTwitchUpdateState(iframe, { muted: true })`，`readMuted()` 回 `{ kind: "known", muted: true }`；再送 `{ muted: false }` 回 `{ kind: "known", muted: false }`；`getMuted` spy 仍是 0。對**另一格** iframe 送的狀態不影響這格。
  - `twitch_missing_sdk_methods_uses_iframe_channel`：sdk 刪掉 `getMuted`、`setMuted`，READY；`onContractMismatch` 仍被呼叫 1 次（給 controller 決定要不要降級）；沒有 iframe 狀態時 `readMuted()` 回 `untrusted`；`mute()` 回 `true` 並 postMessage `params: true` 1 次；送 `{ muted: true }` 後 `readMuted()` 回 `known/true`。
  - `twitch_vue_observed_mute_posts_to_iframe`：`mute()` 回 `true`；fixture player `$el` 裡 iframe 的 `contentWindow.postMessage` 收到 `params: true` 1 次；sdk `setMuted` 沒被呼叫。
  - `twitch_setMuted_throw_falls_back_to_postmessage`：sdk 沒有 `__ob__`，但 `setMuted` 丟 SecurityError；`mute()` 回 `true`，postMessage 1 次。
  - `twitch_vue_observed_restore_posts_unmute_once`：符合條件的 grant 讓 `restoreSelectedAudio` 送 `params: false` 1 次；同一個 grant 第二次回 `false`、不再送。
  - `twitch_read_before_first_state_update_is_not_ready`：用任務 1 的 guard 建立一個有 `getPlayerState`、`getMuted` 回 `false` 的假 Player；第一筆 state 換掉之前，`readMuted()` 回 `{ kind: "unavailable", reason: "not-ready" }`；換掉之後回 `{ kind: "known", muted: false }`。
- [ ] **Step 2b：修改既有 `ready_instance_missing_methods_reports_mismatch` 的 Twitch 那一半**：`mismatch === 1` 維持；`readMuted()` 的預期從 `access-error` 改成 `{ kind: "unavailable", reason: "untrusted" }`（Twitch 契約不符改走 iframe 管道，見審查回應第 3 條）。YouTube 那一半完全不動。寫進報告「既有測試修改」表。
- [ ] **Step 3：跑 `npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/players.test.ts`**。Expected：7 個新測試與改過的那一條 FAIL，其餘既有測試全過。
- [ ] **Step 4：實作 `players.ts`**
  - 只有 Twitch 會這樣處理（YouTube 不變）。照上方「管道選擇」表：`tryBind` 在 Twitch 缺方法時仍呼叫 `reportMismatchOnce()`，但不設 `mismatched`，而是把 port 標成 iframe 管道（YouTube 照舊設 `mismatched`）。`readMuted`：iframe 管道或 `isVueObserved(instance)` 時，不碰 SDK，回 `readTwitchIframeState(iframe)` 的 `muted`（`known`），沒有紀錄就回 `untrusted`；否則看 `isTwitchStateFresh(instance) === false` 回 `not-ready`；其他照舊。
  - Twitch `mute`／`unmute`：iframe 管道或 `isVueObserved` 時直接 `postTwitchSetMuted(iframe, v)`；否則先呼叫 SDK，**同步丟錯**時改用 `postTwitchSetMuted`。回傳值只代表「有送出」，不代表已套用；是否套用由下一次讀取（SDK 或 iframe 狀態）確認。iframe 從 `binding.playerComponent.$el?.querySelector("iframe")` 取得（DOM，不經過 Vue）。
  - 檔頭或 `bindTwitch` 上方加一行註解，說明 Vue 會讓 `_embedWindow` getter 丟 SecurityError，以及為什麼改看 iframe 自己送的 `UPDATE_STATE`。
- [ ] **Step 5：跑 Step 3 的指令**。Expected：全過。
- [ ] **Step 6：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/contracts.ts src/pages/content/holodex/audio-lock/players.ts tests/audio-lock/fixtures.ts tests/audio-lock/players.test.ts
  git commit -m "fix(audio-lock): read Twitch state from the iframe when the SDK is unusable"
  ```

### 任務 3：Twitch 失敗與契約不符不降級、備案選聲、失敗可重試、反向切換

**Interfaces：**
- Consumes：任務 2 的 `reason: "untrusted"` 與 iframe 狀態讀取（`known` 結果直接走既有 `OBSERVED_MUTED`，所以 `true → false` 邊緣＋iframe intent 的選聲、反向切換、未套用時依冷卻重送，都沿用 fix-4 狀態機）。
- Produces（`contracts.ts`）：
  - `export function failuresDegrade(identity: CellIdentity): boolean`：回 `identity.provider !== "twitch"`。這是唯一的 provider 政策點，controller 與 state 都呼叫它（含契約不符）。
  - `CellRuntime.lastMuteEpoch: number | null`（`emptyCellRuntime` 初值 `null`）：**只記錄成功送出**的 epoch。
  - `MUTE_SENT` 事件新增選填 `ok?: boolean`（`undefined` 視為 `true`，既有 state 測試不用改）。
  - `LockEvent` 新增 `{ type: "UNTRUSTED_POLL"; now: number; identity: CellIdentity; assignment: MutedAssignment }`。

- [ ] **Step 1：fixtures**：`createFakeVideoCell`／`setupEnv` 新增選項 `nativeCheckMuted?: boolean`（預設 `false`，既有測試不受影響）。為 `true` 時，原生 `manualCheckMuted` 模擬 Holodex VideoCell：`await this.$refs.player.isMuted()`，丟錯就 return，否則 `this.setMuted(!!value)`。並提供 `nativeCheckCalls` 計數。
- [ ] **Step 2：新增 `tests/audio-lock/twitch-broken.test.ts`（修正前要 FAIL）**。共用設定：a＝YouTube（store `muted:false`，YT sdk `muted:false`），b＝Twitch（store `muted:true`，`brokenByVue`），`nativeCheckMuted: true`，enabled，Mute Others 開。用 fake timers，「每秒輪詢」就是每 1000ms 對兩格各呼叫一次 `cell.manualCheckMuted()`（模擬 MediaControls）。
  - `broken_twitch_poll_never_degrades_or_warns`：輪詢 20 秒；`mode` 不是 `degraded`；`console.warn` 呼叫 0 次；a 的 store 一直是 `false`；YT sdk `muteCalls === 0`。
  - `broken_twitch_never_calls_native_manualCheckMuted`：同上 20 秒；b 與 a 的 `nativeCheckCalls === 0`；b 的 `manualCheckMuted` 仍是 patch 過的函式。
  - `untrusted_twitch_is_muted_once_per_selection`：（不送任何 `UPDATE_STATE`，也就是盲靜音模式）20 秒內，b 的 iframe `postMessage(params:true)` **成功**剛好 1 次；之後用可信面板事件選 a 一次（epoch 變了），再輪詢 3 秒，總共變成 2 次。
  - `untrusted_failed_post_is_retried_after_cooldown`：盲靜音模式，b 的 `contentWindow.postMessage` 第一次丟錯、之後正常。開始輪詢後 **2000ms 內**有第二次呼叫而且成功；之後 20 秒內成功呼叫總數是 1；不是 degraded；`console.warn` 0 次；`nativeCheckCalls === 0`。再做一次「iframe 暫時不在」的版本：前 1 秒 `$el` 裡沒有 iframe（`mute()` 回 `false`），iframe 出現後 2000ms 內成功送出 1 次。
  - `iframe_state_mute_not_applied_keeps_retrying_until_confirmed`：b 是 active（a=`true`、b=`false`），iframe 狀態 `{ muted: false }`；面板選 a。之後 3 秒都持續送 `UPDATE_STATE { muted: false }`（播放器沒套用）：postMessage `params:true` 次數 ≥ 2（依 `MUTE_COOLDOWN_MS`／settle 重送）；接著送 `{ muted: true }`，再輪詢 5 秒，`params:true` 次數不再增加；全程不是 degraded、a 的 store 是 `false`。
  - `broken_twitch_user_unmute_in_iframe_switches_then_reverse`：b 是 `brokenByVue`，先送 `{ muted: true }`。對 b 觸發 `IFRAME_INTENT`（照既有 blur/activeElement 做法），送 `{ muted: false }`，輪詢：2000ms 內 active 是 b、store a=`true`、b=`false`、沒有 postMessage `params:true` 給 b。接著面板選 a：2000ms 內 b 收到 `params:true`、active 是 a、store a=`false`／b=`true`；再送 `{ muted: true }` 後 5 秒內不再重送。全程沒有 degraded、`nativeCheckCalls === 0`。另驗反例：沒有 intent 時送 `{ muted: false }`，結果是對 b 重送 `params:true`、active 不變（不把自己的變化當成使用者選聲）。
  - `twitch_missing_sdk_methods_never_falls_back_to_native`：a＝YouTube、b＝Twitch，b 的 sdk 是 `{}`（READY 後缺方法），`nativeCheckMuted: true`。輪詢 20 秒：不是 degraded；`console.warn` 只有 1 次而且 code 是 `twitch-sdk-contract-changed`（不在 degraded 類清單）；a、b 的 `manualCheckMuted`／`setMuted`／`muteOthers` 仍是 patch 過的函式；`nativeCheckCalls === 0`；原 mapped `muteOthers` 沒有在非使用者授權下被呼叫；a 的 store 一直是 `false`；b 的 iframe 收到 `params:true`。
  - `reverse_switch_panel_mutes_broken_twitch_within_2s`：先讓 b 成為 active（store a=`true`、b=`false`，active=b）；在 `beginPanelDispatch(trusted)` 範圍內呼叫 `cellA.setMuted(false)`，然後 `endPanelDispatch`。輪詢 2000ms 內，b 的 iframe 收到 `params:true`；active 是 a；a 的 store 是 `false`、b 是 `true`；沒有 degraded。
  - `reverse_switch_panel_mutes_healthy_twitch_within_2s`：同上，但 b 用一般 `createTwitchSdk({ muted: false })`；2000ms 內 `sdk.rawMuted === true`，YT `rawMuted === false`。
  - `reverse_switch_youtube_iframe_intent_mutes_twitch`：b 是 active 而且 SDK 正常；送 a 的 `IFRAME_INTENT`（照既有測試觸發 blur/activeElement 的做法），把 YT sdk `rawMuted` 設成 `false`，然後輪詢；2000ms 內 active 是 a，Twitch `rawMuted === true`。
  - `healthy_twitch_ignoring_mute_does_not_degrade`：b 用 `createTwitchSdk({ muted: false, ignoreMute: true })`；輪詢 20 秒；不是 degraded；`console.warn` 0 次；a 的 store 一直是 `false`；`sdk.muteCalls >= 3`（照冷卻時間持續重送）。
- [ ] **Step 3：在 `state.test.ts` 新增測試**
  - `twitch_unsettled_mutes_do_not_degrade`：Twitch identity 連 3 次 `MUTE_SENT` 後又觀察到 `muted:false`；結果不是 degraded，effects 含 `MUTE_PLAYER`，不含 `REPORT_ONCE`。
  - `untrusted_poll_mutes_once_per_epoch`：locked、active 是別格；第一次 `UNTRUSTED_POLL` 產生 `MUTE_PLAYER`；`MUTE_SENT { ok: true }` 之後同 epoch 再送，effects 是 `[]`；epoch 加 1 之後再次產生 `MUTE_PLAYER`。
  - `mute_sent_failure_keeps_epoch_retryable`：`MUTE_SENT { ok: false }` 之後，`lastMuteEpoch` 仍是 `null`、`settleUntil` 與 `unsettledMuteCount` 不變、`lastMuteAt` 有更新（冷卻照算）；同 epoch 再送 `UNTRUSTED_POLL` 仍產生 `MUTE_PLAYER`。
  - `untrusted_poll_never_mutes_active_or_unassigned`：active 本身、bootstrap 下 `assignment` 是 `undefined`／`false`、disabled、degraded，effects 都是 `[]`。
- [ ] **Step 4：跑新測試確認 FAIL**
  `npx --yes yarn@1.22.22 vitest run --config vitest.audio-lock.config.ts tests/audio-lock/twitch-broken.test.ts tests/audio-lock/state.test.ts`。Expected：至少 `broken_twitch_poll_never_degrades_or_warns`、`broken_twitch_never_calls_native_manualCheckMuted`、`untrusted_twitch_is_muted_once_per_selection`、`untrusted_failed_post_is_retried_after_cooldown`、`iframe_state_mute_not_applied_keeps_retrying_until_confirmed`、`broken_twitch_user_unmute_in_iframe_switches_then_reverse`、`twitch_missing_sdk_methods_never_falls_back_to_native`、`reverse_switch_panel_mutes_broken_twitch_within_2s`、`healthy_twitch_ignoring_mute_does_not_degrade`，以及 4 個 state 新測試 FAIL。輸出摘要貼進報告。
- [ ] **Step 5：修改既有測試（只換 provider，不改斷言）**。這些測試原本用「Twitch 失敗」當觸發 degraded 的手段，測的是降級生命週期，不是 Twitch 政策。設計改了之後，Twitch 不再降級，所以改用 YouTube 觸發：
  | 測試 | 改法 | 理由 |
  | --- | --- | --- |
  | `controller.test.ts` `degraded_is_not_reinstalled_by_discovery` | b 改成 youtube cell，配 `createYoutubeSdk({ hangRead: true })` | Twitch 讀取逾時不再降級 |
  | `controller.test.ts` `degraded_route_reentry_recovers` | 同上 | 同上 |
  | `controller.test.ts` `route_watch_released_on_disable_and_dispose` | 同上 | 同上 |
  | `controller.test.ts` `route_watch_released_on_dispose` | 同上 | 同上 |
  | `controller.test.ts` `duplicate_enable_keeps_degraded_latch` | 同上 | 同上 |
  | `controller.test.ts` `mute_did_not_settle_degrades_after_three` | b 改成 youtube，配 `createYoutubeSdk({ muted: false, ignoreMute: true })` | Twitch 靜音沒生效不再降級；YouTube 仍要降級 |
  | `state.test.ts` `mute_settle_and_unsettled_count` | 降級那一段的 `b` 改成 `id("b", "youtube")` | 同上；Twitch 版本由 `twitch_unsettled_mutes_do_not_degrade` 覆蓋 |
  | `controller.test.ts` `ready_sdk_missing_methods_degrades` | a、b 都改成 youtube，b 的 sdk 換成 `{}`（`createYoutubeSdk` 的型別） | Twitch 契約不符不再降級（審查回應第 3 條）；YouTube 契約不符仍要 `cell-contract-changed` 降級、拆 wrapper，斷言不變。Twitch 版本由 `twitch_missing_sdk_methods_never_falls_back_to_native` 覆蓋 |
  | `players.test.ts` `ready_instance_missing_methods_reports_mismatch` | 見任務 2 Step 2b（只改 Twitch 那半的 `readMuted` 預期） | 同上 |
  做完先跑一次全套；如果還有其他既有測試因 Twitch 失敗政策變紅（例如 `mute_writes_respect_cooldown_and_settle`、`controller.test.ts` 第 1047 行附近的 stale read 測試），用同樣規則處理：**只**有在測試目的是降級生命週期時才換 provider，並逐條寫進報告的「既有測試修改」表。其他變紅一律視為 bug 修 src，不改測試。
- [ ] **Step 6：實作 state.ts**
  - `MUTE_SENT`：`event.ok !== false` 時照舊 patch，並多 patch `lastMuteEpoch: state.epoch`；`event.ok === false` 時**只** patch `lastMuteAt: event.now`（讓 executor 的 `MUTE_COOLDOWN_MS` 照算），不動 `settleUntil`、`ownMuteGeneration`、`unsettledMuteCount`、`lastMuteEpoch`，所以失敗的嘗試在冷卻後可以重試。
  - `OBSERVED_MUTED` 第 678–697 行：`unsettledMuteCount >= MAX` 的降級分支前面加上 `failuresDegrade(event.identity)` 條件；Twitch 不降級，往下照常送 `MUTE_PLAYER`（冷卻與 settle 由 executor 控制）。
  - 新增 `UNTRUSTED_POLL` case：未啟用、Mute Others 關、`mode` 是 `degraded`／`disabled` 時回空；`desiredMute(...) !== "muted"` 時回空；`cells[key].lastMuteEpoch === state.epoch` 時回空；否則回 `[{ type: "MUTE_PLAYER", identity, epoch: state.epoch }]`。
- [ ] **Step 7：實作 controller.ts**
  - 第 258–282 行：`MUTE_SENT` 帶上 `ok`（先拿到 `ok` 再送事件，順序不變）；`!ok` 時只有在 `failuresDegrade(effect.identity)` 為真時才累加、才 `failSession`。
  - `onContractMismatch` 第 514–519 行：`!failuresDegrade(binding.identity)` 時不 `failSession`，只 `console.warn("[Holodex+ AudioLock]", { code: "twitch-sdk-contract-changed", adapterVersion: 1 })` 一次（用 `reportedCodes` 去重或 controller 層旗標）；wrapper 維持安裝，該格交給任務 2 的 iframe 管道（或盲靜音／可重試）。其他 provider 照舊降級。
  - `reconcileCell` 第 537–555 行：`read.reason === "untrusted"` 時送 `UNTRUSTED_POLL`（assignment 用 `currentAssignment(key)`），然後 return；其他 unavailable 原因在 `!failuresDegrade(identity)` 時直接 return，不計數。
  - `maybeRestoreGrant` 第 396–416 行：讀到 `unavailable/untrusted` 時直接 `await restoreGrant(state.selectionGrant.grant)`（grant 本身只會用一次）。其他原因維持原樣。
- [ ] **Step 8：跑 `npx --yes yarn@1.22.22 test:audio-lock`**。Expected：全過（數字見「測試」段）。
- [ ] **Step 9：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock tests/audio-lock
  git commit -m "fix(audio-lock): never degrade or fall back to native handling on Twitch failures"
  ```

### 任務 4：bootstrap 時 Twitch 首播不搶選聲（MVP 基準）

MVP 在 Mute Others 開著時把 Twitch 格的 `firstPlay` 設成 `false`。fix-4 在 bootstrap 時讓第一個首播的格子（含 Twitch）拿到選聲。以前 SDK 是壞的，Twitch 拿到選聲也送不出 `setMuted(false)`；任務 1 修好 SDK 之後，Twitch 會真的變有聲、YouTube 被靜音。所以要照 MVP 收緊規則。

- [ ] **Step 1：在 `twitch-broken.test.ts` 新增失敗測試**
  - `twitch_first_play_does_not_claim_bootstrap_when_youtube_present`：0＝Twitch、1＝YouTube，都是 `muted:"omit"`，selection 是 bootstrap；`cell0.updatePausedState(false)`；`active` 仍是 `null`；原 mapped `muteOthers` 沒被呼叫；`cell0.firstPlay === false`（原生方法照常更新）。接著 `cell1.updatePausedState(false)`，active 變成 1。
  - `bootstrap_fallback_prefers_non_twitch_cell`：0＝Twitch 在播、1＝YouTube 暫停；1000ms 後 active 仍是 `null`；1 開始播後再過 1000ms，active 是 1。
  - `twitch_only_layout_bootstrap_unchanged`：兩格都是 Twitch 時，第一個首播仍然拿到選聲（保留 fix-4 行為）。
- [ ] **Step 2：跑新測試確認 FAIL**（前兩個 FAIL，第三個 PASS）。
- [ ] **Step 3：實作**：在 controller 加私有 helper `hasNonTwitchBinding(): boolean`（看 `lastBindings`）。`muteOthers` wrapper 的兩個 bootstrap 分支（第 659–687 行）裡，`identity.provider === "twitch" && hasNonTwitchBinding()` 時直接 `return`（吞掉，不呼叫原方法、不送 `NATIVE_FIRST_PLAY`）。`armBootstrapFallback` 迴圈（第 444–469 行）同條件 `continue`。
- [ ] **Step 4：跑 `npx --yes yarn@1.22.22 test:audio-lock`**。Expected：全過。
- [ ] **Step 5：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/twitch-broken.test.ts
  git commit -m "fix(audio-lock): keep Twitch first play from claiming bootstrap audio"
  ```

### 任務 5：真直播 e2e（`live.mjs`）

用法：`node tests/e2e-browser/audio-lock/live.mjs <label> <extensionDir|none> <outJson> [--mode=normal|fallback]`（預設 `normal`）。結構沿用 `run.mjs` 的 CDP pipe 寫法，但**不攔截**任何 Twitch／YouTube 請求。

- [ ] **Step 1：瀏覽器與設定**
  - **只在 M5 跑**（本 worktree 所在、有登入桌面 session 的機器；Fi 00:56 指示）。不在 M1 跑，不碰 Fi 自己的任何瀏覽器 profile，不碰 Microlife／Chorus 專案、Orca 的安裝。
  - 預設**有畫面**的 Google Chrome。協調者 00:3x 在別台實測：真 Twitch／YouTube iframe 在 `--headless=new` 和有畫面 Chrome 都能載入播放器 UI；所以 `HPLUS_E2E_HEADLESS=1` 時改加 `--headless=new`（只供除錯，驗收用的 3＋1＋1 次一律有畫面）。參數：`--user-data-dir=<.cache/e2e-browser/live-prof-*>`（暫存，結束刪除）、`--remote-debugging-pipe`、`--enable-unsafe-extension-debugging`、`--no-first-run`、`--no-default-browser-check`、`--autoplay-policy=no-user-gesture-required`、`--mute-audio`（只關掉喇叭輸出，不影響 `<video>.muted`）、`--window-size=1600,900`。`CHROME` 環境變數可覆寫路徑。
  - 沿用 `run.mjs` 的 service worker 停用腳本。
  - 全域逾時 300 秒。結束時刪 profile（正常、FAIL、例外、逾時都要刪）。
  - 可設定的環境變數：`HPLUS_E2E_TWITCH_CHANNEL`、`HPLUS_E2E_YOUTUBE_ID`、`HPLUS_E2E_TMP`、`HPLUS_E2E_HEADLESS`。
- [ ] **Step 2：挑直播（寫進結果的 `picks`，含挑法）**
  - **預設值**（00:4x 確認可用）：YouTube `1-LpQekNa9g`（Lofi Girl 24/7），Twitch `eslcs`（24/7 重播）。環境變數有設就用環境變數。舊的 `jfKfPfyJRdk` 已不能嵌入、`monstercat` 離線，不要用。
  - 驗證條件：嵌入後 60 秒內 iframe 裡有 `<video>`，而且照 Step 3 的「開始播放」做完後 `!paused && readyState >= 2`、`currentTime` 在增加。預設台不符合時才進挑台規則：
  - Twitch 挑台：在同一個暫存 profile 開 `https://www.twitch.tv/directory/all`，讀前 10 張直播卡片的頻道名（selector 由實作者在真頁面確認，寫進報告）。依序嘗試，**最多 3 台**（含預設台）。遇到成人內容確認頁或離線就換下一台。
  - YouTube 挑台：在 holodex.net 首頁讀目前直播中的卡片（`/watch/<id>` 連結）前 5 台。條件同上（不能嵌入就換下一台），最多 3 台（含預設台）。
  - 找不到可用直播時，結果 `verdict: "SKIP"`，`skipReason` 是 `no-live-twitch` 或 `no-live-youtube`，exit 4。**SKIP 不算 PASS。**
- [ ] **Step 3：判斷聲音的方法（不依賴 SDK）**
  - `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true })`，依 target URL 對應 iframe：`player.twitch.tv/?...channel=<name>` 對 Twitch 格，`youtube.com/embed/<id>` 對 YouTube 格。reload 後重新對應。
  - 在各 iframe session 執行：找 `readyState > 0` 的 `<video>`，回傳 `{ muted, volume, paused, readyState, currentTime, currentSrcEmpty }`。「在播」＝`!paused && readyState >= 2`；`audible = 在播 && !muted && volume > 0.01`。
  - **開始播放**：Holodex 的 Twitch 是 `autoplay:false`，對 iframe 內 `<video>` 呼叫 `play()` **不會**開始（實測 `readyState` 一直是 0、`currentSrc` 空），不要用。改用 `Input.dispatchMouseEvent`（受信任滑鼠）點播放器自己的播放鈕：YouTube `.ytp-large-play-button`；Twitch `button[data-a-target="player-play-pause-button"]`，找不到就點 iframe 畫面中央。座標＝iframe 在頁面的位置＋按鈕在 iframe 內的位置。每次點完播放器，**再點一次頂層頁面的空白處**（不在任何 iframe、不在 Holodex 控制元件上），讓焦點離開 iframe，避免之後的取樣被當成使用者意圖；點擊位置寫進報告。
  - **校準（每次執行的第一步，結果寫進 `calibration`）**：Twitch 透過它自己的 UI 切換一次靜音，確認 `<video>` 的 `muted` 或 `volume` 真的跟著變；YouTube 也做一次。校準失敗時 `verdict: "FAIL"`，`failReason: "truth-method-invalid"`，不往下跑。
  - 每 250ms 取樣：兩格的 `<video>` 狀態、store 的 `layoutContent.<key>.muted`、`muteOthers`。
  - **管道計數（不靠擴充自己回報）**：在 Twitch iframe session 用 `Runtime.evaluate` 掛 `message` listener，計算收到的 `{ namespace:"twitch-embed-player-proxy", eventName:10 }` 指令數與 `params` 值 → `twitchCommandsReceived: { mute, unmute }`；在頂層 session 掛 listener，計算 `origin === "https://player.twitch.tv"` 的 `UPDATE_STATE` 數與最後一筆 `params.muted` → `updateStateMessages`。listener 只計數，不改內容。iframe reload 後重新掛。
- [ ] **Step 4：情境**（每項把取樣、判定、時間點寫進 `scenarios`）
  - **a. YouTube 先播、Twitch 晚到**：開 `https://holodex.net/multiview`；commit `multiview/setLayout`（只有 a）、`setLayoutContent`（a＝YouTube，`muted:false`）、`setMuteOthers(true)`。用 Step 3 的方式點 YouTube 播放鈕、點空白處，等 YouTube 在播後，再 commit 兩格的 layout，並用 `setLayoutContentById` 加入 b＝Twitch（**不帶** `muted`，跟真實新增的路徑一樣），同樣點 Twitch 播放鈕、點空白處。從加入 b 開始取樣 45 秒（點播放鈕後的取樣也算，點 Twitch 播放鈕不能讓 store a 變 `true`）。PASS：Twitch 有開始播（`paused=false`）；YouTube `<video>` 被靜音的取樣數 **0**；store a 是 `true` 的取樣數 0；Twitch 有聲的取樣數 ≤ 4（1 秒內的暫態）；最後一筆是 YouTube 有聲、Twitch 靜音。另外在頁面上找到 `$options.name === "TwitchPlayer"` 的元件，記錄 `twitchObserved = Object.prototype.hasOwnProperty.call(player, "__ob__")`。
  - **b. 使用者點進 Twitch、取消靜音**：滑鼠移到 Twitch iframe 上讓控制列出現，再用 `Input.dispatchMouseEvent`（受信任的輸入）點 Twitch 播放器自己的靜音鈕（座標＝iframe 在頁面的位置＋按鈕在 iframe 內的位置；selector 由實作者確認後寫進報告）。**一定要點靜音鈕，不能點畫面中央**：協調者實測，在 MVP 上點 Twitch iframe 中央會讓 store 變成 a=`true`、b=`false`（YouTube 被靜音），但 Twitch `<video>` 仍然 muted，也就是 SDK 壞掉時「切到 Twitch」本身也可能失敗。PASS：3 秒內 Twitch 有聲、YouTube 靜音，而且之後 3 秒都維持。點完同樣點空白處讓焦點離開。
  - **b′. MVP 觀察項（只在 MVP 執行，只記錄、不判 fix 的 PASS／FAIL）**：情境 a 結束後、b 之前，點一次 Twitch iframe 中央再點空白處，取樣 3 秒，記錄 `centerClickSwitch: { storeA, storeB, twitchVideoMuted, youtubeVideoMuted }`。fix 執行時不做 b′（情境 a 已涵蓋「點 Twitch 播放鈕不能讓 store a 變 `true`」）。
  - **c. 反向切換**：取消 YouTube 靜音。PASS：點擊後 **2000ms 內** Twitch 靜音、YouTube 有聲，之後 5 秒內沒有反彈。b→c 做 **3 輪**：第 1、3 輪用 Holodex 媒體控制面板（受信任點擊，落在 `.media-controls-list` 內，面板開啟方式寫進報告），第 2 輪用 YouTube 播放器自己的靜音鈕（`.ytp-mute-button`，未驗證）。3 輪都要 PASS。
  - **d. reload**：`Page.reload`，等兩格的 `<video>` 都在播（≤ 90 秒），取樣 20 秒。PASS：YouTube 被靜音的取樣數 0；Twitch 有聲的取樣數 ≤ 4；store a 從未是 `true`，b 是 `true`。
  - **e. 主控台**：整段執行期間，在頂層 session 收集 `Runtime.consoleAPICalled` 與 `Runtime.exceptionThrown`。PASS：`[Holodex+ AudioLock]` 警告裡沒有 `player-unavailable`、`player-mute-did-not-settle`、`store-did-not-settle`、`restore-failed`、`cell-contract-changed`。另外記錄 `vIsRefErrors`（訊息含 `__v_isRef` 的 SecurityError 次數）：fix 預期是 0，**不是 0 時算 FAIL**，因為那代表 `__v_skip` 沒生效（除非報告能證明那些錯誤來自 guard 安裝前就建立的播放器）；MVP 只記錄次數，不算失敗。
  - **f. 副作用**：最後刪掉 Twitch 格（commit `multiview/removeLayoutItem` 或用 UI 刪），5 秒內頂層沒有新的未捕捉例外，YouTube 仍有聲。換頻道只在有第二台直播可用時才做，只記錄、不判 PASS／FAIL。
  - **g. 備案（只在 `--mode=fallback`）**：目的是在真 iframe 上證明 SDK 壞掉時的 iframe 管道有效。
    - **製造壞掉的 SDK**：在第一次導到 holodex.net 之前，用 `Page.addScriptToEvaluateOnNewDocument` 加入 `Object.defineProperty(window, "Twitch", { value: undefined, writable: true, configurable: false, enumerable: true })`。不論它和擴充的 document_start 腳本誰先跑，結果都是 guard 失效（擴充先跑時，guard 的 accessor 是 `configurable:true`，會被這行換掉；這行先跑時，guard 的 `defineProperty` 會失敗並警告 `twitch-guard-unavailable`）。v1.js 的 `e.Twitch = t()` 仍能賦值，Holodex 建出來的實例沒有 `__v_skip`，被 Vue 觀察，重現 Fi 回報的壞掉 SDK。這只動測試瀏覽器，不改產品程式碼。
    - **前提檢查**：`twitchObserved === true` 而且 `vIsRefErrors > 0`；不成立就 `verdict: "FAIL"`、`failReason: "fallback-not-triggered"`。
    - 依序跑 a、b、c（3 輪）、e，判準同 normal，但：`twitchObserved` 要是 `true`；a 的 Twitch 有聲取樣數放寬到 ≤ 8（guard 失效時 Twitch 不是以 `muted:true` 建構，要等第一次 postMessage 生效），YouTube 被靜音的取樣數仍然必須是 0；`vIsRefErrors` 只記錄；`twitch-guard-unavailable` 警告允許，其他 `[Holodex+ AudioLock]` degraded 類警告與 `twitch-sdk-contract-changed` 都不允許。真相一律看 iframe `<video>`（Step 3），不看 SDK、不看 postMessage 有沒有呼叫成功。
    - 另外判：c 的每一輪，在使用者取消 YouTube 靜音後 **2000ms 內** Twitch `<video>` 變靜音、YouTube 保持有聲，而且 `twitchCommandsReceived.mute` 有增加（證明走的是 postMessage）；b 的 Twitch 切換是靠 `updateStateMessages` 裡的 `muted:false` 觸發（記錄那筆訊息與 store 變化的時間差）；全程 store a 只有在 Twitch 被使用者選中期間是 `true`；沒有進 degraded（頁面 `__HDX_AUDIO_LOCK_HANDLE__` 的 state 若可讀就記錄 `mode`）。
    - 記錄 `fallbackChannel: { updateStateCount, firstUpdateStateAt, commandsReceived, observedViaIframeState: boolean }`。若 `updateStateCount === 0`，代表 iframe 在 SDK 壞掉時不送狀態，b 一定失敗；照實寫進「新發現」，不自行改方案。
    - fallback 模式不跑 d、f（重點只在備案管道；省額度）。
- [ ] **Step 5：輸出與 exit code**
  - JSON：`{ label, mode, extDir, versions: { chrome, vue }, picks, calibration, scenarios: { a, b, bPrime?, c: [r1, r2, r3], d?, e, f?, g? }, twitchObserved, vIsRefErrors, updateStateMessages, twitchCommandsReceived, fallbackChannel?, audioLockWarnings, verdict, skipReason?, failReason? }`。
  - exit：`0` PASS、`1` FAIL、`4` SKIP、`2` 例外、`3` 全域逾時。逾時發生在情境 a 開始之前，算 SKIP（`skipReason: "env-timeout"`）；在那之後算 FAIL。
  - `live-compare.mjs <json...>`：印出每份結果的 `mode` 與 a／b／c1／c2／c3／d／e／f／g 的 PASS/FAIL/SKIP，加上 `vIsRefErrors`、`twitchObserved`、YouTube 被靜音的取樣數、`twitchCommandsReceived`、`updateStateMessages`，MVP 那份再加 `centerClickSwitch`。只有第一份是 PASS 時 exit 0。
- [ ] **Step 6：README 與 package.json**：在 `tests/e2e-browser/README.md` 新增「Live players」一節（需求：M5、有畫面、網路；`normal`／`fallback` 模式與 fallback 怎麼讓 guard 失效；環境變數與預設直播；挑台規則；開始播放與焦點移開的做法；判斷聲音的方法；SKIP 規則；指令）。`package.json` 新增 `e2e:audio-lock:live` script。
- [ ] **Step 7：lint**：`npx --yes yarn@1.22.22 eslint tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs src/pages/content/holodex/audio-lock/twitch-embed.ts` 0 errors。若專案 eslint 設定本來就跑不起來，照實記錄。
- [ ] **Step 8：Commit**
  ```bash
  git add tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs tests/e2e-browser/README.md package.json
  git commit -m "test(e2e): add live Twitch and YouTube audio lock harness"
  ```

### 任務 6：建置、e2e、並列 MVP、寫報告

- [ ] **Step 1：`npx --yes yarn@1.22.22 typecheck:audio-lock`、`npx --yes yarn@1.22.22 build`、`npx --yes yarn@1.22.22 test:artifacts`**。Expected：都是 exit 0；artifacts 10 pass。
- [ ] **Step 2：假播放器 e2e 連續 3 次**（README 既有的 `for n in 1 2 3` 迴圈，對照 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`）。3 次 `compare.mjs` 都要 exit 0。
- [ ] **Step 3：真直播 e2e（normal）連續 3 次 PASS**（M5）：`node tests/e2e-browser/audio-lock/live.mjs live-fix-$n dist_chrome .cache/e2e-browser/live-fix-$n.json`。重試規則：SKIP 不算數，也不中斷連續；FAIL 就從頭算；每次都計入額度。3 次用同一組 picks（預設 `eslcs`／`1-LpQekNa9g`，或用環境變數固定），換台要寫原因。
- [ ] **Step 3b：真直播 e2e（fallback）1 次 PASS**（M5）：`node tests/e2e-browser/audio-lock/live.mjs live-fix-fallback dist_chrome .cache/e2e-browser/live-fix-fallback.json --mode=fallback`，同一組 picks。和 Step 3 分開記錄、分開判定；Step 3 三次 PASS 不能抵 Step 3b。
- [ ] **Step 4：MVP 真直播 1 次**（M5，normal 模式）：`node tests/e2e-browser/audio-lock/live.mjs live-mvp /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/live-mvp.json`，用跟 fix 同一組 picks；資料夾不存在時照「Global Constraints」的替代路徑。預期 c 失敗，`vIsRefErrors` 每秒數次（協調者已觀察到）。記錄 b′ 的 `centerClickSwitch`（預期 store a=`true`、b=`false` 而 Twitch `<video>` 仍 muted）。若 MVP 的 c 反而 PASS，寫進「新發現」（代表反向切換的根因推測有誤），但不算 fix 的缺陷。
- [ ] **Step 5：`node tests/e2e-browser/audio-lock/live-compare.mjs .cache/e2e-browser/live-fix-1.json .cache/e2e-browser/live-fix-2.json .cache/e2e-browser/live-fix-3.json .cache/e2e-browser/live-fix-fallback.json .cache/e2e-browser/live-mvp.json`**，把並列表貼進報告（只要求第一份 PASS 時 exit 0；其餘逐份看 verdict）。
- [ ] **Step 6：把原始 JSON 存到 `docs/plans/reports/e2e-fix5/`**（`fake-fix-1..3.json`、`live-fix-1..3.json`、`live-fix-fallback.json`、`live-mvp.json`，以及所有 SKIP／FAIL 的那幾次），並在報告列出 SHA-256。
- [ ] **Step 7：寫 `docs/plans/reports/twitch-audio-lock-impl-6.md`**：測試數量（修正前 FAIL 摘要、修正後數字）、typecheck、build、artifacts、假播放器 e2e ×3、真直播 e2e（每次的 mode、picks、秒數、exit code、verdict）、MVP 並列表（含 `centerClickSwitch`）、`twitchObserved`／`vIsRefErrors`、校準結果、開始播放與焦點移開的點擊位置、fallback 情境 g 的 `fallbackChannel`（`UPDATE_STATE` 數量與頻率、postMessage 指令收到數、b 的觸發時間差）、既有測試修改表、e2e／build 使用次數、偏離、新發現。
- [ ] **Step 8：Commit**
  ```bash
  git add docs/plans/reports/twitch-audio-lock-impl-6.md docs/plans/reports/e2e-fix5
  git commit -m "docs: add twitch-audio-lock implementation report 6"
  ```

---

## 測試

| 層級 | 指令 | 通過標準 |
| --- | --- | --- |
| 單元（修正前） | 任務 1 Step 2、任務 2 Step 3、任務 3 Step 4、任務 4 Step 2 | 列出的新測試 FAIL；`twitch-broken.test.ts` 的重現測試失敗原因要是「degraded／warn／YT store 被設成 true／沒有送出 postMessage」，不能只是 import 錯誤 |
| 單元（修正後） | `npx --yes yarn@1.22.22 test:audio-lock` | **8 files、164 passed**、0 failed／skipped（既有 6 個檔＋`twitch-embed`、`twitch-broken`）。既有 128 個測試名稱不變，只有任務 3 Step 5 表列（或報告補列）的測試換 provider 或改 Twitch 預期。新增 36 個：`twitch-embed` 11、`players` 7、`state` 4、`twitch-broken` 11＋3 |
| 型別 | `npx --yes yarn@1.22.22 typecheck:audio-lock` | exit 0 |
| 建置 | `npx --yes yarn@1.22.22 build`、`npx --yes yarn@1.22.22 test:artifacts` | Chrome、Firefox build exit 0；artifacts 10 pass |
| 假播放器 e2e ×3 | README 的迴圈 | 3 次 `compare.mjs` exit 0（fix-4 的全部判準不變） |
| 真直播 e2e ×3（M5） | `live.mjs`（normal） | 連續 3 次 `verdict: "PASS"`（SKIP 不算數） |
| 真直播備案 ×1（M5） | `live.mjs --mode=fallback` | 1 次 `verdict: "PASS"`，`twitchObserved=true`，情境 g 全部成立；和上一列分開記錄 |
| MVP 對照（M5） | `live.mjs` 載入 MVP | 有跑完而且有記錄；預期 c 失敗；記錄 `centerClickSwitch` |

若新增測試的實際數量和 36 不同（例如實作者把某個情境拆成兩個），在報告寫明，驗收以「既有 128 個全過＋本計畫列出的每個測試名稱都存在且通過」為準。

## 驗收條件

Codex 驗收時，以下每一項都要**自己實跑**確認，不採信實作報告的數字。任何一項不符即 FAIL。

1. **範圍**：`git diff <本計畫 commit>..HEAD -- src` 只動「Global Constraints」允許的檔案；`holodex-adapter.ts` 只多一個 `readMuteOthersHint` export；`TIMING` 沒變；`"twitch-embed-player-proxy"`、`"UPDATE_STATE"` 和 SetMuted 的 `10` 在 src 裡只出現在 `twitch-embed.ts`；`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**`、`yarn.lock` 沒變；`package.json` 只多 `e2e:audio-lock:live`；`fakes.js` 和證據逐位元相同。
2. **單元測試**：把 src 的改動 revert 掉、只保留測試，`twitch-broken.test.ts` 的 `broken_twitch_poll_never_degrades_or_warns`、`broken_twitch_never_calls_native_manualCheckMuted`、`untrusted_failed_post_is_retried_after_cooldown`、`iframe_state_mute_not_applied_keeps_retrying_until_confirmed`、`broken_twitch_user_unmute_in_iframe_switches_then_reverse`、`twitch_missing_sdk_methods_never_falls_back_to_native`、`reverse_switch_panel_mutes_broken_twitch_within_2s`、`healthy_twitch_ignoring_mute_does_not_degrade`、`twitch_first_play_does_not_claim_bootstrap_when_youtube_present` 都 FAIL，而且原因符合「測試」段。套回後全套 **164 passed**（或照報告的合理差異），既有 128 個測試都在；換 provider 的測試只限任務 3 Step 5 的表和報告逐條列出、有理由的項目，斷言沒有變弱；沒有 skip 或 only。
3. **typecheck、Chrome／Firefox build、artifacts** 都 exit 0。
4. **假播放器 e2e**：fix build 連續 3 次 `compare.mjs` exit 0，fix-4 驗收條件第 5 項的每一條都成立（含 `ytMutedSamples = 0`、`afterUserUnmuteTwitch.audible = TW`、`[Holodex+ AudioLock]` 警告 0）。
5. **真直播 e2e（真的跨網域 `player.twitch.tv` iframe，M5 有畫面 Chrome，暫存 profile 放 `.cache/e2e-browser/`）**：fix build normal 模式連續 3 次 `verdict: "PASS"`，每一次都要：
   - a：YouTube `<video>` 被靜音的取樣數 0；store a 為 `true` 的取樣數 0（含點 Twitch 播放鈕之後）；Twitch 有開始播（`!paused && readyState >= 2`）；Twitch 有聲的取樣數 ≤ 4；`twitchObserved = false`。
   - b：使用者點 Twitch 播放器自己的靜音鈕後 3 秒內切到 Twitch（Twitch 有聲、YouTube 靜音）。
   - c：3 輪反向切換（2 輪面板、1 輪 YouTube iframe）每輪都在 2000ms 內讓 Twitch 靜音、YouTube 有聲，之後 5 秒沒有反彈。
   - d：reload 後 YouTube 有聲、Twitch 靜音；store 的 YouTube 從未被持久化成 `muted=true`。
   - e：沒有 degraded 類警告（`player-unavailable`、`player-mute-did-not-settle`、`store-did-not-settle`、`restore-failed`、`cell-contract-changed`）；`vIsRefErrors = 0`。
   - f：刪除 Twitch 格不產生新的未捕捉例外，YouTube 仍有聲。
   - 校準成功（判斷聲音的方法有效），而且報告寫明方法。
6. **真直播備案（fallback 模式）**：fix build 1 次 `verdict: "PASS"`，和第 5 項分開記錄、不能互抵：
   - 前提：`twitchObserved = true`、`vIsRefErrors > 0`（證明真的走到壞掉 SDK 的實例）。
   - a：YouTube `<video>` 被靜音的取樣數 0；store a 為 `true` 的取樣數 0；Twitch 有聲取樣數 ≤ 8。
   - b：點 Twitch 播放器自己的靜音鈕後 3 秒內切到 Twitch；`updateStateMessages` 有那筆 `muted:false`。
   - c：3 輪反向切換，每輪在 2000ms 內由 iframe `<video>` 獨立確認 Twitch 靜音、YouTube 有聲，而且 `twitchCommandsReceived.mute` 有增加；之後 5 秒不反彈。
   - e：除 `twitch-guard-unavailable` 外沒有 `[Holodex+ AudioLock]` 警告（含 degraded 類與 `twitch-sdk-contract-changed`）；沒有進 degraded。
   - 只以 iframe `<video>` 的觀察判 PASS，不以 postMessage 呼叫成功或 SDK 回報判 PASS。
7. **MVP 並列**：同一時段、同一組 picks 在 M5 跑過一次 MVP，並列表裡 MVP 的 `vIsRefErrors` 與 `centerClickSwitch` 有記錄。MVP 的 c 結果照實列出（預期 FAIL）。
8. **額度與邊界**：e2e、build 次數和工作時間都在「回合與額度上限」內；真直播只在 M5 跑；`.cache/e2e-browser/` 沒有殘留 profile；沒有碰 Fi 的瀏覽器 profile、Microlife／Chorus、Orca 安裝；沒有 push、PR、merge、notarize、sudo；沒有寫入 worktree 以外的位置；MVP 資料夾沒被修改（驗收前後比對 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} +`，用替代路徑時比對該路徑）。
9. **報告**：`docs/plans/reports/twitch-audio-lock-impl-6.md` 和 `docs/plans/reports/e2e-fix5/*.json` 已提交，JSON 的 SHA-256 和報告一致。

Fi 在 M1 Vivaldi 的實測，以及 Firefox 真機載入，仍是交付後的人工項目，本輪不宣稱完成。

---

## 審查回應

回應 `docs/plans/reviews/twitch-audio-lock-fix-5-plan-review-1.md`（Codex，第 1／1 輪）。每條都在修改後的計畫裡逐段核對過（核對是作者自查，不算審查）。

| # | 條目 | 嚴重度 | 處理方式 | 修改的段落 |
| --- | --- | --- | --- | --- |
| 1 | 備案放棄 Twitch iframe 的主動選聲，接受兩台同時有聲 | critical | **採納**。照建議在 `twitch-embed.ts` 集中實作 iframe `UPDATE_STATE` listener（驗證 origin、source、namespace、eventName、`params.muted` 型別），以 iframe `contentWindow` 為 key 記住狀態；SDK 被 Vue 觀察時，port 讀取改回 `known`，所以 `true → false` 邊緣＋iframe intent 的選聲直接沿用 `state.ts` 既有的 `OBSERVED_MUTED` 路徑。新增「SDK 不可信，使用者在 iframe 取消靜音 → 切到 Twitch → 再切回 YouTube」測試與真直播情境 g 的 b。原「待 Fi 決定」第 4 題改成只剩「iframe 完全不送狀態」的未驗證子情況，且該情況會讓情境 g FAIL，不是選配。核對：v1.js 的 `_handleResponses` 確認 iframe 會送 `UPDATE_STATE`、`params` 含 `muted`；壞掉的是 SDK 接收端，所以獨立 listener 不受 `__v_isRef` 影響。 | 根因對照（v1.js 列、iframe 狀態段）、修法比較 B、Architecture、Review Focus 1／7、檔案表、任務 1 Interfaces／Step 1／3／5／6、任務 2 管道表／Step 1／2／4、任務 3 Step 2 `broken_twitch_user_unmute_in_iframe_switches_then_reverse`、任務 5 情境 g、驗收 6、待 Fi 決定 4 |
| 2 | 一次靜音失敗就鎖住整個 epoch；成功送出不等於已套用 | critical | **採納**。`MUTE_SENT` 新增 `ok`；`ok:false` 只更新 `lastMuteAt`（冷卻照算），不寫 `lastMuteEpoch`、`settleUntil`、`unsettledMuteCount`，所以 1 秒冷卻後的下一次輪詢會重試。讀得到 iframe 狀態時走 `OBSERVED_MUTED`，一直依冷卻／settle 重送到觀察到 `muted:true`（Twitch 不降級）。新增 `mute_sent_failure_keeps_epoch_retryable`、`untrusted_failed_post_is_retried_after_cooldown`（含 iframe 暫時不在）、`iframe_state_mute_not_applied_keeps_retrying_until_confirmed`；20 秒「剛好 1 次」改成「成功剛好 1 次」。核對：controller `:258-265` 先取得 `ok` 再送事件，順序可直接帶入；冷卻 1000ms＋輪詢 1000ms，失敗後的重試落在 2000ms 內。完全盲靜音（沒有任何 iframe 狀態）時仍無法確認是否套用，這部分由情境 g 的 `updateStateCount` 把關。 | 檔案表、任務 2 Step 4（回傳值語意）、任務 3 Interfaces／Step 2／3／4／6／7、測試數量、驗收 2、Review Focus 2 |
| 3 | 保留 Twitch 契約不符的全域降級，原生 Mute Others 會回來 | warning | **採納**。Twitch 缺 `getMuted`／`setMuted` 時，port 不設 `mismatched`，改走 iframe 管道（沒有 iframe 時回 `untrusted`、`mute()` 回 `false` 可重試）；controller 的 `onContractMismatch` 對 Twitch 不 `failSession`，只印一次 `twitch-sdk-contract-changed`，wrapper 保持安裝。`ready_sdk_missing_methods_degrades` 改用 YouTube 維持原斷言；`ready_instance_missing_methods_reports_mismatch` 只改 Twitch 那半的 `readMuted` 預期；新增 `twitch_missing_sdk_methods_never_falls_back_to_native`，斷言原生檢查與非使用者授權的 Mute Others 都不被呼叫。其他 provider 的降級生命週期保留；「YouTube 降級時 Twitch 也回原生」的殘留風險列入待 Fi 決定 9。 | 檔案表、任務 2 管道表／Step 2／2b／4、任務 3 Interfaces／Step 2／5 表／7、Review Focus 3、待 Fi 決定 8／9 |
| 4 | 真直播三次 PASS 可以完全沒驗證備案 | warning | **採納**。新增 `--mode=fallback`：測試瀏覽器在頁面腳本前把 `window.Twitch` 定義成不可設定的資料屬性，讓 guard 失效，重現真的被 Vue 觀察的實例（前提檢查 `twitchObserved=true`、`vIsRefErrors>0`，不成立判 FAIL）。情境 g 跑 a／b／c×3／e，真相只看 iframe `<video>`，並在 iframe 端計數實際收到的 postMessage 指令、在頂層計數 `UPDATE_STATE`，記錄實際走過的管道。fallback 1 次 PASS 成為獨立驗收門檻（驗收 6），與 normal 三次分開記錄、不能互抵。額度維持原上限（Cursor 10 次＝必跑 8＋重試 2；Codex 8 次剛好必跑 8）。 | 回合與額度上限、任務 5 用法／Step 3 管道計數／情境 g／Step 5 輸出／Step 6、任務 6 Step 3b／5／6／7、測試表、驗收 5／6 |
| — | 協調者補充的環境事實 | — | **採納**。真直播只在 M5、暫存 profile 放 `.cache/e2e-browser/` 並刪除；不在 M1 跑、不碰 Fi 瀏覽器 profile／Microlife／Chorus／Orca 安裝；MVP 用 M5 的 `/Applications/Extensions/holodex-plus-audiolock-chrome`（規劃時確認存在）唯讀載入，不存在時的替代路徑寫在 Global Constraints；`--headless=new` 只供除錯；`play()` 不能開始播放，改點播放器自己的播放鈕再點空白處；「在播」＝`!paused && readyState >= 2`；預設直播 `1-LpQekNa9g`／`eslcs`；情境 b 只點 Twitch 靜音鈕，MVP 的「點中央誤切換」列為觀察項 b′。 | Global Constraints、根因對照補充、任務 5 Step 1／2／3／4（a、b、b′）、任務 6 Step 4、驗收 7／8、待 Fi 決定 6 |

審查的「Dismissed」項（一律重建 iframe 或回到 MVP 重寫）本計畫本來就沒有採用，維持不變。

## 待 Fi 決定

| # | 問題 | 採用的假設 | 選錯的影響 |
| --- | --- | --- | --- |
| 1 | 使用者意圖窗要用 fix-4 的 2.5 秒，還是 MVP 的 10 秒？ | 維持 2.5 秒（`TIMING.USER_INTENT_MS` 不動）。SDK 修好之後，讀到的就是 Twitch 的真實狀態，不需要像 MVP 那樣用長窗口來彌補「讀不到」。 | 如果 Twitch 的 UPDATE_STATE 比 2.5 秒還慢才到，情境 b 會失敗（使用者取消靜音後被壓回）。那時改成 10 秒，只要改一個常數。 |
| 2 | 設定關閉，或 Mute Others 關閉時，Twitch 要不要也預設靜音？ | 不要。只有在「設定沒有明確關閉」而且「store 的 Mute Others 不是 false」時才預設 `muted:true`；`__v_skip` 則一律加上。這符合主計畫「關閉時回到 Holodex 原生」的決定。 | 如果 Fi 想要像 MVP 一樣永遠預設靜音，把 `shouldDefaultMute` 改成永遠回 `true` 即可。現在的假設下，Mute Others 關閉時 Twitch 會照 Holodex 原生方式出聲。 |
| 3 | bootstrap 時是否照 MVP，讓 Twitch 首播不搶選聲（任務 4）？ | 照 MVP：只要有非 Twitch 格，Twitch 首播就不搶；只有 Twitch 格的版面維持 fix-4 行為。這推翻了主計畫第 1 題「YouTube／Twitch 都可」的部分，因為 SDK 修好之後，Twitch 搶到就會真的出聲。 | 如果 Fi 要維持 fix-4 的規則，拿掉任務 4 即可。代價是「全都沒指定的初始版面」中，Twitch 先播時會拿走聲音。 |
| 4 | 如果 SDK 不可信，**而且** iframe 從沒送過 `UPDATE_STATE`（完全盲靜音），使用者在 Twitch 播放器自己的 UI 取消靜音怎麼辦？ | 本輪已經用 iframe `UPDATE_STATE` 補上這個行為（審查回應第 1 條），所以只剩「iframe 根本不送狀態」這個未驗證的子情況。此時偵測不到取消靜音，盲靜音每個選聲 epoch 成功送出一次。真直播情境 g 會直接量 `updateStateCount`；若是 0，情境 g 的 b 判 FAIL、本輪不交付，由協調者回報。 | 若真 iframe 不送狀態，iframe 管道就只能靜音、不能讀，需要 Fi 決定是否接受方案 D 或其他讀法。 |
| 5 | 若真 iframe 上 `__v_skip` 和 postMessage 都沒效，要不要改用方案 D（帶 `muted=true` 重新載入 iframe）？ | 不要自動改。這輪先停下來回報。 | 方案 D 會讓 Twitch 畫面閃爍、重新緩衝，可能再插廣告；未經 Fi 同意就採用，可能比現在的 bug 更擾人。 |
| 6 | 真直播 e2e 用哪一台直播？ | 預設 YouTube `1-LpQekNa9g`（Lofi Girl 24/7）、Twitch `eslcs`（24/7 重播），協調者 00:4x 確認可用；環境變數可覆寫；預設台不能用時才走自動挑台（Twitch 熱門前 10、Holodex 首頁直播中前 5，各最多 3 台）。所有真直播只在 M5 跑。 | 24/7 台也可能臨時下架或改成不能嵌入，會多花 SKIP 額度；自動挑可能挑到成人內容確認頁或地區限制。 |
| 7 | 情境 c 的「取消 YouTube 靜音」，Fi 實際上是用 Holodex 面板，還是 YouTube 播放器自己的按鈕？ | 兩種都測（2 輪面板、1 輪 YouTube iframe）。 | 如果 Fi 還用了第三種方式（例如格子標題列的按鈕、鍵盤快捷鍵），e2e 沒有覆蓋到，要補一輪。 |
| 8 | Twitch SDK 契約不符時，警告要不要出現在主控台？ | 不降級（審查回應第 3 條），但印一次 `twitch-sdk-contract-changed` 警告，讓 Twitch 改版時有跡可循；這個 code 不在 degraded 類清單，也不會讓 wrapper 被拆掉。 | 若 Fi 希望完全安靜，拿掉那一行 warn 即可，行為不變。 |
| 9 | **YouTube** 格降級時（例如 YouTube 讀取一直逾時），整個 session 仍會拆掉所有 wrapper，Twitch 格也回到 Holodex 原生處理，要不要也隔離成「只停用那一格」？ | 本輪不改：審查只要求 Twitch 本身的失敗不能讓原生接手，其他 provider 的降級生命週期保留。正常情況 `__v_skip` 生效，原生處理讀得到 Twitch 真實狀態，不會重現 bug；只有「YouTube 降級＋Twitch SDK 也壞」同時發生才會重現。 | 若兩者同時發生，YouTube 可能又被一直靜音。要完全避免，下一輪把 `failSession` 改成逐格隔離，改動會碰到 fix-4 的降級生命週期與其測試。 |
