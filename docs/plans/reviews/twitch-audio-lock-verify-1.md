VERDICT: REVISE

# twitch-audio-lock 計畫驗收報告（第 1 輪）

- 受驗計畫：`docs/plans/twitch-audio-lock.md` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc
- 本 repo 引用一律 @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc；`.ref/holodex/` 引用為 HolodexNet/Holodex @ 8c6d0dacbe93f89cd788963e2a63a095b6d3a715（`git -C .ref/holodex rev-parse HEAD` 確認）。
- 驗收日：2026-10-17。只讀原始碼核對，沒有安裝依賴、沒有執行 build 或測試。

## 已核實正確的事實宣稱（摘要）

- MediaControls 一直掛在 MultiView 上（`.ref/holodex/src/views/MultiView.vue:156-156`），`created()` 每 1000ms 呼叫 `manualCheckMuted()`（`.ref/holodex/src/components/multiview/MediaControls.vue:170-178`）；打開面板時 `manualRefresh()`（同檔 `:162-169`）→ `updateListeners()` → `$emit("mute")`（`.ref/holodex/src/components/player/PlayerMixin.ts:91-93`）。
- `setMuted(false)` 先呼叫 `muteOthers(item.i)` 再寫 `muted`（`.ref/holodex/src/components/multiview/VideoCell.vue:173-178`），首次播放也會呼叫 `muteOthers`（同檔 `:192-199`），`muteOthers` 是 `mapMutations`（同檔 `:159`）。
- store 的 `muteOthers` mutation 本體是 `debounce(..., 0, { trailing: true })`，`setMuteOthers(true)` 會挑第一個 video 為有聲（`.ref/holodex/src/store/multiview.module.ts:213-235`）。
- Twitch 建構時 options 沒有 `muted`，以 elementId 字串建構（`.ref/holodex/src/components/player/TwitchPlayer.vue:67-98`），`isMuted()`／`setMute()` 對應 `getMuted()`／`setMuted()`（同檔 `:116-122`）；READY 時 `setMute(this.mute)` 並 emit ready（`PlayerMixin.ts:43-48`）。
- `Options.schema/get/set` 使用 `storage.local`，`subscribe` 是註解（`src/utils/options.ts:31-69` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc）；options 表單自動列舉 schema（`src/pages/options/index.ts:28-109` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc）；`@utils` barrel 透過 `misc.ts` 引入 `webextension-polyfill` 的 `runtime`（`src/utils/index.ts:1-3`、`src/utils/misc.ts:1-15` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc）。
- manifest 權限與 holodex content script（`all_frames: true`、`document_start`）與計畫描述相符（`manifest.json.ts:30-49` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc）；Firefox 走 `background.scripts`（`vite.config.firefox.ts:12-18` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc）。
- `vitest@3.2.6`、`jsdom@26.1.0` 在 npm registry 上存在（`npm view` 確認）。

## 發現清單（依嚴重度排序）

### 1. [high] 沒處理 `muted` 不存在（undefined）的情況，初始狀態與新增格子的處理錯誤

**計畫位置：** `docs/plans/twitch-audio-lock.md:54-54`（cell 契約要求「`muted` 是 boolean」）、`:120-122`（初始化零格／多格有聲的轉移）、`:147-147`（擋掉沒有意圖的首次播放 `muteOthers`）、`:154-154`（store snapshot 和鎖定狀態矛盾時撤銷保護）@ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc。

**事實：** Holodex 建立 video content 時都沒有寫入 `muted`：URL 解碼（`.ref/holodex/src/utils/mv-utils.ts:109-130`）、拖放（`.ref/holodex/src/components/multiview/CellContainer.vue:101-124`）、`addVideoWithId`（`.ref/holodex/src/components/multiview/MultiviewLayoutMixin.ts:37-47`）都是這樣。`Content` 型別也沒有 `muted` 欄位（`mv-utils.ts:3-10`）。`VideoCell.muted` getter 直接回傳 `cellContent.muted`，也就是 `undefined`（`VideoCell.vue:92-96`）。player 的 `mute` prop 是 `Boolean`、default `false`，所以 undefined 等於有聲（`PlayerMixin.ts:13-16`）。新開的 multiview 或剛加的格子，會一直維持 undefined，直到第一次有 `muteOthers`／`setMuted` 寫入為止。原生 Holodex 靠首次播放的 `muteOthers(self)` 把多格有聲收斂成單格（`VideoCell.vue:195-198`）。

**失敗情境：**
- (a) 照字面實作 `muted` 必須是 boolean 的契約，最常見的「從 URL 打開 multiview」或「剛加入一格」都會讓契約失配，結果是 degraded，而且照 `:60` 不再重試。保護在最需要的時候反而不會啟用。
- (b) 把 undefined 當成 false 的話，初始化就是「多格有聲」。依 `:122` 會進 waiting-for-choice、只壓回本來就標成 muted 的格（沒有這種格），再依 `:147` 擋掉首次播放的 `muteOthers`，結果 2 YouTube + 2 Twitch 四格同時出聲，直到使用者打開面板手動選一格。這是比原 bug 更明顯的退化，也違反「不改 Holodex 本身行為」。
- (c) 已鎖定 A 時新增一格，snapshot 會多出一格 muted 為 undefined（有聲）的格子。依 `:154`，這屬於「未經授權、與鎖定矛盾」，會撤銷整組保護。換 preset（整批 layoutContent 換掉）也一樣。

**要求修改：** 在狀態機和 adapter 契約裡明確定義 `muted ∈ {true, false, undefined}`，undefined 視為「Holodex 尚未指派」，不算失配。規格要寫清楚初始化多格有聲、或新格 undefined 時的收斂規則，例如「Mute Others 開時，沒有 active 就照原生允許首次播放的 `muteOthers` 一次；已經有 active 時，把新格壓成 muted」，並列入 Fi 決策。state／controller 測試加上「URL 載入四格全 undefined」「locked 後新增一格」「換 preset」三個情境。

### 2. [high] 面板 trusted 授權用 microtask 清除，真實瀏覽器上會在 Holodex handler 執行前就失效

**計畫位置：** `docs/plans/twitch-audio-lock.md:135-135`（「在該事件的同步 dispatch 期間開啟操作資格，microtask 即清除」）、`:253-253`（jsdom 用注入的 trusted adapter 測試）@ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc。

**事實：** 依 HTML 規格，瀏覽器派送的使用者事件在每個 listener callback 結束、JS 執行堆疊清空時，會做一次 microtask checkpoint。所以在 document／window capture listener 裡排的 microtask，會在 Vuetify `v-btn` 的 bubble 階段 `@click` 執行之前就跑完。面板按鈕的 handler 是同步呼叫 `cellState.setMuted(...)`／`allCellAction('unmute')`（`.ref/holodex/src/components/multiview/MediaControls.vue:30-39`、`:90-94`、`:192-209`）。程式呼叫的 `el.click()` 或 `dispatchEvent` 堆疊不是空的，microtask 會延到整個 dispatch 結束，所以 jsdom 和 fixture 測試會通過。

**失敗情境：** 實作照字面寫 `queueMicrotask(clear)`，在 Chrome／Firefox 真機上，面板點 B 時 wrapper 收到 `setMuted(false)` 的當下授權已經被清掉。計畫自己說的「可靠路徑」會整個失效：面板切換被當成未授權觀察壓回，或觸發 `store-did-not-settle` 降級。自動測試抓不到這個問題，只有人工測試會發現。

**要求修改：** 改成在 window capture 開啟、在 window bubble（最後一個 listener）關閉，再加 `setTimeout(0)` 保底，或以 `event` 物件身分配對。測試要明確模擬「listener 之間會跑 microtask」的順序，例如在測試中於 capture 與 bubble 之間手動 flush microtask，並在人工清單加一條「面板點選第一次就成功切換」。

### 3. [medium] 會改變 Holodex「新加入／開始播放的格子取得聲音」的原生行為，YouTube 也受影響，但沒有列為 Fi 決策

`:128`、`:147` 擋掉所有 provider 的首次播放 `muteOthers`。原生 Holodex 是刻意讓新開播的格子取得聲音（`VideoCell.vue:192-199`、`:211` 註解「On play it should take focus to new stream」）。原型只擋 Twitch（`src/pages/content/holodex/twitch-audio-lock.ts:194-201` @ d33360bb4bb1c1e8f8fb1e29e4ecc038534e86bc）。這是產品行為改變，應列入「待 Fi 決定的問題」：只擋 Twitch／只在已有 active 時擋／全擋。這一題和發現 1 的初始化規則要一起決定。

### 4. [medium] Twitch constructor `Proxy` 加上 `window.Twitch` assignment trap 是沒有實益的複雜度

`:92-95`、`:203`、`:242`、`:284` 要求 Proxy 捕捉建構、暫時 accessor trap、64 筆／120 秒 registry，以及 descriptor 還原測試。但計畫自己也承認，Vue 2 是在原物件上就地加 getter（`:100-103`），而 Holodex 的 `this.player = new window.Twitch.Player(...)`（`TwitchPlayer.vue:86`）存進的就是同一個 instance。所以建構當下捕捉的參考，和 late-bind 從 `$refs.player.player` 拿到的物件完全相同，呼叫 `getMuted`／`setMuted` 時的存取面也一樣。原型保留 trap 是為了改 `muted: true`，正式版已經放棄這點（`:360`），trap 失去用途，只剩下改動全域 SDK descriptor 的風險，以及關閉設定時的卸載複雜度。建議第一版只做 late-bind（計畫已把它列為 fallback 並有測試），刪掉 Proxy、trap 和 registry，`players.ts` 與測試矩陣可以大幅縮小。

### 5. [medium] Vitest config 沒有 path alias，計畫要求的 options 表單測試無法載入

### 6. [low] `yarn typecheck`（`tsc --noEmit`）沒有涵蓋 `tests/`、`vitest.config.ts`

### 7. [low] 設定橋接（ready 重試、revision、讀取世代、5000ms 等待）對單一布林值偏重，可以簡化

### 8. [low] `.gitignore` 已有 `.cache` 規則，計畫列的修改大多不需要

## 給 Fi 的摘要

這份計畫對 Holodex 呼叫鏈的查證大致正確：1 秒輪詢、`manualRefresh`、trailing debounce、首次播放搶聲都對得上原始碼。四段（檔案、步驟、測試、驗收條件）也齊全，逾時與「不可宣稱已驗證真實 Twitch」的紀律都寫得很清楚。但有兩個會直接讓功能壞掉的問題。第一，Holodex 新格子的 `muted` 預設是「沒有值」，計畫沒有處理，照做會讓保護在一般開頁時不啟用，或讓所有格子同時出聲。第二，面板點擊的授權用 microtask 清除，在真瀏覽器裡會在 Holodex 處理點擊之前就失效，而自動測試抓不到。另外，「新開播的格子要不要搶到聲音」是產品決定，應該由你拍板。Twitch constructor 攔截那一整套可以刪掉，讓實作更小更穩。建議請規劃者修正後再交給 Cursor。
