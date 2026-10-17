# Twitch audio lock 正式版細部實作計畫

> 執行者：Cursor。這份文件包含實作所需的設計與驗證規格，不依賴本次對話或 `.ref/` 才能理解需求。按「步驟」逐項實作；本次規劃交付不包含產品程式碼。

日期：2026-10-17。擴充功能基準：`gixiphy/twitch-audio-lock`，`eda5b52`。Holodex 參考基準：`HolodexNet/Holodex` dev 的 `8c6d0dacbe93f89cd788963e2a63a095b6d3a715`，Vue `^2.7.8`、Vuex `^3.6.2`。線上版本是否相同必須以執行期契約檢查確認，不能僅憑研究筆記認定。

**目標：** Holodex multiview 開啟 Mute Others 時，Twitch 自行取消靜音、初始化或重連不得搶走使用者選定的聲音；使用者仍能明確切換或全部靜音。

**架構：** 保留現有 content script → page script 注入途徑。將純狀態機、Vue 2 相容層、播放器 API、意圖追蹤與設定橋接分開；Vuex 保留 Holodex 的畫面狀態，狀態機保存短期使用者意圖與非同步操作世代。

**技術：** 既有 Vite 7.1.11、TypeScript、`webextension-polyfill`、原生 DOM；options 目前是 TypeScript 動態產生表單，並非 React 元件。自動測試採 Vitest 3.2.6 與 jsdom 26.1.0，另用 Vue 2.7.16 作為僅限測試的相容性 fixture。

## 背景與目標

### 已查證的呼叫鏈

原型位於 `src/pages/content/holodex/twitch-audio-lock.ts`，由 `holodex-inject.ts` 呼叫 `installAudioLock()`。原型沒有獨立的 active cell 狀態機，實際上是用 Vuex 的 `muted` 加上 10 秒焦點與 hover 條件判定意圖。

已閱讀的 Holodex 行為如下；下列路徑均相對於 Holodex 原始碼根目錄，研究副本位於 `.ref/holodex/`，只可讀：

| 位置 | 實際行為與實作含意 |
| --- | --- |
| `src/components/multiview/MediaControls.vue` | 面板即使未開啟也每 1000ms 呼叫各 cell 的 `manualCheckMuted()`；打開面板還會呼叫 `manualRefresh()` → player `updateListeners()` → `@mute`。兩條路徑都須保護。 |
| `src/components/multiview/VideoCell.vue` | `manualCheckMuted()` 將播放器回報交給 `setMuted()`；`setMuted(false)` 先呼叫 cell 的 `muteOthers(item.i)`，再設定 computed `muted`。`updatePausedState()` 的首次播放也會呼叫 `muteOthers()`。 |
| `src/store/multiview.module.ts` | `muteOthers` 是 lodash `debounce(..., 0, { trailing: true })`，真正改 state 發生在後續 timer；`store.subscribe()` 看到 mutation 時 state 可能還沒變。`setMuteOthers(true)` 會自行挑第一個 video cell 為有聲。 |
| `src/components/player/TwitchPlayer.vue` | 在 `beforeCreate()` 載入 SDK，再把 `new window.Twitch.Player(elementId, options)` 放進 reactive `player`；options 未帶 `muted`。`isMuted()` → `getMuted()`，`setMute()` → `setMuted()`。 |
| `src/components/player/PlayerMixin.ts` | READY 時重新套用 mute prop 並發出 ready；manual update 路徑也會發出 mute，不能視為明確操作。 |
| `src/views/MultiView.vue`、`CellMixin.ts` | 頁面有 `$refs.videoCell`／`videoRefs`；cell 使用 `item.i` 對應 `store.state.multiview.layoutContent[id]`，影片以 `content.type === 'video'` 識別。 |
| `src/utils/options.ts`、`src/pages/options/index.ts`（本 repo） | `Options.schema()` 定義布林預設值；`Options.get/set` 使用擴充功能 `storage.local`；options 表單自動列舉 schema。`Options.subscribe` 目前是註解，不可當成已存在的 API。 |

Fi 已在 M1 Vivaldi 用 unpacked 原型確認功能有效。約 6800 次 SecurityError 是使用者的單次觀察，沒有固定觀察期間或可重複基準，不用它作為性能或錯誤次數門檻。研究筆記記載的廣告、重連原因仍是待驗證推論，不能寫成已重現的因果。

### 全域限制

- 禁止 push、開 PR、merge 到 remote、公證與 sudo。不得自動發佈或安裝到瀏覽器。
- 本次只寫計畫，提交範圍限這個計畫檔與 `docs/plans/prompts/` 底下的 prompt；不修改 `src/`、依賴或 lockfile，不提交建置產物。下文產品改動均屬下一輪實作。
- 所有產品、文件、工具快取與測試輸出只放目前 worktree；不修改 iCloud 主 checkout、家目錄或 `.ref/`，不刪除 worktree 外的內容。
- 這個 worktree 的 `.git` 指到 `~/Documents/Code/私人專案/Holodex-Plus/.git/worktrees/twitch-audio-lock`。協調者已於 `DISPATCH-2610171431178858` 明確允許 commit 必要的 Git metadata（含主 checkout `.git` 的物件與 refs），視為本 worktree 範圍；可以在目前分支 stage/commit，不得切分支或 push。此例外不允許修改主 checkout 的產品檔案或其他家目錄內容。Git 唯讀檢查設定 `GIT_OPTIONAL_LOCKS=0`。
- 目前 worktree 不在 `~/Documents`；快取直接放此 worktree 的 `.cache/`、`node_modules/`、`dist_chrome/`、`dist_firefox/`。不建立指向 `~/Library/Caches` 或 iCloud 的 symlink，不使用 `.nosync`。如後續換到 Documents 下，先解決寫入限制，不能照搬這份命令去寫家目錄。
- 保留 MIT 授權；不複製 Holodex 元件實作進本 repo，不記錄帳號、token、完整 Vue store 或 player 物件。

## 設計

### 1. 掛勾、相容性偵測與生命週期

使用 `createHolodexAdapter(window, document, report)`，將所有私有結構存取集中在 `audio-lock/holodex-adapter.ts`。不用元件名稱作為必要條件，也不註冊不可撤銷的全域 `Vue.mixin()`。

**發現順序與契約：**

1. 僅在 top frame 啟動 audio lock。先判斷 `location.pathname` 符合 `/^\/multiview(?:\/|$)/`；一般 watch、首頁、YouTube 頁及子 frame 不改音訊。
2. 從 `#app`、`[data-app]` 及 `.multiview` 的祖先讀取各自的 `__vue__`，再取 `$root`；若缺少，對候選 app 容器最多掃描 500 個 DOM 元素尋找 `__vue__`。不掃描 iframe 內部。
3. 只透過 `$children` 遍歷 Vue instance，以 `WeakSet` 防循環，上限 2000 個 instance；禁止 `searchObject()`、遞迴 `Object.entries(vm)`、遍歷 `$data` 或任意 player 子欄位。碰到例外即回傳相容性失敗，不繼續擴大搜尋。
4. 驗證候選 store 的 `commit`、`watch`、`subscribe` 都是 function，`state.multiview` 有布林 `muteOthers`、陣列 `layout`、物件 `layoutContent`。不依賴 `_mutations` 等 Vuex 私有註冊表。
5. 優先取持有 `$refs.videoCell`／`videoRefs` 的 multiview instance；缺少這些名稱時，用有界 `$children` 搜尋相同形狀。VideoCell 候選必須同時滿足：`item.i` 是 string/number、相同 store、對應 layout item 與 `type: 'video'` content 存在、`cellContent` 對應同一 content、`$el` 是連接中的本頁 Element、`manualCheckMuted`／`setMuted`／`muteOthers`／`updatePausedState` 是 function、`muted` 是 boolean、`isTwitchVideo` 是 boolean。名字 `VideoCell` 只能當診斷提示。
6. player 尚未 ready、`$refs.player` 尚未存在是正常等待狀態；存在時必須有 `isMuted`、`setMute`，以及本頁 iframe 與 content provider 一致。iframe URL 用 `new URL(iframe.src)` 檢查 hostname allowlist：Twitch `player.twitch.tv`，YouTube `www.youtube.com`／`www.youtube-nocookie.com`；不可用子字串匹配。只讀 iframe Element 的屬性，不讀 contentWindow 的屬性。
7. 全部可見 video cell 都符合 cell 契約，且要保護的 Twitch cell 有可用 PlayerPort，才啟用整組攔截。未知第三方 player、同 id 多個連接中的 cell、超過掃描上限均視為不相容。空 multiview 與暫時載入中的 player 保持 waiting，最多 120 秒，不把正常空畫面報成錯誤。

**發現時序：** 進入 multiview 或重新開啟設定後立即探測；前 15 秒每 250ms 一次，其後每 2000ms 一次，總計不超過 120 秒。找到相容 root 後改成容器的 `MutationObserver({ childList: true, subtree: true })`，合併到下一個 animation frame 再檢查，並每 2000ms 做一次輕量 cell 身分核對。沒有每秒全樹無限遍歷。路由以 Vue Router `afterEach` 訂閱及可撤銷的解除函式為主；root 尚未取得時用 2000ms pathname 檢查，不修改 history API。

**啟用與降級：** 每次啟用前做兩階段處理：先收集與驗證，再一次安裝所有 cell wrapper；任何不可寫方法或安裝失敗都回復本次已裝項目。結構不相容時不呼叫 player、不寫 store、不留下半套 patch，`console.warn('[Holodex+ AudioLock]', { code, adapterVersion: 1 })` 每 document 每 code 最多一次。不要把 VM、SDK、Error 物件丟到 console。發現契約永久失配後進入 degraded，不繼續密集重試；下次路由進入、設定重新開啟或 reload 才再探測。

原型的 `window.__HDX_AUDIO_LOCK__ = true` 改成可釋放的 controller handle。`installAudioLock(): AudioLockHandle` 要冪等；`AudioLockHandle` 提供 `setEnabled(value: boolean): void`、`dispose(): void`。停用、離開 multiview、root 被換掉、`pagehide` 都取消該次音訊 session 的 timer、observer、DOM listener、store watch/subscribe、Vue ready listener 與非同步結果。入口的最小設定／路由／`pageshow` bootstrap 保留以便重啟；`pageshow`（包括 BFCache）重新驗證，只有最終 `dispose()` 才連 bootstrap 也一起移除。每個 disposer 可重複呼叫。restore 方法時只在目前值仍等於我們的 wrapper 才復原，不覆蓋第三方後裝的 patch。

**Holodex 改版偵測：** 以 `adapterVersion: 1` 的上述契約做行為檢查；不比較 minified function 的字串或寫死線上 bundle hash。記錄簡短 reason code，例如 `root-timeout`、`store-shape-changed`、`cell-contract-changed`、`provider-unsupported`、`patch-not-writable`、`player-unavailable`。新版本仍符合契約可繼續運作；不符合則停用。Vue 3／React 重寫不自動支援。

### 2. PlayerPort 與 SecurityError 邊界

介面定義在 `audio-lock/types.ts`：

```ts
type CellKey = string; // String(item.i)
type CellIdentity = {
  key: CellKey;
  contentId: string;
  provider: 'youtube' | 'twitch';
  generation: number;
};
type ReadMuted =
  | { kind: 'known'; muted: boolean }
  | { kind: 'unavailable'; reason: 'not-ready' | 'timeout' | 'access-error' };
interface PlayerPort {
  readMuted(): Promise<ReadMuted>;
  mute(): Promise<boolean>;
  dispose(): void;
}
```

PlayerPort 不提供自動 `unmute()`：修正器只能壓回非 active 的聲音，主動取消靜音由明確使用者命令經 Holodex 既有流程執行。false、undefined、異常回傳不可用 `!!value` 強制轉成「沒靜音」；只有真正 boolean 才是 known。

**取得原始參考的策略：**

- Twitch：在已驗證 multiview 上，優先從 `Twitch.Player` 建構當下捕捉其回傳 instance，將 `getMuted`／`setMuted` 這兩個原始 method 綁定 instance 存進 module closure 的 registry。以建構參數 elementId 或 Element 對應本頁容器，再驗證它在已發現 cell 的 `$el` 內；不靠 `_embedWindow` 反查。初始化尚無 cell 時只短暫記錄容器與 port，下一次 discovery 配對，過期或容器移除即釋放。記錄上限 64 筆、未配對保留最多 120 秒。
- 建構攔截只捕捉參考，不改傳入 options，不代建 iframe，不覆寫 Holodex 的 `player`。採 `Proxy(OriginalPlayer, { construct })` 與 `Reflect.construct` 保留 prototype、static event constants、`new.target`／subclass 語義；對非本 multiview 的呼叫完全透傳。只在 `Player` descriptor 可安全替換時安裝，保存及還原原 descriptor；SDK getter-only／non-configurable export 不用複製 namespace 繞過。
- SDK 未載入時，只有在 `window.Twitch` 不存在且可建立 configurable 自有屬性時才設暫時 assignment trap；若已有 accessor 就不覆蓋。首次指派後立刻恢復普通的 global descriptor 並嘗試上述安裝；停用時回復 descriptor，保留網站在此期間載入的實際 SDK 值，不能把已載入的 Twitch 刪掉。trap 例外一律不丟回網站賦值者。
- 攔截太晚或無法安裝時，可從已驗證 `$refs.player` 的單一 `player` 欄位取得現有 instance，立即取出並綁定那兩個公開 method。這是 late-bound 原始參考，**不是**還原成未觀察物件；無法取得可呼叫 method 就整組降級，不能任意深入 SDK 或讀 iframe window。頁面已初始化時不重建 player。
- YouTube：同樣只取已驗證 player component 的 `player` 原始參考，綁定 youtube-player 公開 `isMuted`／`mute`。它可能回傳 Promise，必須接受並處理。不在我們的輪詢中呼叫 component `isMuted()` 來穿越更多 Vue 層。
- registry、綁定函式、WeakMap、controller handle 都只存在 closure／非 reactive 的擴充功能物件，不塞進 VM、Vuex、`$data`。已被 Vue 2 觀察的 SDK 原始 instance 仍可能有 reactive getter；這個策略減少我們的存取面，不能承諾把 SDK 去 reactive。

read 前必須確認 ready：在 player component 用 Vue `$on('ready', listener)`／`$off` 取得訊號；若 late-bind 發生在 ready 之後，Twitch 以 `cell.twPlayer === capturedInstance`、YouTube 以已存在的 `cell.ytPlayer` 與已驗證 binding 判定。不使用 SDK 私有 ready 欄位，也不把 SDK 初始快取 false 當真實 unmute。沒有 ready 訊號時回 not-ready，配合 120 秒有界等待。registry 不需向 SDK 添加無法移除的事件 listener；需要重新 reconcile 的 READY 使用這個 Vue 事件，PLAYING/ONLINE 若沒有可撤銷公開訂閱就省略，既有 polling 仍可處理恢復。

**Vue 2 的判斷與取捨：** Vue 2 的 reactive 主要是直接對原物件加 getter/setter；`vm.$data.player`、`player.__ob__.value` 不是通用的 raw escape hatch。Vue 2.7 的 `markRaw` 會設 skip 標記，但不撤銷既有 observer；不能把 Vue 3 的 `toRaw` 當作修復。這點依據 [Vue 2.7 reactive 原始碼](https://github.com/vuejs/vue/blob/v2.7.16/src/v3/reactivity/reactive.ts) 與 [observer 原始碼](https://github.com/vuejs/vue/blob/v2.7.16/src/core/observer/index.ts)。

對新建 instance 先 `markRaw`／設 `__v_skip`、`Object.preventExtensions`／freeze、偽造或刪除 `__ob__` 雖可能影響觀察過程，也可能破壞 SDK 後續新增欄位、Holodex watcher 與 plugin。**正式版第一版不採用這些修改。** 不修改 `_embedWindow` descriptor、不 patch Vue observer／Vue.config.errorHandler、不攔截全頁 console/error、不使用 `preventDefault()` 隱藏網站錯誤。若未來要降低 Holodex 自身錯誤，另立實驗，以相同 SDK／頁面做相容測試後再決定；本功能不承諾消除它。

**所有邊界：** global descriptor、VM getter、DOM 查詢、原始 method 取得與呼叫、store 操作均包 try/catch；Promise rejection 也必須接住。每次 player read／mute 有 750ms timeout；timeout 後保留 rejection handler，遲到結果用 generation 丟棄。不可 await 永不 resolve 的 SDK Promise 卡住下一次輪詢。

不讀 `iframe.contentDocument`、`contentWindow.document`、window location、`_embedWindow` 或未公開內部欄位；不列舉、深拷貝、serialize player。Twitch 使用公開 [getMuted／setMuted API](https://dev.twitch.tv/docs/embed/video-and-clips/)；官方事件清單沒有 mute-change 事件，不假設存在這種事件。READY／PLAYING／ONLINE 只能通知重新讀狀態，不算使用者意圖。

短暫 not-ready 不 warn、不增加錯誤計數。每次 access-error 或 timeout 將連續失敗數加一，接著該 cell 冷卻 5000ms，不讀 API；累計連續 3 次即以 `player-unavailable` 整組卸載保護並 warn 一次。每次成功 read 清掉連續失敗數；每次新的 player generation 可重新嘗試。不要在每個 tick 印 re-mute log。

### 3. 意圖來源、狀態機與輪詢競態

**狀態：** `mode: 'disabled' | 'discovering' | 'waiting-for-choice' | 'locked' | 'degraded'`，`active: CellIdentity | null`，`epoch: number`，`intent: { identity, source, expiresAt, consumed } | null`，以及各 cell 的 read/mute in-flight、最後寫入時間與連續失敗數。active 綁定 key + provider + contentId + player generation，不能只用 DOM 順序或格子索引。重新排序不改 active；換片、換 provider、重建 player 時舊非同步結果及 token 必須失效。

純函式為 `transition(state: LockState, event: LockEvent): { state: LockState; effects: LockEffect[] }`，時間由 event 的 `now` 注入；不在 reducer 讀 DOM、store、Date.now 或 player。`LockEvent` 至少包含 `ENABLE`、`DISABLE`、`DISCOVERED`、`EXPLICIT_SET_MUTED`、`IFRAME_INTENT`、`OBSERVED_MUTED`、`STORE_SNAPSHOT`、`CELL_REMOVED`、`CONTRACT_FAILED`。effects 僅包含 `MUTE_PLAYER`、`CALL_ORIGINAL_SET_MUTED`、`REPORT_ONCE`，附 identity 與 epoch；套用前再次核對最新狀態。

| 輸入情況 | 轉移與動作 |
| --- | --- |
| options 未讀完、extension 關、Mute Others 關、非 multiview | disabled/discovering；不變更 store/player。Mute Others 關時走完整原生方法，不殘留「Twitch 預設靜音」。 |
| 啟用／重新開 Mute Others，store 穩定後只有一個 video `muted === false` | 採該 identity 為 active → locked，不為初始化自行取消任何 player 靜音。 |
| 初始化零格有聲 | waiting-for-choice、active=null；維持全部靜音。 |
| 初始化多格有聲 | waiting-for-choice，不自行選第一格或大規模靜音；暫時只壓回 store 本來標成 muted 的格。下一次明確選擇才建立唯一 active。 |
| 使用者在 Holodex 面板明確對 B `setMuted(false)` | 立即 active=B、epoch++、消耗 token；同步範圍內呼叫原 `setMuted(false)`，允許其 `muteOthers(B)`，其他 cell 立即視為應靜音。不用等 debounced Vuex mutation 才更新意圖。 |
| B 的實際值 false，但 store／active 要 B 靜音；有 B 尚未消耗的有效 iframe token | 接受一次同上；焦點本身不切 active，還必須觀察到從 muted → unmuted 的變化。 |
| 非 active B 自行回報 false，沒有有效 token | 不呼叫原 `setMuted(false)`／`muteOthers`，保持 active；對 B 發 MUTE_PLAYER。 |
| active 回報 true | 若沒有待完成的更新或過期 read，原 `setMuted(true)` 同步 store，清 active → waiting-for-choice。不自動取消靜音；廣告／播放政策造成暫時靜音也採保守的全靜音行為。 |
| 明確靜音 active／全部靜音 | 原生 setMuted(true)，active=null、epoch++、清 token；其他 player 自行取消靜音全部壓回。 |
| first play／READY／ONLINE／重新整理非 active 格 | 不授權 active 切換；壓回不符 desired/store 的有聲狀態。 |
| 刪除 active、改其影片或 provider | active=null，清 token；不自選下一格。重建相同內容的 player 可在確認原 active content 未變後承接選擇，但必須換 generation、重建 port，舊結果無效。 |
| 關閉設定／Mute Others／離開 multiview | epoch++，清 token、所有 timer 與 in-flight 的作用資格，還原 wrappers；不額外更改音量、播放或 store 靜音狀態。 |
| 契約失配 | degraded；撤銷整組保護、warn 一次，原頁面繼續操作；不把原始搶聲 bug 說成已受到保護。 |

**意圖證據與有效期限：**

1. Holodex 媒體控制面板是可靠路徑。以 media-controls 的 `.media-controls-list` 加上 Vue 結構（同 store、`allCellAction`／`setAllVolume` methods）辨識面板；不能依翻譯文案、icon path 或 row index 對應 cell。捕捉 `isTrusted` 的 click，或 Enter／Space 導致的啟用事件，在該事件的同步 dispatch 期間開啟操作資格，microtask 即清除。cell wrapper 實際收到哪一個 `setMuted(value)` 才是命令對象；僅點面板、調音量、play 不選 active。
2. 「全部取消靜音」沿用 Holodex 在 Mute Others 開啟時的單格結果：同一 trusted dispatch 依 cell 呼叫順序，最後一個有效 `setMuted(false)` 為 active，與 trailing debounce 的最後一筆一致。Mute Others 關閉時完全原生多格有聲；文件與測試須明確覆蓋。
3. 同頁 cell 上 trusted pointerdown 只建立候選，期限 **2500ms**、最多消耗一次；不直接選 active，不因拖曳／調尺寸授權。限 `.mv-frame` 播放區且排除可拖曳標頭、resize handle、連結與編輯按鈕。父頁收不到 iframe 內 pointerdown，不能宣稱這條路徑涵蓋 iframe 內每次點擊。
4. window `blur` 或父頁 `focusin` 後在 `setTimeout(..., 0)` 讀本頁 `document.activeElement`；若是已配對、連接中的 player iframe、文件 visible，且相對上一個 iframe 是新焦點進入，產生同樣 2500ms 一次性 token。blur 到網址列／DevTools、隱藏 tab 或非 player iframe 不授權；focus 回父頁、切往別格、visibility hidden、cell 重建即清 token。
5. hover、mousemove、持續 `activeElement === iframe` 及程式合成 event 不延長 token。不要每次 poll 把「仍有 focus」重設為新意圖；不信任頁面 postMessage 聲稱使用者剛取消靜音。

**不可觀察的限制：** 父頁不能讀跨網域 iframe 內的 mute 按鈕，也無法精準分辨剛取得焦點時的廣告自動 unmute。2500ms 是設計上限，不是「保證真實點擊」；需要與 muted→unmuted 邊緣、一次消耗共同判斷。已長時間停在同一 iframe 後取消靜音可能被壓回；可先把焦點移出再進入，或使用 Holodex 面板。若 Fi 需要無歧義操作，後續可加 extension 提供的「聽這格」按鈕；本版不新增 overlay 或 Twitch host 權限。

**攔截點：**

- `manualCheckMuted()`：enabled 時改用一次 PlayerPort read → reducer → effects，不呼叫原本不帶來源的 polling；disabled 時還原原方法。每 cell 一個 in-flight，重入立即返回已處理的 Promise，不堆積讀取。
- `setMuted(value)`：攔住 `manualRefresh()`／`updateListeners()` 發來的 `@mute`，以及面板命令。trusted 面板事件可直接轉 `EXPLICIT_SET_MUTED`；其餘值只當 observation，沒有有效 token 的 false 不可當命令。效果呼叫原方法時用同步、可重入的內部授權深度，避免 wrapper 自我遞迴。
- `muteOthers(id)`：cell instance 的 mapped method 也要包；只有上項已授權的同步原 `setMuted(false)` 可以呼叫原 mapped method。原 `updatePausedState()` 繼續處理播放／editMode／firstPlay，但其沒有意圖的首次播放搶聲呼叫會被擋住。因此不需要像原型直接寫 `firstPlay = false`，也不必永久改播放方法。呼叫 id 必須等於該 cell 的 key。
- 不 patch 全域 `store.commit()`、Vuex mutation、player 全域 setMuted；不向 store 新增自己的欄位。若站方未來繞過這些 cell 方法直接切音訊，契約 fixture／人工測試應揭露差異，另行更新 adapter。

**狀態同步與競態：**

- 使用 `store.watch()` 觀察純 primitive 簽章（muteOthers、各 video 的 id/provider/muted），不做 deep watch player；以 `subscribe()` 提示 layout mutation 需要重掃。後續 macrotask 再 snapshot，不以 subscribe 的即時 state 決定 active，因 debounce 尚未執行。
- 明確使用者選擇後 controller 的 active 在 store 收斂前優先，直到下一個 tick／snapshot 完成；最後一筆命令獲勝。500ms 內若 store 仍未收斂成所選 B 唯一有聲，進 degraded 並報 `store-did-not-settle`，不無限與站方互改。
- 每次 read 開始保存 identity、epoch、read sequence；結果返回前核對。A→B→A、換片／刪格、停用、延遲 false／true 結果都不得覆蓋新決定。未經授權的外部 store snapshot 若與已鎖定狀態矛盾，不自行承認為使用者選擇；撤銷保護並 warn，避免未知版本互相搶改。
- 新選 B 後舊 active A 的延遲 mute=true 不得清掉 B；active read 若正處於自身狀態切換的 1500ms settle 期，不把短暫 stale true 當成全部靜音。settle 到期後真實 true 才同步為全靜音；不得無限延長。
- MUTE_PLAYER 只對 desired-muted 且已知 false 的格執行；每格最多每 1000ms 一次，同時最多一個寫入；命令後 1500ms 為 settle 期，這期間快取 false 不算新意圖、不重打寫入。settle 後仍 false 可重試，連續 3 次無法收斂即 `player-mute-did-not-settle` 降級。SDK 異步快取不應造成暴量 API 呼叫或 console 輸出。
- 保留 Holodex 1000ms polling 作為主要時鐘，不再增加第二個音訊 interval。新 cell、READY／ONLINE 可排一次合併 reconcile；所有 reconcile 套用相同 read/write 限制。

### 4. Options 與跨 context 設定傳遞

在 `src/utils/options.ts` schema 新增 `twitchAudioLock: true`；descriptions 加：

- name：`Keep selected audio in multiview`
- description：`Prevent players from taking over audio when Holodex Mute Others is on. Use Holodex media controls to choose audio reliably. Changes apply to open Holodex tabs.`

沿用 `storage.local`，不另建 options storage、不用網站 localStorage 作正式設定。既有 `src/pages/options/index.ts` 會自動生成 checkbox，毋須改 React 或重寫表單。增加測試確認呈現、預設 true 及 set(false) 後重新打開仍 false；一般畫面優化不屬於本任務。

生效條件嚴格為：`extensionSetting === true && store.multiview.muteOthers === true && compatibleMultiview`。不代替使用者開啟 Mute Others，不寫 `setMuteOthers`。切到 true 後以 Holodex 當時 store snapshot 建立狀態；切到 false 立即卸載，包含 Twitch constructor 攔截，不把原型「永遠 muted=true」留在關閉情境。

page script 沒有 extension storage 權限，**不可**在 `holodex-inject.ts` 或 audio-lock 子模組 import `@utils` barrel／`webextension-polyfill`；該 barrel 會引入 runtime/storage。content script 負責讀 Options，page script 只接布林值。新增純資料模組 `audio-lock-protocol.ts`，協定如下：

```ts
type AudioLockMessage =
  | { channel: 'holodex-plus/audio-lock'; version: 1; type: 'ready' }
  | { channel: 'holodex-plus/audio-lock'; version: 1; type: 'config';
      enabled: boolean; revision: number };
```

`startAudioLockSettingsBridge(win: Window): () => void` 放在 `audio-lock-settings.ts`，只由 isolated content script 使用。先註冊 message 與 `storage.onChanged`，再開始 `Options.get('twitchAudioLock')`，**然後才**呼叫既有 `inject(injectPath)`；不得延遲其他既有 Holodex flag 的注入。page script 先註冊 config listener 再發 ready；收到 ready 時 bridge 回傳最近值，初始 storage 尚未讀完則等結果，避免注入／storage 競態。ready 可重試 3 次、每 250ms；總設定等待 5000ms，無合法 config 則不啟用並 warn 一次，收到合法晚到 config 可恢復。

使用 `window.postMessage(message, location.origin)`；雙邊驗證 `event.source === window`、`event.origin === location.origin`、channel/version/type、boolean enabled、非負整數 revision，舊 revision 不覆蓋新值。listen-before-read 加本機讀取世代：讀取期間若已收到 storage change，忽略落後的 get 結果；local key 刪除回預設 true，錯型資料／storage 拒絕則採 disabled 並 warn 一次。只在 `areaName === 'local'` 且該 key 有變化時傳送。

訊息僅包含這一個布林設定與序號；DOM／postMessage 不是對抗同頁惡意腳本的認證邊界，來源驗證只能過濾其他 frame/origin。page→content 的唯一允許訊息是 ready，不提供任何 storage set、任意 key read、任意函式或 extension API 的代理。不能讓 forged config 寫回 extension storage。

extension 設定更新應在同頁約 1 秒內套用（前景、已收到 storage event 時），不用 reload；停用後任何 pending read 或補靜音都無作用。保留最小設定 bridge 以便再次啟用。原 `localStorage.hdxPlusAudioLock` 的讀取與註解移除；舊 `off` 不自動移入跨頁共用設定、不刪網站值，升級使用者改從 options 關閉。是否改做一次遷移列在 Fi 決策。

### 5. Manifest 與瀏覽器

不新增 permissions 或 host_permissions：沿用 `storage`、既有 `*://*.holodex.net/*` 與注入機制。不新增 `scripting`、`activeTab`、Twitch 網域、不把主邏輯送進 Twitch iframe，不使用 Firefox `wrappedJSObject`／`exportFunction`。在 page context 取得 Vue，保留 `?script&module` 由 CRXJS 產生的資源；實作後核對產生的 web_accessible_resources 含 page script 與其 chunk，且 match 範圍沒有擴大。

權威 manifest 是 `manifest.json.ts`；本功能預期不需修改它，也不手改 `dist_*/manifest.json`。Chrome 維持 MV3 service worker；Firefox 沿用現有 `vite.config.firefox.ts` 的 background scripts 處理，不為了 Chrome skill 的通用範例重寫它。options 保持 `src/pages/options/index.html`。兩個 build 成功仍不等於 Firefox/Vivaldi 真實頁面測試通過。

## 檔案

以下為下一輪實作的預定檔案；只修改列出的產品相關範圍，避免廣泛整理既有程式。

| 動作／檔案 | 責任與主要函式 |
| --- | --- |
| 重寫 `src/pages/content/holodex/twitch-audio-lock.ts` | 輕量入口，`installAudioLock(): AudioLockHandle`；page config listener、單例 handle；移除原型全域 mixin、hover、localStorage 與逐次 log。 |
| 新增 `src/pages/content/holodex/audio-lock/types.ts` | `CellIdentity`、`PlayerPort`、`LockState/Event/Effect`、`AudioLockHandle`、adapter binding 型別；不 import extension API。 |
| 新增 `src/pages/content/holodex/audio-lock/state.ts` | `createInitialState(): LockState`、`transition(...)`；純決策、全部時限常數與 identity/epoch 驗證。 |
| 新增 `src/pages/content/holodex/audio-lock/holodex-adapter.ts` | `createHolodexAdapter(...)`；`discover()`、`patchCell(binding, handlers): () => void`、`watchSnapshot(cb): () => void`、`dispose()`；Vue/DOM/store 契約與可撤銷 wrappers。 |
| 新增 `src/pages/content/holodex/audio-lock/players.ts` | `createPlayerRegistry(win, report)`、`createPlayerPort(binding): PlayerPort | null`；Twitch raw capture、late bind、750ms 邊界、descriptor 復原。 |
| 新增 `src/pages/content/holodex/audio-lock/intent.ts` | `trackIntent(bindings, onIntent): () => void`；trusted DOM signal、面板同步資格與 iframe 一次性焦點 token；不讀跨網域內容。 |
| 新增 `src/pages/content/holodex/audio-lock/controller.ts` | `createAudioLockController(deps): AudioLockHandle`；串 reducer、adapter、player、intent；`reconcileCell(identity): Promise<void>`、effects 套用、epoch、cleanup、once-warning closure。deps 注入 clock/timers 以便測試。 |
| 新增 `src/pages/content/holodex/audio-lock-protocol.ts` | 純 message 型別、常數、`parseAudioLockMessage(value: unknown): AudioLockMessage | null`；不可 import storage。 |
| 新增 `src/pages/content/holodex/audio-lock-settings.ts` | isolated bridge：`startAudioLockSettingsBridge(win): () => void`，Options get/storage change、revision、ready handshake。 |
| 修改 `src/pages/content/holodex/contentScript.ts` | 在 top frame 注入前啟動 bridge，保留既有 `inject` 行為與 flag 注入；對 rejected inject 作有界錯誤處理。 |
| 修改 `src/pages/content/holodex/holodex-inject.ts` | 保留既有 flags 與 `installAudioLock()` 入口，不引入 extension API。 |
| 修改 `src/utils/options.ts` | 新 schema key 與文案；不為這個功能改掉其他選項的 storage 行為。 |
| 新增 `tests/audio-lock/state.test.ts` | 純狀態機與時序表。 |
| 新增 `tests/audio-lock/adapter.test.ts` | jsdom／Vue 2 fixture、契約失配、wrapper/descriptor restore、firstPlay／@mute／deferred store。 |
| 新增 `tests/audio-lock/players.test.ts` | SDK fake、throwing getter、Promise timeout、constructor capture／late bind。 |
| 新增 `tests/audio-lock/controller.test.ts` | 整合 fake store/player/clock；poll、非同步世代、清理、intent。 |
| 新增 `tests/audio-lock/settings.test.ts` | mock webextension-polyfill、bridge race/message validation、既有 options 表單。 |
| 新增 `tests/audio-lock/fixtures.ts` | 最小 store/cell/player 工廠，忠實模擬 trailing debounce 與 READY/manualRefresh；不讀／複製 `.ref` 原始碼。 |
| 新增 `vitest.config.ts`、修改 `package.json` | 獨立 Vitest config、scripts、devDependency；不載入 CRXJS build plugins。 |
| 視需要修改 `.gitignore`、實作回合的 `yarn.lock` | `.cache`／`.vitest` 原名規則，不帶末尾斜線；依賴 lockfile 在實作回合按當時授權更新。本規劃回合不改。 |

`src/pages/options/index.ts` 原則上只由測試覆蓋，不必為一個新選項改 UI；若目前表單的錯誤處理妨礙此功能，限制修正範圍並在實作記錄解釋。`src/global.d.ts` 不必加大量 any global，將 page handle 型別留在入口的局部 Window 型別。

## 步驟

### 波次一：狀態規格與測試基礎（任務 1）

**交付：** 能獨立執行且無 DOM／SDK 的狀態機；尚不接到頁面。

- [ ] 確認基準 diff、Node、Yarn 與輸出位置；不覆蓋原有未提交檔案。後續安裝／build 只用本 worktree 的 cache，不將新檔指向 `.ref`。
- [ ] 在 `package.json` 加 devDependency `vitest: "3.2.6"`、`jsdom: "26.1.0"`、`vue: "2.7.16"`（僅 fixture）；新增 `test: "vitest run --config vitest.config.ts"`、`test:watch: "vitest --config vitest.config.ts"`、`typecheck: "tsc --noEmit"`。不加 coverage、React Testing Library 或 Vue Test Utils，現階段不需要。
- [ ] `vitest.config.ts` 用 `defineConfig` from `vitest/config`，`test.include: ['tests/audio-lock/**/*.test.ts']`、`environment: 'jsdom'`、`testTimeout: 5000`、`hookTimeout: 5000`、`teardownTimeout: 5000`、`restoreMocks: true`；cacheDir 指 worktree `.cache/vitest`。測試使用相對 import，不需共用 CRXJS/Vite browser config。
- [ ] 先寫 state 測試，至少用表格 assert：disabled 無 effects；未授權 B false 只產生 MUTE_PLAYER(B)；有 token B false 只產生一次 CALL_ORIGINAL_SET_MUTED(B,false)；token 在 2500ms 後無效；全部靜音 active=null；過期 epoch 不產生 effects。執行 `yarn test tests/audio-lock/state.test.ts` 確認尚未實作時 FAIL。
- [ ] 建立 `types.ts`、`state.ts`，完成上列介面與完整轉移表，再跑同一命令預期 PASS。用明確常數表達 2500／750／1500／1000／500／5000ms，不散落魔術數。
- [ ] review 決策與型別是否一致，將此獨立任務留在本機功能 commit（僅在當輪已允許 Git 中繼資料寫入時）；不 push。

### 波次二：相容層與整合（任務 2、3）

#### 任務 2：可撤銷 adapter 與 PlayerPort

**輸入：** types、report callback `(code: string) => void`。**輸出：** cell bindings、snapshot subscription、PlayerPort 與 disposers。

- [ ] 先在 `adapter.test.ts` 寫 root 名稱改掉仍成功、假 VideoCell 名稱但形狀錯誤不動作、無 root 在 120 秒停止、cyclic children 有界、readonly method 安裝回滾、未知 provider 整組降級等失敗測試。
- [ ] 在 `players.test.ts` 寫 SDK public methods 假物件；`_embedWindow` 設成一讀就 throw 的 getter，assert 未被讀過；ready 前回 not-ready，不取 SDK 初始 false；`getMuted` throw／reject／750ms 不 resolve 時 read 回 unavailable，沒有 unhandled rejection；ctor static、prototype、subclass、descriptor restore 都保持。
- [ ] 執行 `yarn test tests/audio-lock/adapter.test.ts tests/audio-lock/players.test.ts` 確認 FAIL，再實作兩個模組。所有存取限白名單欄位，不用全域 mixin 或 generic 深搜。
- [ ] 用實際 Vue 2.7.16 `Vue.extend`／Vuex-like fake store 建最小 fixture，元件 name 隨機、player 為帶危險 getter 的物件；驗證 registry 自己不被觀察，不在此 fixture 觸發額外 cross-origin 式 getter，且不把 `__ob__` 當 raw 解包。
- [ ] 重跑兩組測試及 state 測試預期全 PASS；fake timers 有界 advance，不可對持續 scheduler 用無限制 `runAllTimers()`。還原後方法與 descriptor 應 strictEqual 原值。

#### 任務 3：意圖、controller、三條攔截路徑

**輸入：** 任務 2 的 bindings／ports，任務 1 reducer。**輸出：** 冪等的 AudioLockHandle。

- [ ] 先在 `controller.test.ts` 重現 A=YouTube 已有聲、B=Twitch store muted 卻回 false；fake MediaControls 每秒 poll，assert A 的 mute／store 沒被 B 改、B 只有有限 mute 呼叫。
- [ ] 同時覆蓋 `manualRefresh → updateListeners → @mute(false)`，以及 B 首次播放 `updatePausedState(false) → muteOthers(B)`：兩者都不能切 active。測試 original editMode／firstPlay 仍照原生方法更新。
- [ ] 加 trusted 面板命令與 iframe token 測試，再執行上述 tests 確認 FAIL；實作 `intent.ts`、`controller.ts`，重寫入口。jsdom 不能建立真的 trusted event，將 DOM event 判讀與 transition 分開測，trusted 通道以注入的 trusted input adapter 測試；真實 isTrusted 路徑留瀏覽器驗證，不把 jsdom event 偽稱為可信。
- [ ] 明確測試 store trailing timer 尚未執行時 B 已是 active、A→B→A 最後命令獲勝、舊 read 晚回不改 active、500ms 未收斂降級、iframe hover 30 秒仍無授權、焦點 token 不重複使用、現成 iframe focus 不每秒續期。
- [ ] 測試開關關閉、換路由、BFCache、重排、同 key 換片、player 重建、root 替換；assert dispose 後 registry/listener/observer/timer 回到初始數量，pending Promise 返回不再寫 player/store。
- [ ] `yarn test` 預期全部 PASS；以 fake count 驗證每格一個 in-flight、每 1000ms 寫入上限、1500ms settle 與 3 次失敗降級，debug 預設不印每次修正。

### 波次三：設定、雙瀏覽器建置與實測（任務 4、5）

#### 任務 4：Options 與 bridge

**輸入：** `AudioLockHandle.setEnabled`。**輸出：** 持久 options 與同頁熱切換。

- [ ] `settings.test.ts` 先 mock `storage.local` 及 onChanged，測試預設 true、false 保存、reload、刪 key 回預設、錯型 disabled；render 既有 options 表單並找到此 key 的文字與 checkbox，觸發 change 後 assert local key 寫入。
- [ ] 協定測試 ready 早於 storage read、config 早於 page listener 的重試、storage change 早於 get resolve、重複／過期 revision、storage rejection、5000ms 等待到期。foreign source/origin、錯型 enabled、未知 channel/type、合成 storage-write 訊息均被忽略。
- [ ] 執行 `yarn test tests/audio-lock/settings.test.ts` 確認 FAIL，再改 schema、新增 protocol/settings bridge，接 `contentScript.ts`、page 入口。其他既有 flags 不受設定等待影響。
- [ ] 保護開啟／關閉連續 10 次，確認無重複 listener／wrapper／Twitch trap；Mute Others 關閉期間即使 extension 開啟也完全原生；跑全測試 PASS。

#### 任務 5：建置與人工驗證

- [ ] 依下一節指令跑 typecheck、全部 tests、Chrome／Firefox build。任何 pre-existing 失敗須記錄命令、錯誤與 baseline；不能以「Vite 成功」替代 TypeScript 或真實播放器驗證。
- [ ] 檢查輸出 manifest、options entry、page script/chunks、web_accessible_resources、沒有新增權限；檢查 page bundle 沒有 storage/polyfill 呼叫，兩瀏覽器輸出內無測試 fixture、`.ref` 或 Vue 測試 runtime。
- [ ] 由 Fi 或有瀏覽器測試授權的人執行下節人工清單；填日期／瀏覽器與版本／結果／console reason／觀察時間。記錄實際廣告與重連測試；未遇到廣告寫未覆蓋，不填 PASS。
- [ ] 全部必要驗收通過才稱正式版完成；只有模擬測試及 build 時稱「可交付實測」，不可宣稱已驗證真實 Twitch。本機小 commit 依序保留，不 push、不 PR、不 merge、不公證。

## 測試

### 自動測試矩陣與逾時

| 測試檔 | 必須覆蓋與斷言 |
| --- | --- |
| state | 無／單／多初始有聲；extension × Mute Others 四種組合；A/B 切換、全部靜音、同 id 換內容；2500ms token 到期／單次消耗；epoch 過期無 effects；暫時靜音不自動 unmute。 |
| adapter | 非 top frame、非 multiview 不 patch；component 改名但相同形狀仍可用；結構錯／無 root／無 store 不動作；warn 同 code 一次；有界遍歷；player 未 ready 等待；不可寫方法兩階段回滾；他人後裝 patch 不覆蓋。 |
| players | raw constructor 與 late-bind 各一路；getter-only namespace 安全略過；getMuted 非 boolean 不變 false；throw/reject/hang/stale；不讀危險 iframe window getter；同 SDK 載入多次不重包；停用保留 SDK 值、還原 constructor/static/prototype。 |
| controller | self-unmute、first-play、manualRefresh 三入口；多 Twitch 輪流自開聲不切 active；可信命令／短 token 才切；hover、背景 tab、DevTools blur、合成事件不授權；最後命令獲勝；debounce timer／stale API／mute settle；冷卻、降級、反覆掛載清理。 |
| settings | 真正沿用 Options local schema；預設／持久／熱更新；讀取與 listener race；message validation／revision；設定停用時 pending read 零副作用；page 訊息不能修改 storage。 |

所有單元測試與 hook 各 5000ms，teardown 5000ms；timer 情境用 fake clock 推進，read timeout 750ms，root discovery 120 秒用 fake time，不實際等 2 分鐘。每個 test finally/afterEach dispose、清 timers、回 real timers、清 DOM。測試 process 另有 **120 秒 wall-clock 上限**，避免卡住 runner／fake clock；build 各 **180 秒**，install **300 秒**。逾時要非零 exit，不能把 SIGTERM 當通過。

整合 fixture 必須模擬真正的 trailing 0ms muteOthers；若 fake store 同步改 state，會漏掉這次研究發現的競態。Vue 2 fixture 只驗證 adapter 互動，不能模擬 Twitch iframe 的廣告、瀏覽器 cross-origin WindowProxy 或 isTrusted。

### 驗證指令與預期產出

建議實作環境 Node 22.12+；現有 Vite 7 需求為 Node 20.19+／22.12+，見 [Vite 7 migration](https://v7.vite.dev/guide/migration)。選定 Vitest 3.2.6 的 package 明列支援 Vite 7，避免自動安裝日後 major，見 [官方 package 定義](https://github.com/vitest-dev/vitest/blob/v3.2.6/packages/vitest/package.json)。Vitest 的逾時與獨立 config 設定見 [v3 config](https://v3.vitest.dev/config/)。

所有命令從目前 worktree 執行。若有 Yarn 1，直接使用；目前規劃環境 `node --version` 為 `v26.12.0`、沒有 `yarn` 可執行檔、也沒有 `node_modules`，因此此輪沒有安裝或執行產品建置，不宣稱 baseline build 已通過。沒有全域 Yarn 時，用 local cache 的 `npx --yes yarn@1.22.22` 代替每個 `yarn`，不全域安裝、不呼叫 corepack prepare 改家目錄。

```sh
# 僅限下一輪實作；先加上述依賴／scripts，再執行。
# cache 與 npm log 都留在 worktree；禁止把 HOME/CODEX_HOME 改作暫存路徑。
export NPM_CONFIG_CACHE="$PWD/.cache/npm"
export YARN_CACHE_FOLDER="$PWD/.cache/yarn"
export TMPDIR="$PWD/.cache/tmp"
mkdir -p "$TMPDIR"

# 初次實作更新 yarn.lock；之後重現使用 yarn install --frozen-lockfile。
yarn install --non-interactive --cache-folder "$YARN_CACHE_FOLDER"
yarn typecheck
yarn test
yarn build:chrome
yarn build:firefox
```

執行前將每個 install/test/build 命令交給執行環境的 wall-clock timeout；macOS 沒有預裝 GNU timeout 時，用 Python 標準函式庫 `subprocess.Popen(..., start_new_session=True)`、`communicate(timeout=秒數)`，逾時用 `os.killpg` 結束這次建立的 process group 並 exit 124，不留 Vite/Yarn 子行程。不為 timeout 安裝系統套件，也不以縮短 testTimeout 取代整個 process 的上限。若需要把此 wrapper 保存成檔案，限本 worktree 的 `.cache/`，不得提交。

- `yarn typecheck`：exit 0。repo 原本沒有此 script；本任務新增。不會因 Vite transpile 自動檢查 TS。
- `yarn test`：exit 0、全部預定測試 PASS、沒有 unhandled rejection、teardown 殘留或無限制重試。
- `yarn build:chrome`：exit 0；產生 `dist_chrome/manifest.json`、`dist_chrome/src/pages/options/index.html` 與帶 hash 的 assets/page 注入 script；Chrome background 為 service_worker。資源名稱以生成 manifest／HTML 引用為準，不寫死 hash。
- `yarn build:firefox`：exit 0；產生 `dist_firefox/manifest.json`、`dist_firefox/src/pages/options/index.html` 與其引用 chunks；background scripts 由現有 Firefox config／CRXJS 生成。
- 兩個輸出的 manifest 權限集合與基準相同；引用檔案全部存在。build 會清理各自 outDir，執行前確認 outDir 不是 worktree 外的 symlink，裡面沒有使用者需保留資料。
- 既有 ESLint 設定的研究記錄提到缺少 `@typescript-eslint` 套件，package 也無 lint script；若未修復，不列為已通過。不要把全面 ESLint 修復擴進這個計畫。
- 正式實作可依當輪授權提交 `package.json`／`yarn.lock` 等必要產品改動；本次規劃交付只 stage `docs/plans/twitch-audio-lock.md` 與協調者指定的 `docs/plans/prompts/` prompt 文件。不要把 node_modules、cache 或 dist 一起 commit。

### 人工測試清單（Chrome／M1 Vivaldi／Firefox）

真實瀏覽器需以兩套 build 分別測試；Chrome 與 Vivaldi 使用 `dist_chrome`，Firefox 使用 `dist_firefox` 暫時載入。每次記錄版本、OS、擴充功能 commit；無須這一輪操作瀏覽器。

| 場景 | 操作與觀察時間 | 通過條件 |
| --- | --- | --- |
| 原始問題 | 2 YouTube + 2 Twitch，Mute Others 開；面板選 YouTube A，操作其他格／等待 5 分鐘 | Twitch 不能讓 A 的 store mute 被改成 true；沒有每秒 re-mute log。 |
| 明確切音訊 | 用媒體控制逐格選 A→B→A、快速連按、靜音目前格、全部靜音／全部取消靜音；各 10 次 | 最後一次選擇生效；全部靜音不自選其他格；Mute Others 開時全部取消靜音仍只有最後一個被選格。 |
| iframe 操作 | 移入 iframe 焦點並在 2.5 秒內取消靜音；停留 30 秒、只 hover、移往 DevTools；鍵盤 Tab/Enter/Space | 短期有效意圖允許一次切換；hover／長期 focus 不續期；長期 iframe 取消靜音被擋時，面板仍可可靠切換且不報錯。 |
| 真實廣告 | A 有聲、B Twitch 靜音，等待或在可合法操作的既有播放器觸發廣告；至少觀察一個完整廣告前／中／後 | A 不被 B 奪走；記錄是否有短促漏音及持續時間，不承諾輪詢可消除瞬間漏音。20 分鐘沒遇到廣告則結束、標「未覆蓋」，不得無限等或填 PASS。 |
| 斷線／重連 | 同一選擇下，離線 10 秒再恢復；觀察恢復後 60 秒，重複 3 次 | Twitch READY／重連不搶 active；若 active 自身被系統靜音，維持保守全靜音，使用者可重新選它。網路切換僅限有操作授權者。 |
| layout 與生命週期 | 重排、刪 active、加格、同格 Twitch→YouTube→Twitch、刷新格、換 preset、離開／回 multiview，重複 10 次 | 重排保持選擇；換片／刪 active 不自選他格；無舊 player 寫入、新格能掛上；無 listener/timer 累積。 |
| options × Mute Others | 四種組合各測 1 分鐘；options 在已開頁熱切 10 次；關閉 Mute Others 後允許多格有聲 | 兩者皆開才保護；關閉後不強制 muted、不阻止原生行為；reload 保留 extension 設定。 |
| 背景／全螢幕／BFCache | tab hidden 30 秒後返回、iframe fullscreen、前進／返回各 3 次 | 不因 focus/visibility 自選他格；返回重新驗證；timer 節流後的舊結果無作用。 |
| 不相容頁 | 測試 fixture 移除必要方法或 store 欄位、沒有 Vue root、元件改名 | 改名但契約相同繼續運作；契約缺失只 warn 一次且不改 store/player，其他 Holodex 功能正常。不要在正式網站手動破壞元件。 |
| SecurityError 對照 | 同一瀏覽器/profile/layout，停用及啟用各觀察 3 分鐘；保留來源 stack 並依腳本來源分類 | 無 AudioLock 自己的 uncaught／unhandled rejection；沒有我們每次 poll 多一次危險 getter 的 stack。站方錯誤波動列 warning；無可比較基準就記未判定，不能捏造降低百分比。 |

## 驗收條件

- [ ] 產生可用的 Chrome 與 Firefox build，既有 options、注入 flags、YouTube 相關功能無退化；權限及 host 範圍不變。
- [ ] A 被使用者選定後，B 的未授權 false、首次播放、READY、manualRefresh 都不能把 active 改成 B；自動測試可重現原 bug 並驗證修復。
- [ ] 面板可明確切換、全部靜音、快速最後選擇獲勝；有界 iframe token 行為符合規格，hover 不提供永久授權。
- [ ] store debounce、750ms read timeout、1500ms settle、500ms store 收斂、舊 generation／epoch 結果與卸載都由測試覆蓋；測試及 build 的 wall-clock timeout 有效。
- [ ] 不靠元件名稱才能找得到；必要契約缺失則整組不動作、一次 warn、頁面可繼續用；不留下 mixin 或半套 wrapper。
- [ ] 原始 SDK 參考與 methods 存在 closure；不碰跨網域 window、不嘗試偽 raw 解包、不修改 Vue observer／SDK 可擴充性；無本功能產生的 uncaught SecurityError 或 Promise rejection。
- [ ] options 的 `twitchAudioLock` 預設 true、持久化、同頁熱切換；只有配合 Holodex Mute Others 才生效，沒有 localStorage 秘密第二開關。
- [ ] 人工測試有瀏覽器版本與結果，真實廣告／重連不能用 fake 或 build 成功代替；未覆蓋項目明列 warning。必要真實場景尚未通過時，只可交付候選版實測。
- [ ] 關閉／重複安裝／離開頁面釋放所有音訊相關資源；pending effects 不得在停用後改頁面。
- [ ] 本規劃回合提交範圍僅計畫文件；沒有 src、lockfile、`.ref`、產物變更，也沒有任何 remote 動作。

## 風險與不做的事

1. **跨網域意圖有歧義。** 無 Twitch mute-change event、也看不到 iframe 內可信點擊；短 token 仍可能誤把焦點附近的自動 unmute 當意圖。面板是正式支援的可靠操作路徑；不宣稱完全判別所有直接播放器操作。
2. **輪詢有空窗。** 主要時鐘為站方的 1 秒 poll，背景 tab 會節流；可能有短促漏音。這版保證不讓未授權變化變成切換命令，不承諾零毫秒漏音或 OS 音訊隔離。不增加高頻輪詢補償。
3. **Vue 2 私有結構會變。** 形狀驗證比名稱穩健但不是官方 API；React/Vue 3 升級需要新 adapter。降級會回到站方原本行為，不宣稱保護仍在。
4. **raw capture 不是反應性修復。** Vue 2 可能就地改寫原 SDK instance；late-bound 不能把它還原。已出現的 Holodex SecurityError 不保證減少。console 物件展開、深搜或 deep watch 都可能增加問題，因此禁止。
5. **SDK 攔截需克制。** 保留建構語義、descriptor 與其他頁行為；不安全就略過捕捉並採限定公開方法的 late bind，仍不可用則降級。第一版不強迫新 Twitch player `muted=true`，避免關閉設定或非 multiview 仍被影響；短初始化漏音列為限制。
6. **既有全靜音／暫時靜音。** active 自己確實回報 muted 時，本版傾向同步成全靜音，不主動 unmute，避免違反使用者靜音或 autoplay 限制；廣告後可能需要重新在面板選擇。這是待 Fi 確認的產品取捨。
7. **有限範圍。** 不做廣告攔截、不改 Twitch 影片／音量／播放品質、不改 Holodex Vuex mutation 原始碼、不修全站 SecurityError、不全域壓 console、不加 overlay、不增加遙測或遠端設定、不改其他 options 行為、不做 Firefox 發佈／簽章或 Chrome 上架。

### 規模與分波估計

估計約 12 個產品檔案（其中 8 個為新模組）、5 個測試檔＋fixture、Vitest config／package／lock／ignore 少量配套。產品碼約 650–1000 行、測試約 500–850 行；這是工作拆分估計，不是量測或硬性配額，不為達行數增加抽象。

波次一（狀態機＋測試基礎）約 0.5–1 工作日；波次二（adapter、PlayerPort、競態與意圖）約 1.5–3 工作日；波次三（options、雙 build、瀏覽器實測）約 1–2 工作日，另計等待真實廣告與無法即時重現的情境。各任務以測試與可撤銷整合為邊界，先留本機小 commit，不自動合併或發佈。

## 待 Fi 決定的問題

下列均有建議預設，Cursor 可以照預設實作候選版；變更預設時同步更新狀態機與測試。它們不代表本次已獲准實作。

1. **預設開啟與舊 off：** 建議 `twitchAudioLock=true`，且不自動遷移網站 localStorage 的 `off`；舊使用者改在 options 關閉。若要保留舊 off，另設一次性、僅讀且不覆蓋已存在 extension 設定的遷移規格。
2. **直接在 iframe 切音訊的取捨：** 建議 2500ms 一次性焦點訊號，面板為可靠入口；不採無限 hover。是否接受長時間停在播放器後取消靜音可能被壓回，或另排「聽這格」按鈕？
3. **active 因廣告／播放政策靜音：** 建議同步全靜音、需要重新選擇，避免自行 unmute。若要求跨廣告永遠保留所選 active，需分開「最後選擇」與「目前可發聲」狀態，另補使用者手動 mute 無法精確辨識的產品規則。
4. **安全降級的可見度：** 建議第一版只一次 console.warn，不加頁面通知；若 Fi 需要直接看見「保護已停用」，另排 options 狀態顯示，不能在不相容頁假裝仍保護中。
5. **站方 SecurityError：** 建議本版不嘗試 markRaw／freeze 等預防觀察補丁。若要研究另行授權一個可回退的隔離實驗，不與此正式化任務綁在一起。

Git metadata 寫入問題已由協調者在 `DISPATCH-2610171431178858` 核准必要例外，詳見全域限制，不再是待決問題。其餘寫入限制與禁止 remote 動作維持不變。
