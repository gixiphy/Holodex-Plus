# Twitch audio lock 正式版細部實作計畫

> 執行者：Cursor。這份文件包含實作所需的設計與驗證規格，不依賴本次對話或 `.ref/` 才能理解需求。按「步驟」逐項實作；本次規劃交付不包含產品程式碼。

日期：2026-10-17。擴充功能基準：`gixiphy/twitch-audio-lock`，`eda5b52`。Holodex 參考基準：`HolodexNet/Holodex` dev 的 `8c6d0dacbe93f89cd788963e2a63a095b6d3a715`，Vue `^2.7.8`、Vuex `^3.6.2`。線上版本是否相同必須以執行期契約檢查確認，不能僅憑研究筆記認定。

第 2 版依 `docs/plans/reviews/twitch-audio-lock-verify-1.md` 修訂（報告基準 `d33360b`），修訂提交為 `0ab5af5`。第 3 版依 `DISPATCH-2610171451093196` 增加獨立上游 PR 範圍與打包；文末保留逐項驗收回應，報告本身不修改。

第 4 版依第 2 輪驗收報告（受驗提交 `09b7bf2`，報告提交 `e9ed025`）處理 N1–N4；「驗收回應（第 3 版）」對應這輪新發現，不表示修改原審查報告。

**目標：** Holodex multiview 開啟 Mute Others 時，Twitch 自行取消靜音、初始化或重連不得搶走使用者選定的聲音；使用者仍能明確切換或全部靜音。

**架構：** 保留現有 content script → page script 注入途徑。將純狀態機、Vue 2 相容層、播放器 API、意圖追蹤與設定橋接分開；Vuex 保留 Holodex 的畫面狀態，狀態機保存短期使用者意圖與非同步操作世代。

**技術／工具取捨：** 既有 Vite 7.1.11、TypeScript、`webextension-polyfill`、原生 DOM；options 是 TypeScript 動態表單。audio lock 的本文預設保留 Vitest 3.2.6＋jsdom 26.1.0（兩個測試 devDependency），因為需要 DOM/options 與 watcher／計時器回歸；不加 Vue runtime。另一個 auto-multiview-layout PR 已選 node:test、零新依賴，兩案目前工具不同，並非已達成統一。Fi 題 8 可選接受不同／兩案統一 node:test／兩案統一 Vitest；選統一時需分別修訂各案計畫，不共享新 runner 或先合併工具 PR。lint 工具一律只在 worktree .cache 臨時安裝，不加回產品依賴。

**交付定位：** 本 worktree 的 `gixiphy/twitch-audio-lock` 是含原型、計畫、prompts、reviews 的工作分支，不能直接送上游。最終產品從 `upstream/dev` 的 `709e96319bc93965509f83e5f2a897b5d2dc37c7` 整理成乾淨 `fi/twitch-audio-lock`，方向為 `gixiphy/Holodex-Plus:fi/twitch-audio-lock` → `HolodexNet/Holodex-Plus:dev`。這是未來交付規格，**本輪禁止建立／切換分支、push、開 PR 或 merge**；具體白名單與未來打包門檻見「上游 PR 打包」。

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

新增格子的 `muted` 可以不存在：URL 解碼、拖放、`addVideoWithId` 都只建立 id/type/video，沒有 muted（`.ref/holodex/src/utils/mv-utils.ts:110`、`.ref/holodex/src/components/multiview/CellContainer.vue:101`、`.ref/holodex/src/components/multiview/MultiviewLayoutMixin.ts:37`）。`VideoCell.muted` 直接返回該欄位（`VideoCell.vue:95`）。因此 adapter 必須接受 undefined，且不能單純把所有 undefined 強制轉 false 後停在多格有聲。

Fi 已在 M1 Vivaldi 用 unpacked 原型確認功能有效。約 6800 次 SecurityError 是使用者的單次觀察，沒有固定觀察期間或可重複基準，不用它作為性能或錯誤次數門檻。研究筆記記載的廣告、重連原因仍是待驗證推論，不能寫成已重現的因果。

### 全域限制

- 禁止 push、開 PR、merge、公證與 sudo；本輪不建立或切換任何分支。不得自動發佈或安裝到瀏覽器。「上游 PR 打包」只記錄後續交付流程，不授權現在執行這些動作。
- 本輪修訂只修改並提交 `docs/plans/twitch-audio-lock.md`；不修改 `src/`、`.ref/`、prompt、審查報告、依賴或 lockfile，不提交建置產物。下文產品改動均屬下一輪實作。
- 所有產品、文件、工具快取與測試輸出只放目前 worktree；不修改 iCloud 主 checkout、家目錄或 `.ref/`，不刪除 worktree 外的內容。
- 這個 worktree 的 `.git` 指到 `~/Documents/Code/私人專案/Holodex-Plus/.git/worktrees/twitch-audio-lock`。協調者已於 `DISPATCH-2610171431178858` 明確允許 commit 必要的 Git metadata（含主 checkout `.git` 的物件與 refs），視為本 worktree 範圍；可以在目前分支 stage/commit，不得切分支或 push。此例外不允許修改主 checkout 的產品檔案或其他家目錄內容。Git 唯讀檢查設定 `GIT_OPTIONAL_LOCKS=0`。
- 目前 worktree 不在 `~/Documents`；快取直接放此 worktree 的 `.cache/`、`node_modules/`、`dist_chrome/`、`dist_firefox/`。不建立指向 `~/Library/Caches` 或 iCloud 的 symlink，不使用 `.nosync`。如後續換到 Documents 下，先解決寫入限制，不能照搬這份命令去寫家目錄。
- 保留 MIT 授權；不複製 Holodex 元件實作進本 repo，不記錄帳號、token、完整 Vue store 或 player 物件。

### 第一個 PR 的範圍

第一個 PR 僅解決「Mute Others 下非使用者選擇的 Twitch 取消靜音搶聲」，並帶上使它可安全使用的選項、相容性降級與必要回歸測試。這是一個功能 PR，三波／五任務是同一 PR 的實作順序，不拆出必須先合併的 framework/helper PR。

- 包含：三態 muted 初始化／新增格／preset、輪詢與 manualRefresh 與首播攔截、可靠面板選聲、短期一次性 iframe 意圖、late-bind API 錯誤邊界、清理與熱切換；不犧牲第 2 版修正的兩個 high 項目來縮小行數。
- 包含：`twitchAudioLock` schema/description 的小幅新增、既有 flags 旁的單一安裝入口、feature 專用測試/config/scripts、只為 Vitest/jsdom 所需的 lockfile 差異；不加回 lint parser/plugin。零新 runtime dependency、零新權限、零通用 helper。
- 縮小模組面：意圖追蹤與 gate 合併到 controller.ts，message 型別／validator 與窄型別合併到純 contracts.ts；共六個新產品模組。contracts 只在本功能的 page/content contexts 共用，不為 auto-multiview-layout 抽 root finder、storage bus、Vue adapter 或事件工具。

### 之後再說的範圍

真實 Vue 2 runtime fixture、coverage/benchmark、Playwright 或真瀏覽器自動化平台、全站 lint 修復／ESLint flat config／Prettier 導入、Node/CI 升級、Vue 3/React adapter、跨功能 Vue/store/helper 抽象、狀態 UI/overlay、舊設定遷移，以及站方 SecurityError 修復均不進第一個 PR。第一個 PR 仍須完成真瀏覽器人工清單；未完成不能用「日後會補 E2E」代替驗收。

auto-multiview-layout 是另一個獨立 PR，不屬於上述後續相依工作。兩個 PR 各自從同一指定上游基準成立，不能等待或借用對方的產品 commit、測試 setup、新模組或 helper；最終新增 commit 集合不相交（共用既有 upstream 祖先是正常的）。

### 上游程式風格與工具基準

以下已對本機 `upstream/dev@709e963` 與目前未改動的設定逐項查閱；Cursor 實作前重讀它們，不從另一個任務或個人偏好搬設定：

| 既有檔案／現況 | 本 PR 規則 |
| --- | --- |
| `.eslintrc` | ESLint 8 legacy config，extends eslint/recommended、React recommended、TypeScript recommended；parser/plugin 指向 @typescript-eslint，no-explicit-any 為 warn。沿用此設定，不遷移 flat config、不降低 rules、不加整檔 eslint-disable。頁面邊界用 unknown＋窄介面／type guard，避免沿用原型整檔 any 禁用。 |
| `.vscode/settings.json` | insertSpaces=true、tabSize=2，TS/JS/JSON editor formatter 指向 Prettier extension。新增 TypeScript 用 2 spaces、雙引號、分號，遵循鄰近 src/utils/options.ts 與 holodex-inject.ts；不批次重排既有格式。 |
| 沒有 `.prettierrc*`、prettier.config、Prettier CLI dependency/script | eslint-config-prettier 雖已安裝，.eslintrc 沒有 extends 它，不能宣稱 repo 強制 Prettier。此 PR 不加 Prettier，也不跑 npx prettier --write 全專案；以鄰近檔案習慣與 diff --check 檢查新增行。 |
| `tsconfig.json` | strict、noEmit、ESM、DOM libs，@utils/@assets/@pages 等既有 alias。產品 tsconfig 不改；測試專用 tsconfig 延伸它。新型別／constants 用明確命名與具體型別，不把 Window 擴充成全域 any。 |
| `src/pages/content/holodex/`、`src/utils/options.ts` | 區域模組用相對 import，跨既有 utility 用 @utils；page-context 新模組只相對 import 純 TS，防止 barrel 拉入 extension API。檔名採 audio-lock 既有 kebab-case 系列，函式 camelCase、型別 PascalCase。不新增泛用 utils export。 |
| `src/pages/options/index.ts` | schema-driven 原生 DOM 表單，新增 schema/description 就自動有開關。第一個 PR 不改 options UI、HTML/CSS 或改成 React。 |
| `src/pages/content/holodex/holodex-inject.ts` | 既有 ARCHIVE_CHAT_OVERRIDE、HOLODEX_PLUS_INSTALLED、HOLODEX_PLUS_INSTALLED_V3 flags 保留值與時序；只加 audio-lock 相對 import／install 呼叫。不得順便改其他旗標或新增全站 audio flag。 |
| `package.json`、`.nvmrc`、`.github/workflows/ci.yml` | 無 lint/test script；.nvmrc 是 18.17.1，手動 CI 用 Node 18，但既有 Vite 7 需要較新 Node。這是 baseline 工具鏈落差，第一 PR 不改 CI/.nvmrc；用 Node 22.12+ 做本機驗證，PR 草稿如實註記，不能宣稱舊 CI 已通過。 |

**上游移除歷史：** `a5ff26975574923f894c3c1b4ee2b3bbf9125576`（2024-12-29，latest）的 package.json diff 明確移除 `@typescript-eslint/parser` 與 `@typescript-eslint/eslint-plugin` 的 `^7.8.0`。目前 .eslintrc 仍引用它們，不能只稱為偶然漏裝，更不能預設把新版加回功能 PR；移除原因未在該 diff 說明，不推測維護者意圖。本輪用 git show 只讀確認，沒有安裝套件。

**lint 預設方案：** 不改產品 package.json／yarn.lock 的 lint 依賴或 scripts。在 `.cache/audio-lock-lint/` 臨時安裝 ESLint 8.57.0、React plugin 7.37.2、parser/plugin 同版 8.18.0、TypeScript 5.6.3；這是驗證環境，不是產品依賴。8.18.0 的 [官方 parser peer range](https://github.com/typescript-eslint/typescript-eslint/blob/v8.18.0/packages/parser/package.json) 接受 ESLint 8.57 及 TS 5.6，與現有 yarn.lock 的 TS 5.6.3 相符；不能拿不相容舊版的警告當 pass。從 .eslintrc 產生本地 CJS config，只把 parser 解析為暫存環境的絕對路徑，保留所有 extends/rules/env；CLI 關閉自動尋找其他 config，plugins 從暫存環境解析。全部操作／npm cache／logs 只在 worktree，scope 與既有整合檔 baseline 用同一套環境；具體命令見打包段。產品 PR 排除整個 .cache，不讓維護者重新承擔被移除工具的依賴變更。

## 設計

### 1. 掛勾、相容性偵測與生命週期

使用 `createHolodexAdapter(window, document, report)`，將所有私有結構存取集中在 `audio-lock/holodex-adapter.ts`。不用元件名稱作為必要條件，也不註冊不可撤銷的全域 `Vue.mixin()`。

**發現順序與契約：**

1. 僅在 top frame 啟動 audio lock。先判斷 `location.pathname` 符合 `/^\/multiview(?:\/|$)/`；一般 watch、首頁、YouTube 頁及子 frame 不改音訊。
2. 從 `#app`、`[data-app]` 及 `.multiview` 的祖先讀取各自的 `__vue__`，再取 `$root`；若缺少，對候選 app 容器最多掃描 500 個 DOM 元素尋找 `__vue__`。不掃描 iframe 內部。
3. 只透過 `$children` 遍歷 Vue instance，以 `WeakSet` 防循環，上限 2000 個 instance；禁止 `searchObject()`、遞迴 `Object.entries(vm)`、遍歷 `$data` 或任意 player 子欄位。碰到例外即回傳相容性失敗，不繼續擴大搜尋。
4. 驗證候選 store 的 `commit`、`watch`、`subscribe` 都是 function，`state.multiview` 有布林 `muteOthers`、陣列 `layout`、物件 `layoutContent`。不依賴 `_mutations` 等 Vuex 私有註冊表。
5. 優先取持有 `$refs.videoCell`／`videoRefs` 的 multiview instance；缺少這些名稱時，用有界 `$children` 搜尋相同形狀。VideoCell 候選必須同時滿足：`item.i` 是 string/number、相同 store、對應 layout item 與 `type: 'video'` content 存在、`cellContent` 對應同一 content、`$el` 是連接中的本頁 Element、`manualCheckMuted`／`setMuted`／`muteOthers`／`updatePausedState` 是 function、`muted ∈ {true, false, undefined}`、`isTwitchVideo` 是 boolean。undefined 表示尚未指派，不是失配；null、字串等其他值才是失配。名字 `VideoCell` 只能當診斷提示。
6. player 尚未 ready、`$refs.player` 尚未存在是正常等待狀態；存在時必須有 `isMuted`、`setMute`，以及本頁 iframe 與 content provider 一致。iframe URL 用 `new URL(iframe.src)` 檢查 hostname allowlist：Twitch `player.twitch.tv`，YouTube `www.youtube.com`／`www.youtube-nocookie.com`；不可用子字串匹配。只讀 iframe Element 的屬性，不讀 contentWindow 的屬性。
7. 全部可見 video cell 都符合 cell 契約，才兩階段安裝 cell wrappers。尚未出現 iframe／SDK instance 的 cell 標為 pending-port，先保護其 cell 方法，等 READY 再綁 PlayerPort；不能因新增一格未 ready 而撤銷既有 active 的保護。不要在 SDK 尚未 ready 時改其 mute prop 或呼叫 API。已有 instance 卻缺少必要公開 method 才是失配。未知第三方 player、同 id 多個連接中的 cell、超過掃描上限均視為不相容。空 multiview 與暫時載入中的 player 保持 waiting，最多 120 秒，不把正常空畫面報成錯誤。

**發現時序：** 進入 multiview 或重新開啟設定後立即探測；前 15 秒每 250ms 一次，其後每 2000ms 一次，總計不超過 120 秒。找到相容 root 後改成容器的 `MutationObserver({ childList: true, subtree: true })`，合併到下一個 animation frame 再檢查，並每 2000ms 做一次輕量 cell 身分核對。沒有每秒全樹無限遍歷。路由以 Vue Router `afterEach` 訂閱及可撤銷的解除函式為主；root 尚未取得時用 2000ms pathname 檢查，不修改 history API。

**啟用與降級：** 每次啟用前做兩階段處理：先收集與驗證，再一次安裝所有 cell wrapper；任何不可寫方法或安裝失敗都回復本次已裝項目。結構不相容時不呼叫 player、不寫 store、不留下半套 patch，`console.warn('[Holodex+ AudioLock]', { code, adapterVersion: 1 })` 每 document 每 code 最多一次。不要把 VM、SDK、Error 物件丟到 console。發現契約永久失配後進入 degraded，不繼續密集重試；下次路由進入、設定重新開啟或 reload 才再探測。

原型的 `window.__HDX_AUDIO_LOCK__ = true` 改成可釋放的 controller handle。`installAudioLock(): AudioLockHandle` 要冪等；`AudioLockHandle` 提供 `setEnabled(value: boolean): void`、`dispose(): void`。停用、離開 multiview、root 被換掉、`pagehide` 都取消該次音訊 session 的 timer、observer、DOM listener、store watch/subscribe、Vue ready listener 與非同步結果。入口的最小設定／路由／`pageshow` bootstrap 保留以便重啟；`pageshow`（包括 BFCache）重新驗證，只有最終 `dispose()` 才連 bootstrap 也一起移除。每個 disposer 可重複呼叫。restore 方法時只在目前值仍等於我們的 wrapper 才復原，不覆蓋第三方後裝的 patch。

**Holodex 改版偵測：** 以 `adapterVersion: 1` 的上述契約做行為檢查；不比較 minified function 的字串或寫死線上 bundle hash。記錄簡短 reason code，例如 `root-timeout`、`store-shape-changed`、`cell-contract-changed`、`provider-unsupported`、`patch-not-writable`、`player-unavailable`。新版本仍符合契約可繼續運作；不符合則停用。Vue 3／React 重寫不自動支援。

### 2. PlayerPort 與 SecurityError 邊界

介面定義在 `audio-lock/contracts.ts`：

```ts
type CellKey = string; // String(item.i)
type MutedAssignment = true | false | undefined;
type CellIdentity = {
  key: CellKey;
  contentId: string;
  provider: 'youtube' | 'twitch';
  generation: number;
};
type ReadMuted =
  | { kind: 'known'; muted: boolean }
  | { kind: 'unavailable'; reason: 'not-ready' | 'timeout' | 'access-error' };
type SelectionGrant = {
  identity: CellIdentity;
  epoch: number;
  source: 'bootstrap' | 'explicit';
};
interface PlayerPort {
  readMuted(): Promise<ReadMuted>;
  mute(): Promise<boolean>;
  restoreSelectedAudio(grant: SelectionGrant): Promise<boolean>;
  dispose(): void;
}
```

PlayerPort 不提供任意 `unmute()`；一般輪詢只能 mute。唯一例外是 `restoreSelectedAudio(grant)`：只在剛獲准的 bootstrap／明確選擇交易中，為了補足 U→false 不觸發站方 Boolean prop watcher 的情況，允許一次恢復所選 player。它使用與站方 setMute(false) 相同的公開 SDK 路徑（Twitch setMuted(false)、YouTube unMute()），仍以原始綁定 method、ready、try/catch、Promise rejection／750ms timeout 邊界執行；不呼叫 play，不修改 SDK 內部或 Vue observer。SDK 回傳 false 是已知沒靜音；undefined、非 boolean、異常回傳不可用 `!!value` 強制轉成「沒靜音」。這與合法的 store 未指派值分開處理。

**取得原始參考的策略（第 2 版只做 late-bind）：**

- Twitch：只從已驗證 `$refs.player` 的單一 `player` 欄位取得現有 instance，將 `getMuted`／`setMuted` 這兩個公開 method 綁定該 instance 保存在 closure。不攔截建構、不改 `window.Twitch`／`Twitch.Player`、不代建 iframe、不重建 player，也不改任何 SDK descriptor 或 options。
- Vue 2 就地觀察該 instance，建構當下捕捉的參考與 late-bind 仍是同一物件；提前捕捉不能保證日後 method 執行時未經 reactive getter。因此移除 Proxy、assignment trap、未配對 instance registry 與其 64 筆／120 秒管理。這是縮減風險，並未改用會遍歷 SDK 的方案。
- 實例還未建立屬 not-ready；實例存在卻無法取得必要公開 method 則整組降級。這是 late-bound 原始參考，**不是**還原成未觀察物件；不能深入 SDK 或讀 iframe window 尋找「更 raw」的版本。
- YouTube：同樣只取已驗證 player component 的 `player` 原始參考，綁定 youtube-player 公開 `isMuted`／`mute`／`unMute`；最後一項只有上述 selection grant 可用。它可能回傳 Promise，必須接受並處理。不在我們的輪詢中呼叫 component `isMuted()` 來穿越更多 Vue 層。
- 綁定函式、以已配對 cell 為 key 的 WeakMap 與 controller handle 都只存在 closure／非 reactive 的擴充功能物件，不塞進 VM、Vuex、`$data`。已被 Vue 2 觀察的 SDK 原始 instance 仍可能有 reactive getter；這個策略減少我們的存取面，不能承諾把 SDK 去 reactive。

read 前必須確認 ready：在 player component 用 Vue `$on('ready', listener)`／`$off` 取得訊號；若 late-bind 發生在 ready 之後，Twitch 以 `cell.twPlayer === boundInstance`、YouTube 以已存在的 `cell.ytPlayer` 與已驗證 binding 判定。不使用 SDK 私有 ready 欄位，也不把 SDK 初始快取 false 當真實 unmute。沒有 ready 訊號時回 not-ready，配合 120 秒有界等待。不向 SDK 添加無法移除的事件 listener；需要重新 reconcile 的 READY 使用這個 Vue 事件，PLAYING/ONLINE 若沒有可撤銷公開訂閱就省略，既有 polling 仍可處理恢復。

**Vue 2 的判斷與取捨：** Vue 2 的 reactive 主要是直接對原物件加 getter/setter；`vm.$data.player`、`player.__ob__.value` 不是通用的 raw escape hatch。Vue 2.7 的 `markRaw` 會設 skip 標記，但不撤銷既有 observer；不能把 Vue 3 的 `toRaw` 當作修復。這點依據 [Vue 2.7 reactive 原始碼](https://github.com/vuejs/vue/blob/v2.7.16/src/v3/reactivity/reactive.ts) 與 [observer 原始碼](https://github.com/vuejs/vue/blob/v2.7.16/src/core/observer/index.ts)。

對新建 instance 先 `markRaw`／設 `__v_skip`、`Object.preventExtensions`／freeze、偽造或刪除 `__ob__` 雖可能影響觀察過程，也可能破壞 SDK 後續新增欄位、Holodex watcher 與 plugin。**正式版第一版不採用這些修改。** 不修改 `_embedWindow` descriptor、不 patch Vue observer／Vue.config.errorHandler、不攔截全頁 console/error、不使用 `preventDefault()` 隱藏網站錯誤。若未來要降低 Holodex 自身錯誤，另立實驗，以相同 SDK／頁面做相容測試後再決定；本功能不承諾消除它。

**所有邊界：** VM getter、DOM 查詢、原始 method 取得與呼叫、store 操作均包 try/catch；Promise rejection 也必須接住。每次 player read／mute 有 750ms timeout；timeout 後保留 rejection handler，遲到結果用 generation 丟棄。不可 await 永不 resolve 的 SDK Promise 卡住下一次輪詢。

不讀 `iframe.contentDocument`、`contentWindow.document`、window location、`_embedWindow` 或未公開內部欄位；不列舉、深拷貝、serialize player。Twitch 使用公開 [getMuted／setMuted API](https://dev.twitch.tv/docs/embed/video-and-clips/)；官方事件清單沒有 mute-change 事件，不假設存在這種事件。READY／PLAYING／ONLINE 只能通知重新讀狀態，不算使用者意圖。

短暫 not-ready 不 warn、不增加錯誤計數。每次 access-error 或 timeout 將連續失敗數加一，接著該 cell 冷卻 5000ms，不讀 API；累計連續 3 次即以 `player-unavailable` 整組卸載保護並 warn 一次。每次成功 read 清掉連續失敗數；每次新的 player generation 可重新嘗試。不要在每個 tick 印 re-mute log。

### 3. 意圖來源、狀態機與輪詢競態

**狀態：** `mode: 'disabled' | 'discovering' | 'waiting-for-choice' | 'locked' | 'degraded'`，另有 `selection: 'bootstrap' | 'selected' | 'silence'`、`active: CellIdentity | null`、`epoch: number`、`intent: { identity, source, expiresAt, consumed } | null`、`selectionGrant: { grant: SelectionGrant; consumed: boolean } | null`，以及各 cell 的 read/mute in-flight、同 generation 的 guard-mute 紀錄、最後寫入時間與連續失敗數。active 綁定 key + provider + contentId + player generation，不能只用 DOM 順序或格子索引。重新排序不改 active；換片、換 provider、重建 player 時舊非同步結果及 token/grant 必須失效。active=null 不足以決定是否允許首播：bootstrap 可初始化一次，silence 必須保持全靜音。

store 的 `MutedAssignment` 保留 true／false／undefined 三態；primitive snapshot 明確編成 `M`／`A`／`U`，不要用 JSON 省略 undefined 後丟失差異。undefined 的原生播放器效果雖近似 false，但語義是「Holodex 尚未指派」，不能因此 degraded，也不是使用者取消靜音的證據。它與 PlayerPort.readMuted() 的未知回傳不同：SDK 回傳 undefined 仍是 unavailable。

**desired 狀態必須先判斷 selection，不能用 active=null 推導「全部非 active 都應靜音」。** 在 state.ts 實作純函式 `desiredMute(state, assignment, identity): 'muted' | 'audible' | 'unassigned'`：

| selection／條件 | desired 結果 | poll 行為 |
| --- | --- | --- |
| disabled／discovering／degraded | unassigned | 不發音訊 effects。 |
| bootstrap，assignment 為 U 或 false | unassigned | **不發 MUTE_PLAYER、不改 store、不因讀到 true 進 silence**；等首播／fallback／明確選擇。 |
| bootstrap，assignment 為 true | muted | 已知 false 時可壓回，維持站方已有靜音指派。 |
| selected，identity 是 active | audible | 不壓靜音；有尚未完成的合法 selection grant 時可做一次恢復。 |
| selected 的其他格／silence 的所有格 | muted | 已知 false 時按限速壓回；U 格 ready 後正規化 true。 |

U→false 的 store 變更不等於播放器會被取消靜音：PlayerMixin 的 Boolean mute prop 預設 false（`:13`），所以 U 與 false 可落成同一個 effective prop；Twitch mute watcher（`TwitchPlayer.vue:57`）與 YouTube mute watcher（`YoutubePlayer.vue:45`）不會因此觸發。必須用下面的選聲交易補足，不能假設 mutation 已代表實際有聲。

純函式為 `transition(state: LockState, event: LockEvent): { state: LockState; effects: LockEffect[] }`，時間由 event 的 `now` 注入；不在 reducer 讀 DOM、store、Date.now 或 player。`LockEvent` 至少包含 `ENABLE`、`DISABLE`、`DISCOVERED`、`NATIVE_FIRST_PLAY`、`BOOTSTRAP_READY`、`LAYOUT_CHANGED`、`PLAYER_READY`、`EXPLICIT_SET_MUTED`、`IFRAME_INTENT`、`OBSERVED_MUTED`、`STORE_SNAPSHOT`、`CELL_REMOVED`、`CONTRACT_FAILED`。effects 包含 `MUTE_PLAYER`、`CALL_ORIGINAL_SET_MUTED`、`CALL_ORIGINAL_MUTE_OTHERS`、`RESTORE_SELECTED_AUDIO`、`SET_STORE_MUTED`、`REPORT_ONCE`，附 identity 與 epoch；套用前再次核對最新狀態。`SET_STORE_MUTED` 僅能寫 true，使用站方 `multiview/setLayoutContentWithKey`，不得直接修改 reactive 物件或誤觸 solo。

**預設初始化／新增／preset 規則（與 Fi 選項題 1、2 一致）：**

- 初次非空 snapshot 若恰有一個明確 false，採它為 active；其他 U 不算第二個選擇，待 ready 後正規化成 true。若所有 video 都是 true，進 silence。空 layout 留在 bootstrap 等 cell，不挑不存在的 active。
- 其他初始組合（全 U、多個 false、U 與 true 混合且沒有唯一 false）進 bootstrap；保留原生首播選聲**一次**，YouTube／Twitch 都可。第一個實際進入原生 first-play `muteOthers(self)` 的 cell 立即保留 active、epoch++，再放行原 mapped method；後來的 first play 即使在 debounce 尚未寫 state 前也不得覆蓋。bootstrap 是初始化來源，不偽稱使用者命令。
- 若掛勾晚於 first play，已有 ready 且 `editMode === false` 的 U／false cell，排一次 1000ms fallback；執行時仍為同 epoch 的 bootstrap 才按 layout 順序選第一個這類 cell，呼叫原 `muteOthers` 一次收斂。paused／未 ready／明確 true 不參選；沒有播放候選就等待，不呼叫 play；選格取消靜音只依下述單次 grant，不假定 U→false 會觸發 watcher。這避免四格一直同時有聲，又不把「全靜音」當作 bootstrap。
- 已 selected 時新增 U 格不影響 active：立即在 controller 標為 desired-muted，先裝 cell wrappers 擋首播搶聲；等該 player READY 後以 `SET_STORE_MUTED(true)` 正規化並透過 PlayerPort 壓回聲音。SDK 未 ready 前不改 mute prop，避免觸發 `TwitchPlayer.vue:57` 的 watcher 去呼叫尚未存在的 `setMuted`。silence 下新增格也同樣靜音。ready 前的短暫漏音仍屬輪詢／初始化限制。
- `setLayoutContent` 加 `setLayout` 的一批 preset 操作合併到後續 macrotask 判定，先使舊 generation／read／token 失效；若原 active 的 key/provider/contentId 仍在（包括 merge preset），保留它並正規化新增格。若 active 已不在且原 selection 不是 silence，開始新的 bootstrap；原本 silence 則維持 silence。單格刪除／替換 active 則進 silence，不能被誤判為整批新 preset。只有順序或尺寸改動不重置選擇。

**所有「選成 active」的路徑使用同一個選聲交易，不能只補 mapped mutation：**

1. bootstrap 原生首播、1000ms fallback、明確面板選擇／有效 iframe token 都先設定 active、epoch，建立同 identity/epoch 的一次性 SelectionGrant，再呼叫原 mapped mutation 或帶授權的 setMuted(false)。原本 U／false 的 setMuted 提前返回規則仍依攔截段補 mutation 恰一次。
2. 在 debounce 的後續 macrotask 確認 store 已收斂且 player ready，做一次 fresh read。若讀到 true，或這一 generation 曾被我們發出 mute，產生 RESTORE_SELECTED_AUDIO。若已知 false 且沒有我們的 mute 紀錄，直接消耗 grant，不多送取消靜音。fresh read unavailable 且沒有自身 mute 紀錄時取消這次 grant，不猜測發 unmute，按既有 read error／冷卻／降級規則處理；不得留下永久 pending grant。尚未 ready 的 grant 只暫存到同 binding 的 READY、有界 120 秒，不能靠普通 poll 無限重建 grant。
3. controller 套用 effect 前再次確認 enabled、Mute Others、active、identity/generation、epoch 與 grant 未消耗；將 grant 標已消耗後呼叫 PlayerPort.restoreSelectedAudio 一次。即使 API throw/reject/timeout 也不重複 unmute；已排到但尚未發出的舊 grant，遇停用、全部靜音、換格、preset 或新選擇必須取消。已送出的 SDK 命令無法撤銷，後續仍按目前 desired 靜音收斂。
4. 以實際 fresh read 驗證結果，1500ms settle 期間不把 stale true 立即轉成 silence；settle 後仍 true，採保守 silence／一次 restore-failed 診斷，不自動 play、不持續嘗試取消靜音。已 consumed 的 active 後來因廣告／使用者再靜音，沿 Fi 題 5 處理，不重新授權恢復。

這條一次性例外只補「選格」的播放器狀態，不是維持 audible 的無限 unmute 鎖；也不靠 true→false 快速兩次 store commit（Vue batch 可能合併成同一個 false，仍不觸發 watcher）。初始 snapshot 接受唯一 false 時，若為本 controller 先前保留的選擇就遵循現有 grant；單純重新啟用讀到歷史 false 不視為新明確選擇，不因它無限恢復聲音。

| 輸入情況 | 轉移與動作 |
| --- | --- |
| options 未讀完、extension 關、Mute Others 關、非 multiview | disabled/discovering；不變更 store/player。Mute Others 關時走完整原生方法，不殘留「Twitch 預設靜音」。 |
| 啟用／重新開 Mute Others，store 穩定後只有一個 video `muted === false`（可另有 U） | 採該 identity 為 active、selection=selected → locked；其他 U ready 後正規化 true，不為初始化自行取消 player 靜音。 |
| 非空 layout 全部 true／使用者要求全靜音 | waiting-for-choice、active=null、selection=silence；維持全部靜音，不放行 bootstrap 首播。 |
| URL 四格全 U／多格初始 false | selection=bootstrap；允許第一個原生 first play 一次，或 1000ms fallback 選已在播的合格格子；以原 muteOthers 收斂為一格 false、其他 true。 |
| 使用者在 Holodex 面板明確對 B `setMuted(false)` | 立即 active=B、selection=selected、epoch++、消耗 token；同步範圍內呼叫原 `setMuted(false)`，確保其 `muteOthers(B)` 恰一次，其他 cell 立即視為應靜音。不用等 debounced Vuex mutation 才更新意圖。 |
| B 的實際值 false，但 store／active 要 B 靜音；有 B 尚未消耗的有效 iframe token | 接受一次同上；焦點本身不切 active，還必須觀察到從 muted → unmuted 的變化。 |
| B 回報 false，沒有有效 token | **只有 desiredMute(...) === 'muted' 才發 MUTE_PLAYER**；bootstrap 的 U／false 為 unassigned，不呼叫 setMuted(false)、不壓靜音，也不自行切 active。 |
| active 回報 true | 若沒有待完成的更新或過期 read，原 `setMuted(true)` 同步 store，清 active、selection=silence → waiting-for-choice。不自動取消靜音；廣告／播放政策造成暫時靜音也採保守的全靜音行為。 |
| 明確靜音 active／全部靜音 | 原生 setMuted(true)，active=null、selection=silence、epoch++、清 token；其他 player 自行取消靜音全部壓回。 |
| 已 selected 或 silence，其他格 first play／READY／ONLINE／刷新 | 不授權切換，兩個 provider 相同；READY 只重試 pending 正規化。這有別於原生「新播放格取得聲音」，須由 Fi 題 1 確認。 |
| locked 後新增 U 格 | 保持 active 與 selection，stage 新 binding、等待 READY、正規化 true；不因預期中的 U snapshot degraded。 |
| 整批換 preset | 依上述保留 active／重新 bootstrap／保留 silence 三分支；不是未知 snapshot 衝突。 |
| 單格刪除 active、改其影片或 provider | active=null、selection=silence，清 token；不自選下一格。重建相同內容的 player 可在確認原 active content 未變後承接選擇，但必須換 generation、重建 port，舊結果無效。 |
| 關閉設定／Mute Others／離開 multiview | epoch++，清 token、所有 timer 與 in-flight 的作用資格，還原 wrappers；不額外更改音量、播放或 store 靜音狀態。 |
| 契約失配 | degraded；撤銷整組保護、warn 一次，原頁面繼續操作；不把原始搶聲 bug 說成已受到保護。 |

**意圖證據與有效期限：**

1. Holodex 媒體控制面板是可靠路徑。以 media-controls 的 `.media-controls-list` 加上 Vue 結構（同 store、`allCellAction`／`setAllVolume` methods）辨識面板；不能依翻譯文案、icon path 或 row index 對應 cell。在 **window capture** 收到面板內 `isTrusted === true` 的 click 時開啟 `{ event, scopeId }` 資格；在 **window bubble** 以同一 Event 身分關閉，另排 `setTimeout(clearIfSameScope, 0)` 防 stopPropagation 留存。wrapper 查詢資格還須確認該 Event 的 `eventPhase !== Event.NONE`；dispatch 已結束時立即作廢。新合成 click 不得沿用外層 trusted 資格。鍵盤 Enter／Space 走瀏覽器產生的 trusted click，不另外用 keydown 延長資格。

   **禁止在 capture 用 microtask／Promise.then 清除。** 真實使用者事件的 listener 之間可能有 microtask checkpoint，會早於目標按鈕 handler，依 [HTML clean up after running script](https://html.spec.whatwg.org/multipage/webappapis.html#clean-up-after-running-script)；[DOM dispatch](https://dom.spec.whatwg.org/#concept-event-dispatch) 在派送結束後把 eventPhase 設回 NONE。對應函式為 `beginPanelDispatch(event: Event, trusted: boolean): void`、`endPanelDispatch(event: Event): void`、`hasPanelDispatch(): boolean`；production trusted 只取 event.isTrusted，測試注入 trusted boolean。不依賴「我們是最後註冊的 window listener」，只需要目標/祖先上的同步 Holodex handler 已執行。cell wrapper 實際收到哪一個 `setMuted(value)` 才是命令對象；僅點面板、調音量、play 不選 active。
2. 「全部取消靜音」沿用 Holodex 在 Mute Others 開啟時的單格結果：同一 trusted dispatch 依 cell 呼叫順序，最後一個有效 `setMuted(false)` 為 active，與 trailing debounce 的最後一筆一致。Mute Others 關閉時完全原生多格有聲；文件與測試須明確覆蓋。
3. 同頁 cell 上 trusted pointerdown 只建立候選，期限 **2500ms**、最多消耗一次；不直接選 active，不因拖曳／調尺寸授權。限 `.mv-frame` 播放區且排除可拖曳標頭、resize handle、連結與編輯按鈕。父頁收不到 iframe 內 pointerdown，不能宣稱這條路徑涵蓋 iframe 內每次點擊。
4. window `blur` 或父頁 `focusin` 後在 `setTimeout(..., 0)` 讀本頁 `document.activeElement`；若是已配對、連接中的 player iframe、文件 visible，且相對上一個 iframe 是新焦點進入，產生同樣 2500ms 一次性 token。blur 到網址列／DevTools、隱藏 tab 或非 player iframe 不授權；focus 回父頁、切往別格、visibility hidden、cell 重建即清 token。
5. hover、mousemove、持續 `activeElement === iframe` 及程式合成 event 不延長 token。不要每次 poll 把「仍有 focus」重設為新意圖；不信任頁面 postMessage 聲稱使用者剛取消靜音。

**不可觀察的限制：** 父頁不能讀跨網域 iframe 內的 mute 按鈕，也無法精準分辨剛取得焦點時的廣告自動 unmute。2500ms 是設計上限，不是「保證真實點擊」；需要與 muted→unmuted 邊緣、一次消耗共同判斷。已長時間停在同一 iframe 後取消靜音可能被壓回；可先把焦點移出再進入，或使用 Holodex 面板。若 Fi 需要無歧義操作，後續可加 extension 提供的「聽這格」按鈕；本版不新增 overlay 或 Twitch host 權限。

**攔截點：**

- `manualCheckMuted()`：enabled 時改用一次 PlayerPort read → reducer → effects，不呼叫原本不帶來源的 polling；disabled 時還原原方法。每 cell 一個 in-flight，重入立即返回已處理的 Promise，不堆積讀取。
- `setMuted(value)`：攔住 `manualRefresh()`／`updateListeners()` 發來的 `@mute`，以及面板命令。trusted 面板事件可直接轉 `EXPLICIT_SET_MUTED`；其餘值只當 observation，沒有有效 token 的 false 不可當命令。效果呼叫原方法時用同步、可重入的內部授權深度，避免 wrapper 自我遞迴。
- `updatePausedState(paused=false)`：新增可撤銷薄 wrapper，在原方法執行期間標記 first-play context，條件為進入時 `firstPlay === true && !paused && editMode !== paused`；用 try/finally 清除，再完全委派原方法處理 editMode／firstPlay。不自己改寫 firstPlay。這讓下項能辨識真正的原生首次播放，而非任意 mapped 呼叫。
- `muteOthers(id)`：包 cell 的 mapped method；允許已授權 `setMuted(false)`、bootstrap 的首筆 NATIVE_FIRST_PLAY／fallback。bootstrap 首筆必須先保留 active 再呼叫原方法；已有 selected／silence 時擋掉非命令首播。id 必須等於該 cell 的 key。不對所有 provider 無條件攔截初始化，也不冒稱保留原生所有首播切聲行為。
- `setMuted(false)` 原方法會以 `val === !!this.muted` 提前返回（`VideoCell.vue:174`）：當目前 U／false 時不會呼叫 muteOthers。`CALL_ORIGINAL_SET_MUTED(false)` 的 effect executor 在同步授權 scope 記錄 mapped method 是否真的被呼叫；原方法返回後，若尚未呼叫而 reducer 要選這格，就補一次原 mapped muteOthers。每次有效選擇最多呼叫一次；bootstrap 的 `CALL_ORIGINAL_MUTE_OTHERS` 直接走原 mapped method，不用 setMuted(false) 假裝一定會寫 state。
- 不 patch 全域 `store.commit()`、Vuex mutation、player 全域 setMuted；不向 store 新增自己的欄位。若站方未來繞過這些 cell 方法直接切音訊，契約 fixture／人工測試應揭露差異，另行更新 adapter。

**狀態同步與競態：**

- 使用 `store.watch()` 觀察純 primitive 簽章（muteOthers、各 video 的 id/provider/三態 muted），不做 deep watch player；以 `subscribe()` 記錄 `setLayoutContentById`、`setLayoutContent`、`setLayout`、`removeLayoutItem` 等來源提示重掃。後續 macrotask 再將整批 layout/content 變化分類為新增、單格替換、preset、重排；不以 subscribe 的即時 state 決定 active，因 debounce 尚未執行。
- 明確使用者選擇後 controller 的 active 在 store 收斂前優先，直到下一個 tick／snapshot 完成；最後一筆命令獲勝。500ms 內若 store 仍未收斂成所選 B 唯一有聲，進 degraded 並報 `store-did-not-settle`，不無限與站方互改。
- 每次 read 開始保存 identity、epoch、read sequence；結果返回前核對。A→B→A、換片／刪格、停用、延遲 false／true 結果都不得覆蓋新決定。先處理已知的 bootstrap、pending U、preset、重排及 controller 自己的 mutation；這些都不是矛盾。只有既有且身分未變的已指派格，遭未知來源切成另一個 active，才報 `store-state-conflict` 降級，不自行承認為使用者選擇。
- `SET_STORE_MUTED(true)` 只處理 selected 的其他格／silence 的所有待正規化格；在 READY 與最新 identity 確認後，進入帶 epoch 的 internal-write scope，commit `multiview/setLayoutContentWithKey({ id: key, key: 'muted', value: true })`。這是站方已用的單格 mutation（store `:168`），不呼叫 setMuted(false) 或 muteOthers；相鄰 watch 可辨認為自己的預期寫入。pending-port 期間 snapshot 可保持 U，不啟動 500ms 收斂倒數；READY 後正規化 deadline 才開始，逾時仍未成功才降級。
- 新選 B 後舊 active A 的延遲 mute=true 不得清掉 B；active read 若正處於自身狀態切換的 1500ms settle 期，不把短暫 stale true 當成全部靜音。settle 到期後真實 true 才同步為全靜音；不得無限延長。
- grant 尚在等待 store／ready／fresh read／一次性恢復時，不把 active 的 true 當成普通「active 再次被靜音」；整個選聲交易有界，完成或失敗才回到一般 observation 規則。RESTORE_SELECTED_AUDIO 與 MUTE_PLAYER 的 late result 都要核對 epoch，不能在選擇已改變後再發舊取消靜音命令。
- MUTE_PLAYER 只對 desired-muted 且已知 false 的格執行；每格最多每 1000ms 一次，同時最多一個寫入；命令後 1500ms 為 settle 期，這期間快取 false 不算新意圖、不重打寫入。settle 後仍 false 可重試，連續 3 次無法收斂即 `player-mute-did-not-settle` 降級。SDK 異步快取不應造成暴量 API 呼叫或 console 輸出。
- 保留 Holodex 1000ms polling 作為主要時鐘，不再增加第二個音訊 interval。新 cell、READY／ONLINE 可排一次合併 reconcile；所有 reconcile 套用相同 read/write 限制。

### 4. Options 與跨 context 設定傳遞

在 `src/utils/options.ts` schema 新增 `twitchAudioLock: true`；descriptions 加：

- name：`Keep selected audio in multiview`
- description：`Prevent players from taking over audio when Holodex Mute Others is on. Use Holodex media controls to choose audio reliably. Changes apply to open Holodex tabs.`

沿用 `storage.local`，不另建 options storage、不用網站 localStorage 作正式設定。既有 `src/pages/options/index.ts` 會自動生成 checkbox，毋須改 React 或重寫表單。增加測試確認呈現、預設 true 及 set(false) 後重新打開仍 false；一般畫面優化不屬於本任務。

生效條件嚴格為：`extensionSetting === true && store.multiview.muteOthers === true && compatibleMultiview`。不代替使用者開啟 Mute Others，不寫 `setMuteOthers`。切到 true 後以 Holodex 當時 store snapshot 建立狀態；切到 false 立即卸載 cell wrappers／ports，不把原型「永遠 muted=true」留在關閉情境。第 2 版沒有 Twitch constructor 攔截。

page script 沒有 extension storage 權限，**不可**在 `holodex-inject.ts` 或 audio-lock 子模組 import `@utils` barrel／`webextension-polyfill`；該 barrel 會引入 runtime/storage。content script 負責讀 Options，page script 只接布林值。協定與 `parseAudioLockMessage` 放入純 `audio-lock/contracts.ts`，與既有本功能窄型別合併，不另開 protocol 模組，也不把 parser 放進會 import storage 的 settings.ts。協定如下：

```ts
type AudioLockMessage =
  | { channel: 'holodex-plus/audio-lock'; version: 1; type: 'ready' }
  | { channel: 'holodex-plus/audio-lock'; version: 1; type: 'config';
      enabled: boolean };
```

`startAudioLockSettingsBridge(win: Window): () => void` 放在 `audio-lock-settings.ts`，只由 isolated content script 使用。先註冊 message 與 `storage.onChanged`，再開始 `Options.get('twitchAudioLock')`，**然後才**呼叫既有 `inject(injectPath)`；不得延遲其他既有 Holodex flag 的注入。page script 先註冊 config listener 再發 ready **一次**；收到 ready 時 bridge 回傳最近值，storage 尚未讀完則等結果。這個安裝順序確保 ready 不會遺失，不做 ready 重試或訊息 revision；config 發送由同一 isolated context 依序進行。BFCache pageshow 可重新送一次 ready 並刷新 storage。

使用 `window.postMessage(message, location.origin)`；雙邊驗證 `event.source === window`、`event.origin === location.origin`、channel/version/type、boolean enabled。每次單一 in-flight storage read 用一個 `changedDuringRead` boolean：該 key 的 onChanged 到達就設 true、保存並傳送新值，get 之後的舊結果或 rejection 便忽略，並取消該次初始等待 timer；不需要跨 context 序號。onChanged 或 timeout 邏輯完成本次讀取後，即釋放 in-flight 資格，讓 pageshow 可重新讀取；舊 Promise 仍接住 rejection，但閉包標記使其結果無效。local key 刪除回預設 true，錯型資料／storage 拒絕則採 disabled 並 warn 一次。只在 `areaName === 'local'` 且該 key 有變化時傳送。初始 storage read 的 5000ms timeout 保留作有界失敗處理，逾時 disabled/warn 並忽略該次晚到 get，後續 storage change 或 pageshow 新讀取仍可恢復。

訊息僅包含這一個布林設定；DOM／postMessage 不是對抗同頁惡意腳本的認證邊界，來源驗證只能過濾其他 frame/origin。page→content 的唯一允許訊息是 ready，不提供任何 storage set、任意 key read、任意函式或 extension API 的代理。不能讓 forged config 寫回 extension storage。

extension 設定更新應在同頁約 1 秒內套用（前景、已收到 storage event 時），不用 reload；停用後任何 pending read 或補靜音都無作用。保留最小設定 bridge 以便再次啟用。原 `localStorage.hdxPlusAudioLock` 的讀取與註解移除；舊 `off` 不自動移入跨頁共用設定、不刪網站值，升級使用者改從 options 關閉。是否改做一次遷移列在 Fi 決策。

### 5. Manifest 與瀏覽器

不新增 permissions 或 host_permissions：沿用 `storage`、既有 `*://*.holodex.net/*` 與注入機制。不新增 `scripting`、`activeTab`、Twitch 網域、不把主邏輯送進 Twitch iframe，不使用 Firefox `wrappedJSObject`／`exportFunction`。在 page context 取得 Vue，保留 `?script&module` 由 CRXJS 產生的資源；實作後核對產生的 web_accessible_resources 含 page script 與其 chunk，且 match 範圍沒有擴大。

權威 manifest 是 `manifest.json.ts`；本功能預期不需修改它，也不手改 `dist_*/manifest.json`。Chrome 維持 MV3 service worker；Firefox 沿用現有 `vite.config.firefox.ts` 的 background scripts 處理，不為了 Chrome skill 的通用範例重寫它。options 保持 `src/pages/options/index.html`。兩個 build 成功仍不等於 Firefox/Vivaldi 真實頁面測試通過。

## 檔案

以下為下一輪實作的預定檔案；只修改列出的產品相關範圍，避免廣泛整理既有程式。

| 動作／檔案 | 責任與主要函式 |
| --- | --- |
| 重寫 `src/pages/content/holodex/twitch-audio-lock.ts` | 輕量入口，`installAudioLock(): AudioLockHandle`；page config listener、單例 handle；移除原型全域 mixin、hover、localStorage 與逐次 log。 |
| 新增 `src/pages/content/holodex/audio-lock/contracts.ts` | `MutedAssignment`、`CellIdentity`、`SelectionGrant`、`PlayerPort`、state/event/effect、binding 型別，以及純 message 型別／常數／`parseAudioLockMessage(value: unknown): AudioLockMessage \| null`；無 DOM side effect、無 extension API import。 |
| 新增 `src/pages/content/holodex/audio-lock/state.ts` | `createInitialState(): LockState`、`desiredMute(...)`、`transition(...)`；純決策、全部時限常數、一次性 grant 與 identity/epoch 驗證。 |
| 新增 `src/pages/content/holodex/audio-lock/holodex-adapter.ts` | `createHolodexAdapter(...)`；`discover()`、`patchCell(binding, handlers): () => void`、`watchSnapshot(cb): () => void`、`dispose()`；Vue/DOM/store 契約與可撤銷 wrappers。 |
| 新增 `src/pages/content/holodex/audio-lock/players.ts` | `createPlayerPort(binding): PlayerPort \| null`；late-bind、ready、750ms 邊界、grant 一次性恢復方法與 cell WeakMap 清理，完全不動 Twitch global。 |
| 新增 `src/pages/content/holodex/audio-lock/controller.ts` | `createAudioLockController(deps): AudioLockHandle`、`reconcileCell(identity): Promise<void>`、選聲 grant executor、effects／cleanup／一次警告；同檔內 `trackIntent` 及 `beginPanelDispatch`／`endPanelDispatch`／`hasPanelDispatch` 負責意圖與 Event gate。透過 deps 注入 clock/timers；不另建 intent.ts。 |
| 新增 `src/pages/content/holodex/audio-lock-settings.ts` | isolated bridge：`startAudioLockSettingsBridge(win): () => void`，Options get/storage change、一次 ready handshake、讀取期間變更保護。 |
| 修改 `src/pages/content/holodex/contentScript.ts` | 在 top frame 注入前啟動 bridge，保留既有 `inject` 行為與 flag 注入；對 rejected inject 作有界錯誤處理。 |
| 修改 `src/pages/content/holodex/holodex-inject.ts` | 保留既有 flags 與 `installAudioLock()` 入口，不引入 extension API。 |
| 修改 `src/utils/options.ts` | 新 schema key 與文案；不為這個功能改掉其他選項的 storage 行為。 |
| 新增 `tests/audio-lock/state.test.ts` | 純狀態機與時序表。 |
| 新增 `tests/audio-lock/adapter.test.ts` | jsdom／最小假 Vue/store fixture、undefined 合法、契約失配、wrapper restore、firstPlay／@mute／deferred store；第一 PR 不加 Vue runtime。 |
| 新增 `tests/audio-lock/players.test.ts` | SDK fake、throwing getter、Promise timeout、late-bind；assert Twitch global/constructor 完全未改。 |
| 新增 `tests/audio-lock/controller.test.ts` | 整合 fake store/player/clock；poll、非同步世代、清理、intent。 |
| 新增 `tests/audio-lock/settings.test.ts` | mock webextension-polyfill、bridge race/message validation、既有 options 表單。 |
| 新增 `tests/audio-lock/fixtures.ts` | 最小 store/cell/player 工廠，模擬 trailing debounce、READY/manualRefresh、Boolean prop default 與僅 prop 有差異才觸發 watcher；不讀／複製 .ref 原始碼。 |
| 新增 `vitest.audio-lock.config.ts`、`tsconfig.audio-lock.tests.json`、修改 `package.json` | audio-lock 專用測試 aliases／typecheck/test scripts；只加 Vitest/jsdom 兩個測試 devDependency，不加 lint 依賴／script，不載入 CRXJS plugins。 |
| 實作回合更新 `yarn.lock`；`.gitignore` 不改 | 現有 `.cache` 原名規則（`:136`）已涵蓋 `.cache/vitest` 等工具輸出；不產生 `.vitest`，無須再加規則。本規劃回合不改 lockfile。 |

`src/pages/options/index.ts` 原則上只由測試覆蓋，不必為一個新選項改 UI；若目前表單的錯誤處理妨礙此功能，限制修正範圍並在實作記錄解釋。`src/global.d.ts` 不必加大量 any global，將 page handle 型別留在入口的局部 Window 型別。

## 步驟

### 任務 0：鎖定第一個 PR 與 commit 邊界

- [ ] 實作前閱讀「第一個 PR 的範圍」「上游程式風格」「上游 PR 打包」及 Fi 題 8；沒有另選時照最小 Vitest 方案。核對工作分支仍是 gixiphy/twitch-audio-lock、upstream/dev 本機基準為完整 709e963 hash；此任務不建立／切換分支。
- [ ] 從 upstream/dev 的 options／contentScript／flags 邊界比對，不把另一個 auto-multiview-layout 分支的 helpers、commits 或 scripts 搬進來。所有新增檔案限定 audio-lock 命名空間；不要改 @utils barrel。
- [ ] `twitch-audio-lock.ts` 依本計畫**重寫取代** eda5b52 的原型，不疊上其全域 mixin／constructor trap／localStorage patch。保留的入口檔名與 install 呼叫不是保留原型架構；正式 PR 不帶 eda5b52 作祖先 commit。
- [ ] 後續每個產品 commit 只 stage 本功能產品／測試／必要工具配套白名單，文件修改另作 docs commit；保留純產品 SHA 供追溯或在前提一致時 cherry-pick。禁止 git add -A 或把整個工作分支 rebase/merge 到 PR；推薦打包只取已驗證產品 tree 的白名單最終內容，不重播原型來補 delta 前提。

### 波次一：狀態規格與測試基礎（任務 1）

**交付：** 能獨立執行且無 DOM／SDK 的狀態機；尚不接到頁面。

- [ ] 確認基準 diff、Node、Yarn 與輸出位置；不覆蓋原有未提交檔案。後續安裝／build 只用本 worktree 的 cache，不將新檔指向 `.ref`。
- [ ] 先核對 Fi 題 8：本文方案 A 保留 audio lock 的 Vitest＋jsdom，接受與另一 PR node:test 不同；如 Fi 選統一先修訂相應計畫。A 只在 package.json 加 `vitest: "3.2.6"`、`jsdom: "26.1.0"`，不加 Vue／lint 套件。scripts：test:audio-lock = `vitest run --config vitest.audio-lock.config.ts`，test:audio-lock:watch = `vitest --config vitest.audio-lock.config.ts`，typecheck:audio-lock = `tsc --noEmit && tsc --noEmit -p tsconfig.audio-lock.tests.json`。
- [ ] 依打包段只在 .cache/audio-lock-lint 建立臨時 lint 安裝／config／run.cjs；不要在產品 package.json 新增 lint script，也不回填上游 a5ff269 移除的依賴。scope 零警告、既有整合檔比 baseline 的門檻照舊。
- [ ] 新增 `tsconfig.audio-lock.tests.json`，`extends: './tsconfig.json'`、`include: ['tests/audio-lock/**/*.ts', 'vitest.audio-lock.config.ts']`，覆寫 `compilerOptions.moduleResolution: 'bundler'`，保留 esnext module、noEmit、strict、paths 與 types。tests 都顯式 import Vitest API，不靠全域型別。這個 config 加上原 tsc 指令涵蓋本功能產品／tests／fixture／config，不引用另一 PR 的測試 setup，也不修改原產品 tsconfig。
- [ ] `vitest.audio-lock.config.ts` 用 `defineConfig` from `vitest/config`，`test.include: ['tests/audio-lock/**/*.test.ts']`、`environment: 'jsdom'`、`environmentOptions.jsdom.url: 'https://holodex.net/multiview'`、`css: false`、`testTimeout: 5000`、`hookTimeout: 5000`、`teardownTimeout: 5000`、`restoreMocks: true`；cacheDir 指 worktree `.cache/vitest`。不載入 CRXJS config。
- [ ] 同一個 Vitest config 必須加 `resolve.alias`，用 `fileURLToPath(new URL(relativePath, import.meta.url))` 建絕對路徑：`@utils` → `./src/utils/index.ts`、`@assets` → `./src/assets`、`@src` → `./src`、`@pages` → `./src/pages`、`@locales` → `./src/locales`。即使測試本身用相對 import，實際 options entry 的 `@utils` 與 `@assets/styles/tailwind.css` 仍需解析；CSS 內容在測試中略過，alias 解析不可略過。沿用既有 aliases，不新增 dependency。
- [ ] 先寫 state 測試，至少用表格 assert：disabled 無 effects；locked A 下未授權 B false 只產生 MUTE_PLAYER(B)；有 token B false 只產生一次 CALL_ORIGINAL_SET_MUTED(B,false)；token 在 2500ms 後無效；全部靜音 active=null、selection=silence；過期 epoch 不產生 effects；四格全 U 為 bootstrap、第一個 NATIVE_FIRST_PLAY 才產生一次 CALL_ORIGINAL_MUTE_OTHERS，第二個在 debounce 前即被擋。執行 `yarn test:audio-lock tests/audio-lock/state.test.ts` 確認尚未實作時 FAIL。
- [ ] 在 state.test.ts 先補 `bootstrap_poll_does_not_mute_unassigned_or_false_cells`：selection=bootstrap、active=null，U 與 false 的每次 poll(false) 均為 desired=unassigned、effects 不含 MUTE_PLAYER；另有 true 格 poll(false) 才可 MUTE_PLAYER。之後實作 contracts.ts、state.ts 的 desiredMute、grant 與轉移表，再跑同一命令 PASS；時限用常數，不散落魔術數。
- [ ] review 決策與型別是否一致，將此獨立任務留在本機功能 commit（僅在當輪已允許 Git 中繼資料寫入時）；不 push。

### 波次二：相容層與整合（任務 2、3）

#### 任務 2：可撤銷 adapter 與 PlayerPort

**輸入：** types、report callback `(code: string) => void`。**輸出：** cell bindings、snapshot subscription、PlayerPort 與 disposers。

- [ ] 先在 `adapter.test.ts` 寫 root 名稱改掉仍成功、muted 欄位省略／undefined 仍成功、null／錯型才降級、假 VideoCell 名稱但形狀錯誤不動作、無 root 在 120 秒停止、cyclic children 有界、readonly method 安裝回滾、未知 provider 整組降級等失敗測試。新 cell 的 pending-port 不卸載原 active wrappers。
- [ ] 在 players.test.ts 寫 SDK public methods 假物件；危險 _embedWindow getter 不可被讀；ready 前不讀寫、read throw/reject/750ms 不 resolve 回 unavailable。新增 restoreSelectedAudio 的正確 binding/epoch 一次呼叫、錯 generation／重複 grant／dispose 不得呼叫、restore reject/timeout 無 unhandled rejection，Twitch 與 YouTube 各測。保存 globals/constructor 的 identity/descriptor，安裝到 dispose 全程不改 SDK。
- [ ] 執行 `yarn test:audio-lock tests/audio-lock/adapter.test.ts tests/audio-lock/players.test.ts` 確認 FAIL，再實作兩個模組。所有存取限白名單欄位，不用全域 mixin 或 generic 深搜。
- [ ] 以本 feature 內的假 Vue instance／store 建 fixture：元件 name 隨機、$children/$refs/ready hooks 及原 mapped method 呼叫存在，初始 content 不宣告 muted；模擬 setLayoutContentWithKey 新增 key 後通知 watch，驗證三態 snapshot 會更新。player 帶危險 getter，assert late-bind/read 未觸碰它、不把 ports 塞入假 reactive state。這是契約測試，不能宣稱驗證真 Vue observer；真 Vue 相容性依人工頁面測試，Vue runtime fixture 延後。
- [ ] 重跑兩組測試及 state 測試預期全 PASS；fake timers 有界 advance，不可對持續 scheduler 用無限制 `runAllTimers()`。還原後 cell 方法 strictEqual 原值，SDK globals 始終 strictEqual 原值。

#### 任務 3：意圖、controller、初始化與四條攔截路徑

**輸入：** 任務 2 的 bindings／ports，任務 1 reducer。**輸出：** 冪等的 AudioLockHandle。

- [ ] 先在 `controller.test.ts` 重現 A=YouTube 已有聲、B=Twitch store muted 卻回 false；fake MediaControls 每秒 poll，assert A 的 mute／store 沒被 B 改、B 只有有限 mute 呼叫。
- [ ] 同時覆蓋 `manualRefresh → updateListeners → @mute(false)`，以及已 selected A 下 B 首次播放 `updatePausedState(false) → muteOthers(B)`：兩者都不能切 active。Twitch／YouTube 各跑一次；bootstrap 例外另測，不能寫成任何時候 first play 一律被擋。測試 original editMode／firstPlay 仍照原生方法更新。
- [ ] 加三個完整初始化測試：① URL 載入四格完全省略 muted，首播一次後 trailing timer 令一格 false／三格 true；若 missed first play，1000ms fallback 只選 ready 且正在播的候選；② locked A 後新增 U 格，尚未 ready 不碰 SDK 或 mute prop、ready 後該格 true，A 不變且不降級；③ 換 preset 同時改 layout/content，舊 Promise 無效，新內容依 preset 規則 bootstrap，merge 保留 A，先前 silence 則全部繼續靜音。fixture 要有真正省略欄位，不只 `{ muted: false }`。
- [ ] 新增 `bootstrap_poll_does_not_mute_unassigned_or_false_cells` controller 測試：四 U 格尚未首播且 editMode=true（不符合 fallback），多次 1000ms poll 後 raw mute 呼叫數皆 0、store 仍 U、selection 仍 bootstrap；bootstrap 裡原本 true 的格若 raw=false 才可被壓回。
- [ ] fixture 明確定義 `effectiveMuteProp = assignment === undefined ? false : assignment`，只有前後 prop 不同才呼叫假的站方 watcher。以首播、1000ms fallback、可信面板 false 命令三條路徑，分別測 `unassigned_selection_restores_actual_player_audio`：被選格 store 起始 U、effective prop=false、raw player 起始 muted=true（含先前被 guard 壓過）；muteOthers 後 U→false，**被選格 watcher 呼叫數必須為 0**，再由合法 grant 恢復至 rawMuted=false、active 維持所選格、其他格 true。不能讓 fake store 每次 commit 都無條件呼叫 watcher，把問題藏掉。
- [ ] 同組測試：raw 已 false 且未被我們 mute 時不呼叫 restore；停用／全部靜音／選 B 發生於 pending grant fresh read 返回前，舊 A 不得收到 restore；同 epoch 重複 reconcile 最多一次 restore。SDK 拒絕恢復後 settle 到期進 silence，不連續 unmute，也不自動 play。
- [ ] 加面板 dispatch 測試：`beginPanelDispatch(event,true)` → **手動 await/flush microtasks** → 目標 `setMuted(false)` 成功 → `endPanelDispatch(sameEvent)` → 再次命令不獲授權。另測錯 Event 不能關掉別筆、stopPropagation 未走 window bubble 但 eventPhase=NONE 時資格失效、0ms timer 會清理、untrusted nested click 不繼承資格、鍵盤 trusted click 首次生效。不要只靠 `dispatchEvent` 模擬瀏覽器 listener 間的 checkpoint。
- [ ] 加 iframe token 測試，再執行上述 tests 確認 FAIL；實作 `controller.ts` 及 `updatePausedState` 的 first-play context，重寫入口。jsdom 不能建立真的 trusted event，gate 測試以注入 trusted boolean 與可控制 eventPhase 的 Event fixture 進行；production 只讀 event.isTrusted，真實硬體 click 仍須人工驗證，不把 fixture 偽稱為可信瀏覽器事件。
- [ ] 明確測試原 `setMuted(false)` 在 muted=undefined／false 時提前返回，effect executor 仍補原 mapped muteOthers **恰一次**；在 muted=true 時原方法已呼叫，不能補第二次。Bootstrap 所呼叫的 mapped method 也只能一次。all-mute 後新增 U／first play 不能重新啟動 bootstrap。
- [ ] 明確測試 store trailing timer 尚未執行時 B 已是 active、A→B→A 最後命令獲勝、舊 read 晚回不改 active、500ms 未收斂降級、iframe hover 30 秒仍無授權、焦點 token 不重複使用、現成 iframe focus 不每秒續期。
- [ ] 測試開關關閉、換路由、BFCache、重排、同 key 換片、player 重建、root 替換；assert dispose 後已配對 ports/listener/observer/timer 回到初始數量，pending Promise 返回不再寫 player/store。
- [ ] `yarn test:audio-lock` 預期全部 PASS；以 fake count 驗證每格一個 in-flight、每 1000ms 寫入上限、1500ms settle 與 3 次失敗降級，debug 預設不印每次修正。

### 波次三：設定、雙瀏覽器建置與實測（任務 4、5）

#### 任務 4：Options 與 bridge

**輸入：** `AudioLockHandle.setEnabled`。**輸出：** 持久 options 與同頁熱切換。

- [ ] `settings.test.ts` 先 mock `webextension-polyfill` 的 storage.local／onChanged 與 runtime.getURL，不 mock 整個 `@utils`。以 `vi.resetModules()` 後動態 import 真正 `src/pages/options/index.ts`；觸發 DOMContentLoaded，等待 schema 表單生成，assert 所有原有選項與新 checkbox 都存在且可 set(false)。這個 smoke test 需實際解析 `@utils`／`@assets/styles/tailwind.css`，避免只測假表單漏掉 alias 錯誤；清理本測試登記的 DOMContentLoaded listener。
- [ ] 同檔測試預設 true、false 保存、reload、刪 key 回預設、錯型 disabled；協定測 ready 早於／晚於 storage read、page listener 早於單次 ready、storage change 早於 get resolve/reject、storage rejection、5000ms 讀取逾時、BFCache pageshow 新讀取。foreign source/origin、錯型 enabled、未知 channel/type、合成 storage-write 訊息均被忽略；不寫不存在的 revision／重試測試。
- [ ] 執行 `yarn test:audio-lock tests/audio-lock/settings.test.ts` 確認 FAIL，再改 schema、新增 protocol/settings bridge，接 `contentScript.ts`、page 入口。其他既有 flags 不受設定等待影響。
- [ ] 保護開啟／關閉連續 10 次，確認無重複 listener／wrapper／port；Mute Others 關閉期間即使 extension 開啟也完全原生；跑全測試 PASS。

#### 任務 5：建置與人工驗證

- [ ] 依下一節指令跑 scoped lint、既有整合檔 baseline lint、typecheck、全部 audio-lock tests、Chrome／Firefox build。任何 pre-existing 失敗須記錄命令、錯誤與 baseline；不能以「Vite 成功」替代 TypeScript 或真實播放器驗證。
- [ ] 檢查輸出 manifest、options entry、page script/chunks、web_accessible_resources、沒有新增權限；檢查 page bundle 沒有 storage/polyfill 呼叫，兩瀏覽器輸出內無測試 fixture、`.ref` 或 Vue 測試 runtime。
- [ ] 由 Fi 或有瀏覽器測試授權的人執行下節人工清單；填日期／瀏覽器與版本／結果／console reason／觀察時間。記錄實際廣告與重連測試；未遇到廣告寫未覆蓋，不填 PASS。
- [ ] 全部必要驗收通過才稱正式版完成；只有模擬測試及 build 時稱「可交付實測」，不可宣稱已驗證真實 Twitch。本機小 commit 依序保留，不 push、不 PR、不 merge、不公證。

## 測試

### 自動測試矩陣與逾時

| 測試檔 | 必須覆蓋與斷言 |
| --- | --- |
| state | muted 三態、desired 三態；bootstrap U／false 不 MUTE_PLAYER、原 true 才壓回；四 U 首播只選一次；單 false 加 U 正規化；bootstrap/silence 分離；selection grant 僅建立一次且在新選擇／全靜音時失效；extension × Mute Others；token／epoch 過期無 effects。 |
| adapter | 非 top frame、非 multiview 不 patch；component 改名但相同形狀仍可用；U 合法、null 失配；結構錯／無 root／無 store 不動作；warn 同 code 一次；有界遍歷；pending-port 不拆原保護；不可寫方法兩階段回滾；他人後裝 patch 不覆蓋。 |
| players | late-bind；getMuted 非 boolean 不變 false；throw/reject/hang/stale；危險 getter 不讀；globals/constructor/descriptor 全程未改；ready 前不讀寫；restoreSelectedAudio 僅合法 grant 一次，失敗／timeout 全接住，不呼叫 play。 |
| controller | 四 U 首播前 poll 不 mute；首播／fallback／明確選 U 三路徑皆保證有效 prop false→false、被選 watcher=0 時仍以 grant 恢復 rawMuted=false；重複 poll 不再 unmute；新選擇／全靜音取消舊 grant；既有 first-play/manualRefresh、preset、capture→flush microtasks→target→window bubble、debounce/stale/settle/清理回歸全部保留。 |
| settings | 真實 options entry 經 aliases 及 CSS import 可載入、原有及新選項都呈現；沿用 Options local schema；預設／持久／熱更新；單次 ready 與讀取期間 change/reject race；5000ms timeout；設定停用時 pending read 零副作用；page 訊息不能修改 storage。 |

所有單元測試與 hook 各 5000ms，teardown 5000ms；timer 情境用 fake clock 推進，read timeout 750ms，root discovery 120 秒用 fake time，不實際等 2 分鐘。每個 test finally/afterEach dispose、清 timers、回 real timers、清 DOM。測試、typecheck 與 lint process 各有 **120 秒 wall-clock 上限**，避免卡住 runner／fake clock；build 各 **180 秒**，install **300 秒**。逾時要非零 exit，不能把 SIGTERM 當通過。

整合 fixture 必須模擬真正的 trailing 0ms muteOthers；若 fake store 同步改 state，會漏掉這次研究發現的競態。第一 PR 的假 Vue 契約 fixture 不等於真 Vue observer，也不能模擬 Twitch 廣告、cross-origin WindowProxy 或 isTrusted；真瀏覽器人工清單仍是必要門檻。

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

# 初次實作只為兩個測試依賴更新 yarn.lock；之後重現用 --frozen-lockfile。
# 執行下面的 lint 前，先依「PR 前」段建立 worktree .cache 的臨時工具。
yarn install --non-interactive --cache-folder "$YARN_CACHE_FOLDER"
node .cache/audio-lock-lint/run.cjs
yarn typecheck:audio-lock
yarn test:audio-lock
yarn build:chrome
yarn build:firefox
```

執行前將每個 install/lint/typecheck/test/build 命令交給執行環境的 wall-clock timeout；macOS 沒有預裝 GNU timeout 時，用 Python 標準函式庫 `subprocess.Popen(..., start_new_session=True)`、`communicate(timeout=秒數)`，逾時用 `os.killpg` 結束這次建立的 process group 並 exit 124，不留 Vite/Yarn 子行程。不為 timeout 安裝系統套件，也不以縮短 testTimeout 取代整個 process 的上限。若需要把此 wrapper 保存成檔案，限本 worktree 的 `.cache/`，不得提交。

- `node .cache/audio-lock-lint/run.cjs`：exit 0、限定功能檔案零 error／warning；另跑打包段的三個既有整合檔 lint 並比 baseline，不能把 scoped pass 說成全倉 pass。
- `yarn typecheck:audio-lock`：exit 0，依序跑 `tsc --noEmit` 與 `tsc --noEmit -p tsconfig.audio-lock.tests.json`，兩者都要過。可用 `yarn exec tsc --noEmit -p tsconfig.audio-lock.tests.json --listFilesOnly` 核對清單含 tests、fixtures 及 vitest.audio-lock.config.ts；不能把 Vitest/Vite transpile 當作完整 TS 檢查。
- `yarn test:audio-lock`：exit 0、全部預定測試 PASS、沒有 unhandled rejection、teardown 殘留或無限制重試。
- `yarn build:chrome`：exit 0；產生 `dist_chrome/manifest.json`、`dist_chrome/src/pages/options/index.html` 與帶 hash 的 assets/page 注入 script；Chrome background 為 service_worker。資源名稱以生成 manifest／HTML 引用為準，不寫死 hash。
- `yarn build:firefox`：exit 0；產生 `dist_firefox/manifest.json`、`dist_firefox/src/pages/options/index.html` 與其引用 chunks；background scripts 由現有 Firefox config／CRXJS 生成。
- 兩個輸出的 manifest 權限集合與基準相同；引用檔案全部存在。build 會清理各自 outDir，執行前確認 outDir 不是 worktree 外的 symlink，裡面沒有使用者需保留資料。
- lint 臨時工具只放 worktree .cache，不加回 a5ff269 刪掉的依賴、不改整個 repo。既有 flags 的 @ts-ignore 等診斷實跑比較 baseline，不預填次數，不為 lint 改寫無關 flags。
- 正式實作可依當輪授權提交 `package.json`／`yarn.lock` 等必要產品改動；本輪第 4 版修訂只 stage `docs/plans/twitch-audio-lock.md`。prompt 與審查報告保持原樣，不提交其他檔案或產物。

### 人工測試清單（Chrome／M1 Vivaldi／Firefox）

真實瀏覽器需以兩套 build 分別測試；Chrome 與 Vivaldi 使用 `dist_chrome`，Firefox 使用 `dist_firefox` 暫時載入。每次記錄版本、OS、擴充功能 commit；無須這一輪操作瀏覽器。

| 場景 | 操作與觀察時間 | 通過條件 |
| --- | --- | --- |
| URL 初始化（缺值） | 新 URL 開 2 YouTube + 2 Twitch、全部 content 省略 muted；觀察第一批首播與收斂後 30 秒 | 首次有效首播只選一格，其他格 true；不因 U degraded，不持續四格同時出聲。若 hook 晚到，ready 且在播的候選經 1000ms fallback 收斂。 |
| U 格原本已靜音再選聲 | 用合成 fixture 的 U 格、rawMuted=true，依序從首播／fallback／面板選聲；真瀏覽器用全靜音後新增／選格交叉檢查 | 父層 U→false 不觸發 Boolean watcher 的 fixture 仍得到 rawMuted=false；真頁面明確選格可聽見，後續手動 mute 不被自動恢復。fixture 不在真頁面注入破壞性 patch。 |
| 原始問題 | 2 YouTube + 2 Twitch，Mute Others 開；面板選 YouTube A，操作其他格／等待 5 分鐘 | Twitch 不能讓 A 的 store mute 被改成 true；沒有每秒 re-mute log。 |
| 面板真實事件第一擊 | Chrome／Vivaldi／Firefox 各自用實體滑鼠第一次點 B 的取消靜音，再以鍵盤 Tab→Enter／Space 各 3 次；不可用 console `.click()` 代替 | **第一次就成功切換**，不需第二次點擊、不因 capture/target 間 microtask 清掉資格；同一事件以外的後續自動 false 仍被壓回。 |
| 明確切音訊 | 用媒體控制逐格選 A→B→A、快速連按、靜音目前格、全部靜音／全部取消靜音；各 10 次 | 最後一次選擇生效；全部靜音不自選其他格；Mute Others 開時全部取消靜音仍只有最後一個被選格。 |
| iframe 操作 | 移入 iframe 焦點並在 2.5 秒內取消靜音；停留 30 秒、只 hover、移往 DevTools；鍵盤 Tab/Enter/Space | 短期有效意圖允許一次切換；hover／長期 focus 不續期；長期 iframe 取消靜音被擋時，面板仍可可靠切換且不報錯。 |
| 真實廣告 | A 有聲、B Twitch 靜音，等待或在可合法操作的既有播放器觸發廣告；至少觀察一個完整廣告前／中／後 | A 不被 B 奪走；記錄是否有短促漏音及持續時間，不承諾輪詢可消除瞬間漏音。20 分鐘沒遇到廣告則結束、標「未覆蓋」，不得無限等或填 PASS。 |
| 斷線／重連 | 同一選擇下，離線 10 秒再恢復；觀察恢復後 60 秒，重複 3 次 | Twitch READY／重連不搶 active；若 active 自身被系統靜音，維持保守全靜音，使用者可重新選它。網路切換僅限有操作授權者。 |
| locked 後新增缺值格 | A 已選，新增一個省略 muted 的 Twitch，再新增 YouTube；等待各自 READY | A 保持選定，新格 ready 後 true，不降級、不在 SDK 未 ready 前強改 mute prop；兩 provider 都遵循 Fi 題 1 的預設。 |
| preset 取代／合併 | 以全 U preset 換掉原內容，再測合併保留 A；另在全靜音後換 preset，各 3 次 | 換掉 A 才新 bootstrap；保留 A 的 merge 不搶聲；先前 silence 繼續全靜音；沒有 `store-state-conflict` 誤報或舊 Promise 寫新格。 |
| layout 與生命週期 | 重排、刪 active、同格 Twitch→YouTube→Twitch、刷新格、離開／回 multiview，重複 10 次 | 重排保持選擇；單格換片／刪 active 不自選他格；無舊 player 寫入、新格能掛上；無 listener/timer 累積。 |
| options × Mute Others | 四種組合各測 1 分鐘；options 在已開頁熱切 10 次；關閉 Mute Others 後允許多格有聲 | 兩者皆開才保護；關閉後不強制 muted、不阻止原生行為；reload 保留 extension 設定。 |
| 背景／全螢幕／BFCache | tab hidden 30 秒後返回、iframe fullscreen、前進／返回各 3 次 | 不因 focus/visibility 自選他格；返回重新驗證；timer 節流後的舊結果無作用。 |
| 不相容頁 | 測試 fixture 移除必要方法或 store 欄位、沒有 Vue root、元件改名 | 改名但契約相同繼續運作；契約缺失只 warn 一次且不改 store/player，其他 Holodex 功能正常。不要在正式網站手動破壞元件。 |
| SecurityError 對照 | 同一瀏覽器/profile/layout，停用及啟用各觀察 3 分鐘；保留來源 stack 並依腳本來源分類 | 無 AudioLock 自己的 uncaught／unhandled rejection；沒有我們每次 poll 多一次危險 getter 的 stack。站方錯誤波動列 warning；無可比較基準就記未判定，不能捏造降低百分比。 |

## 上游 PR 打包

### 目標、工作分支與原型的關係

| 項目 | 確定值 |
| --- | --- |
| fork／head remote | `origin` = `https://github.com/gixiphy/Holodex-Plus.git`；最終 head `gixiphy:fi/twitch-audio-lock` |
| upstream／base remote | `upstream` = `https://github.com/HolodexNet/Holodex-Plus`；PR base `HolodexNet/Holodex-Plus:dev` |
| 乾淨產品起點 | `upstream/dev` 指定基準 `709e96319bc93965509f83e5f2a897b5d2dc37c7`（本輪只讀本機 ref 確認，沒有 fetch 或更動 remote） |
| 目前工作分支 | `gixiphy/twitch-audio-lock`；含原型、docs/plans、reviews、prompts，不能直接當 PR head |
| 同名舊產品分支 | 本機 `fi/twitch-audio-lock` 目前是 `eda5b52c02744978564b927263230a3545c40d86`，不是乾淨正式版；本輪不移動它 |
| 原型處置 | 正式版重寫取代原型；保留問題案例與 install 入口，不保留 localStorage、Vue.mixin、Twitch trap、10 秒／hover 實作或原型 commit 作最終祖先 |

「產品重寫取代」與「在工作分支以 delta commit 實作」不矛盾：工作分支可以保留 eda 做歷史參考，最終 PR 則從 709e963 重新組出完整產品變更。不能直接把工作分支 merge 到 fi，也不能僅 cherry-pick 依賴原型檔案已存在的後續 commit，否則乾淨基準會缺入口或發生 modify/delete 衝突。

### 產品白名單與絕不進 PR 的資料

第一個 PR 只允許以下範圍；若 Fi 題 8 改選，先更新這份白名單和測試步驟。`tests`／設定檔只為 audio lock，不建立另一 PR 可依賴的新模組。

- `src/pages/content/holodex/twitch-audio-lock.ts`
- `src/pages/content/holodex/audio-lock/` 下五個模組：contracts、state、holodex-adapter、players、controller（包含意圖／Event gate）。
- `src/pages/content/holodex/audio-lock-settings.ts`；沒有獨立 intent.ts 或 protocol.ts。
- `src/pages/content/holodex/contentScript.ts`、`holodex-inject.ts` 的最小整合 hunk。
- `src/utils/options.ts` 的一個 schema key 與其 name/description；不重排其他選項。
- `tests/audio-lock/` 的五個測試檔與 fixtures.ts；`vitest.audio-lock.config.ts`、`tsconfig.audio-lock.tests.json`。
- `package.json` 僅 audio-lock test/watch/typecheck scripts 與 Vitest/jsdom；`yarn.lock` 僅這兩個測試 devDependency 所需解析。parser/plugin 等 lint 工具只在 .cache，不回填產品依賴；不得順便 upgrade runtime/build dependencies、套不同 package manager 或生成根目錄 package-lock.json。

**一律排除：** `docs/plans/`（含本計畫、`docs/plans/reviews/`、`docs/plans/prompts/`）、`.ref/`、`.cache/`、node_modules、dist_chrome、dist_firefox、zip、console dump、profile、個人 agent 設定與 auto-multiview-layout 的全部新碼／測試／文件。這些工作資料可留在目前工作分支，不進產品 commit。`.eslintrc`、tsconfig.json、manifest.json.ts、options HTML/CSS、CI/.nvmrc、src/utils/index.ts／misc.ts 預期不改；需要例外時先修改範圍說明，不自行擴大 PR。

### 與 auto-multiview-layout 的可能衝突及避免方式

| 可能重疊的既有檔案 | 本 PR 的最小改法／獨立性檢查 |
| --- | --- |
| `src/utils/options.ts` | 只追加獨立 `twitchAudioLock` schema/description。另一任務可追加自己的 key；不排序整個 schema、不改 Options.get/set、不新增共用 subscribe helper。rebase 只保留兩個獨立條目，不把對方條目或 commit 搬入尚未合併的本 PR。 |
| `src/pages/options/index.ts`、index.html、index.css | 本 PR 不改，自動 schema 表單已足夠；測試只驗證本選項及原有選項存在，不寫「表單總共恰好四個」等會因另一 PR 新選項而失效的斷言。 |
| `src/pages/content/holodex/holodex-inject.ts` | 只加相對 import＋installAudioLock() 呼叫，保留既有 flags。兩功能各自初始化，不建立共同 installFeatures()、不等另一功能 ready；同一插入點的衝突只需保留各自 import/呼叫，單獨打包時不得夾帶另一項。 |
| `src/pages/content/holodex/contentScript.ts` | 只啟動本功能的 settings bridge，既有 inject 呼叫仍只執行一次；不包成 layout 專用 controller、不等待 layout 設定或 store、不改另一功能注入順序。 |
| `package.json`／`yarn.lock` | audio lock 的本文方案只新增兩個測試 devDependency；layout 的已讀計畫採 node:test，第一 PR 不改這兩檔。兩套工具不同交給 Fi 題 8，不把「以後可能同加工具」當現在事實。若選統一，各自新增自己的 runner/config/commit，不能共享 setup commit；不把 lint 套件加回產品 lockfile。 |
| `tsconfig.json`／Vite configs／新測試 config | 不改產品 config；使用 vitest.audio-lock.config.ts 與 tsconfig.audio-lock.tests.json，include 僅 tests/audio-lock，不爭用 vitest.config.ts／通用 tests/setup.ts。 |
| `src/utils/index.ts`／misc.ts、Vue root/store 探索 | 本 PR 不改這些 utility；audio-lock/holodex-adapter.ts 為內部模組，不匯出給 layout、不 import 對方 helper，也不共用新 module。兩邊可各自有小型、有界發現邏輯，日後兩 PR 都合併再另案評估抽象。 |

獨立性實測必須在「僅 709e963 ＋ 本 PR 產品變更」的 tree 執行完整驗證，不以兩功能同在工作分支時測過代替。單純重疊既有檔案不等於產品相依；任何對方的新 import、全域 flag、setting key、測試 fixture 或 commit 相依都不允許。

### 未來整理產品分支的操作順序（本輪不執行）

以下會建立／移動／切換分支，只能等另行明確授權後執行；這份計畫不包含 push 或開 PR 的可執行命令。本輪到文件 commit 與 r4 DONE 即停止。

1. 在工作分支完成前述五任務，保留**純產品 commit** 的 SHA 清單供 review／追溯，docs commit 另列。記錄最後已驗證的產品 tree SHA；用 git diff 709e963 到該 tree 檢查白名單及既有整合檔的每個 hunk，確認沒有 layout 或其他任務的內容。不能只因路徑在白名單就接受夾帶的別項 hunk。
2. 檢查 worktree 狀態與 `git worktree list --porcelain`，處理既有 fi/twitch-audio-lock 名稱占用前保留 eda 原型參考。若該分支被別的 worktree 使用，不修改別的 worktree，也不 force-reset 它；交由協調者安排名稱／保存方式。只有獲准整理後才以 709e963 為起點建立乾淨 fi/twitch-audio-lock，不能從目前 docs 工作 HEAD 開分支。
3. 從已驗證的產品 tree **直接取白名單最終檔案** 到乾淨 709e963 分支的 index/worktree：使用 git restore 的 --source=<已驗證 tree SHA>、--staged、--worktree，加完整明列 paths；不取整棵 tree、不含 docs，也不重播 eda5b52 或工作 commit。對共享既有檔案只保留已在步驟 1 驗過的本功能 hunk；如果來源含其他任務，先隔離最終產品 tree，再取檔，不能夾帶。
4. 核對 staged 路徑與內容等於已批准白名單產品 diff，再建立一個正式產品 commit（parent 為 709e963）。若 tree／hunk 不符，停在本地修正，不 cherry-pick docs／另一任務來補前提、不 merge。此方式直接交付重寫後內容，eda 與工作 docs 都不是產品祖先。
5. 只讀檢查 `git diff --name-only 709e963...fi/twitch-audio-lock`，逐檔對白名單；`git diff 709e963...fi/twitch-audio-lock -- docs/plans .ref` 預期完全空。`git merge-base 709e963 fi/twitch-audio-lock` 預期完整 709e963 hash；單產品 commit 方案的 `git rev-list --count 709e963..fi/twitch-audio-lock` 預期 1，且新增 commit 不等於任何工作 docs 或另一任務產品 SHA。
6. 在乾淨產品 tree 重新安裝 frozen lockfile 並跑下列驗證，不引用 .ref 的 fixture；補英文草稿的實際結果。若 upstream/dev 後來移動，先報告與原指定基準的差異，再安排 rebase／重驗，不默默合入另一項功能；共用已合併 upstream 祖先是正常的，但兩項未合併新增 commit 必須仍各自獨立。
7. 產出供協調者 review 的本機產品 commit、差異檔案清單、驗證結果及英文 PR 草稿。未取得解除硬性禁令的明確授權前，仍不 push、不開 PR、不 merge；方向資訊不是操作授權。

### PR 前 lint／typecheck／測試／雙 build

在乾淨產品 tree、Node 22.12+，先設定上述 NPM_CONFIG_CACHE／YARN_CACHE_FOLDER／TMPDIR，所有 npm cache/log 都留在 worktree。以下是**下一輪實作時的本地驗證準備**，本輪不安裝，且檔案／依賴一律不提交：

```sh
npm install --prefix .cache/audio-lock-lint --no-save --no-package-lock --ignore-scripts eslint@8.57.0 eslint-plugin-react@7.37.2 @typescript-eslint/parser@8.18.0 @typescript-eslint/eslint-plugin@8.18.0 typescript@5.6.3
```

在 `.cache/audio-lock-lint/config.cjs` 寫入下列內容；只改 parser 的解析位置，不改 repo .eslintrc 或規則：

```js
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const config = JSON.parse(fs.readFileSync(path.join(root, ".eslintrc"), "utf8"));
module.exports = { ...config, parser: require.resolve("@typescript-eslint/parser") };
```

在同資料夾寫 `run.cjs`。它固定使用 cache 內的 CLI/config/plugins，不靠產品 node_modules 的 parser；有 args 時用 caller 明列的 baseline 檔案，無 args 時只 lint 本功能新增檔案：

```js
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const scope = ["--max-warnings", "0", "--ext", ".ts",
  "src/pages/content/holodex/audio-lock", "src/pages/content/holodex/twitch-audio-lock.ts",
  "src/pages/content/holodex/audio-lock-settings.ts", "tests/audio-lock", "vitest.audio-lock.config.ts"];
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [path.join(__dirname, "node_modules/eslint/bin/eslint.js"),
  "--no-eslintrc", "--no-ignore", "--config", path.join(__dirname, "config.cjs"),
  "--resolve-plugins-relative-to", __dirname, ...(args.length ? args : scope)],
  { cwd: root, stdio: "inherit", timeout: 120000 });
if (result.error) process.exit(result.error.code === "ETIMEDOUT" ? 124 : 1);
process.exit(result.status ?? 1);
```

完成工具準備後，在相同本地 cache 環境與既有逾時 wrapper 下執行：

```sh
yarn install --frozen-lockfile --non-interactive --cache-folder "$YARN_CACHE_FOLDER"
node .cache/audio-lock-lint/run.cjs
node .cache/audio-lock-lint/run.cjs src/utils/options.ts src/pages/content/holodex/contentScript.ts src/pages/content/holodex/holodex-inject.ts --format json
yarn typecheck:audio-lock
yarn test:audio-lock
yarn build:chrome
yarn build:firefox
git diff --check 709e963...fi/twitch-audio-lock
```

scope lint、typecheck、tests 與兩 build 預期 exit 0。三個既有整合檔的 ESLint 要用**同一個 run.cjs／同一 .eslintrc 派生 config** 對 709e963 原檔重跑 baseline：只用 git show 複製到 worktree `.cache/lint-baseline/` 的對應檔名，將該三個暫存檔路徑與 --format json 傳給 wrapper。不要回用根 config 的 parser 解析或產品 yarn eslint 指令；wrapper 已固定 --no-eslintrc／--no-ignore 與 cache plugin 路徑。若既有 @ts-ignore 等報錯，記錄實際 rule/message/source；新 hunk 必須零新增診斷，不能關 rule、改無關 flags，或把 exit 1 記為全倉 lint 通過。報告區分 scoped pass 與 baseline 問題，不預先捏造次數；暫存工具與 config 均不進 PR。

重點檢查：產物仍為 dist_chrome 與 dist_firefox、manifest 權限不變、資源引用存在，且產品 bundles 無 Vue 測試 runtime、工作文件或 .ref。`.nvmrc`／手動 CI Node 18 是既有不相容項，這個 PR 不以未跑過的舊 CI 宣稱綠燈，也不混入工具鏈遷移。人工清單的廣告／重連／首次真點擊結果填入 PR，未遇到的廣告寫未覆蓋，不能預先勾選。

### 英文 PR 標題與描述草稿

Title: **fix: prevent Twitch players from taking over multiview audio**

以下描述是待填結果的草稿；送出前改成實際最終行為與實測結果，不帶本地 planning/review 路徑，不宣稱已做未執行的測試：

```markdown
With Holodex Mute Others enabled, a Twitch embed can report itself as unmuted after startup or recovery. Holodex treats that report as a new audio selection and mutes the stream the user was listening to.

This change keeps the selected multiview audio until another selection is made. It guards polling, refresh and first-play paths, handles newly added cells without an assigned mute state, and adds an extension option that only applies while Mute Others is enabled. Media controls remain the reliable way to select audio; iframe focus grants a short, single-use intent window. Unsupported Holodex structures disable the guard with one warning. No additional permissions or runtime dependencies are required.

Validation (replace with actual results before submitting):
- [ ] Scoped ESLint and touched-file baseline comparison
- [ ] Product and audio-lock test/config type checks
- [ ] Audio-lock regression tests, including unassigned cells and microtasks between event listeners
- [ ] Chrome and Firefox builds
- [ ] Chrome/Vivaldi/Firefox checks: first panel click, mixed players, new cells, presets, reconnects and setting changes
- [ ] Real Twitch ad break observed; otherwise report this as not covered

Limitations: iframe interactions cannot be identified precisely across origins, and polling may allow brief audio leakage. The guard catches its own API failures but does not repair Holodex's Vue observation errors. A confirmed mute of the active player leaves audio silent until it is selected again. New first-play audio is reserved for initialization; later starts preserve the selected cell.

This PR is independent of auto-multiview-layout and can be reviewed and merged on its own. It includes only the audio-lock implementation, focused tests and the tooling needed to run them.
```

## 驗收條件

- [ ] 產生可用的 Chrome 與 Firefox build，既有 options、注入 flags、YouTube 相關功能無退化；權限及 host 範圍不變。
- [ ] adapter 接受 `muted ∈ {true, false, undefined}`，一般 URL 全缺值仍啟用；bootstrap 首播／fallback 將四格收斂成單格，全靜音不會誤啟 bootstrap；locked 新增 U 與 preset 更換／合併各有測試且不誤降級。
- [ ] bootstrap 的 U／false 明確為 desired=unassigned，首播前 poll 對它們零 mute 呼叫；選成 active 的三條路徑都有 U→false、effective prop 不變、watcher=0、raw player 真正 false 的斷言。恢復只能用當次 grant 一次，停用／全靜音／新選擇取消 pending grant，SDK 拒絕不形成無限 unmute。
- [ ] A 被選定後，B 的未授權 false、首次播放、READY、manualRefresh 都不能把 active 改成 B；尚未選格的 bootstrap 另允許首播一次。YouTube 新首播政策依 Fi 題 1，不把產品取捨誤稱無行為變動。
- [ ] 面板真實使用者**第一次 click 就切換成功**，capture 與 target 間 flush microtasks 的測試通過；window bubble／Event 身分／eventPhase／0ms fallback 都覆蓋。可全部靜音、快速最後選擇獲勝；hover 不提供永久授權。
- [ ] store debounce、750ms read timeout、1500ms settle、500ms store 收斂、舊 generation／epoch 結果與卸載都由測試覆蓋；測試及 build 的 wall-clock timeout 有效。
- [ ] 不靠元件名稱才能找得到；必要契約缺失則整組不動作、一次 warn、頁面可繼續用；不留下 mixin 或半套 wrapper。
- [ ] 原始 SDK 參考與 methods 存在 closure；不碰跨網域 window、不嘗試偽 raw 解包、不修改 Vue observer／SDK 可擴充性；無本功能產生的 uncaught SecurityError 或 Promise rejection。
- [ ] 第一版沒有 Twitch constructor Proxy、assignment trap 或未配對 SDK registry；原 global descriptor／constructor identity 全程未改，晚綁 ready 後才讀寫 API。
- [ ] Vitest config 可解析真 options entry 的 `@utils` 與 `@assets` import，無 CRXJS plugins；`yarn typecheck:audio-lock` 同時涵蓋產品、tests、fixture、vitest.audio-lock.config.ts；`.cache` 沿用原 ignore，不引入無需的 ignore 改動。
- [ ] 第一個 PR 的新增模組／helpers／測試與 auto-multiview-layout 完全獨立；沒有引用對方 setting/flag、未合併 commit 或 test setup。相同既有檔案只保留本功能的最小 hunk，沒有通用 utils/config 重構。
- [ ] PR 產品 tree 由指定 upstream/dev@709e963 準備，正式 head 為 fi/twitch-audio-lock；重寫取代 eda5b52，最終產品 commit 不包含 eda 或 docs 工作 commit 作祖先，亦不包含 docs/plans、reviews、prompts、.ref 或產物。實際整理分支與發佈須另行授權，本輪僅驗收計畫。
- [ ] scoped lint、既有整合檔 baseline 比較、typecheck、回歸測試、Chrome/Firefox build 都在僅上游基準＋本 PR 的 tree 重跑；英文 PR 草稿填入實際結果／限制，不把尚未執行的項目預勾。產品 commit 與本地文件 commit 各自分開。
- [ ] lint 只從 .cache/audio-lock-lint 的臨時環境執行，與 baseline 用相同 parser/plugin/config；產品 package.json 不加回 a5ff269 移除的套件、不加 lint script，產品 lockfile 只有 Fi 選定測試方案必要變動。Fi 題 8 已明列本案／layout 的工具差異與兩種統一方向。
- [ ] options 的 `twitchAudioLock` 預設 true、持久化、同頁熱切換；只有配合 Holodex Mute Others 才生效，沒有 localStorage 秘密第二開關。
- [ ] 人工測試有瀏覽器版本與結果，真實廣告／重連不能用 fake 或 build 成功代替；未覆蓋項目明列 warning。必要真實場景尚未通過時，只可交付候選版實測。
- [ ] 關閉／重複安裝／離開頁面釋放所有音訊相關資源；pending effects 不得在停用後改頁面。
- [ ] 本規劃回合提交範圍僅計畫文件；沒有 src、lockfile、`.ref`、產物變更，也沒有任何 remote 動作。

## 風險與不做的事

1. **跨網域意圖有歧義。** 無 Twitch mute-change event、也看不到 iframe 內可信點擊；短 token 仍可能誤把焦點附近的自動 unmute 當意圖。面板是正式支援的可靠操作路徑；不宣稱完全判別所有直接播放器操作。
2. **輪詢有空窗。** 主要時鐘為站方的 1 秒 poll，背景 tab 會節流；可能有短促漏音。這版保證不讓未授權變化變成切換命令，不承諾零毫秒漏音或 OS 音訊隔離。不增加高頻輪詢補償。
3. **Vue 2 私有結構會變。** 形狀驗證比名稱穩健但不是官方 API；React/Vue 3 升級需要新 adapter。降級會回到站方原本行為，不宣稱保護仍在。
4. **late-bind 不是反應性修復。** Vue 2 可能就地改寫原 SDK instance；late-bound 不能把它還原，提前捕捉同物件也無法避免。已出現的 Holodex SecurityError 不保證減少。console 物件展開、深搜或 deep watch 都可能增加問題，因此禁止。
5. **初始化與新增格是產品政策。** 預設 bootstrap 保留首次首播一次，已有 active 後則連 YouTube 新首播也不搶聲；與原生及原型都不同，Fi 題 1 明確列出選項。第一版不攔截 SDK 或強迫建構 options `muted=true`；新格 ready 前可能短暫有聲，不能假裝初始化零漏音。
6. **既有全靜音／暫時靜音。** 已完成選聲交易的 active 再回報 muted 時，本版傾向同步成全靜音，不重新授權 unmute，避免違反使用者靜音或 autoplay 限制；廣告後可能需要重新在面板選擇。選聲當下的 U→false 補償只有單次 grant，不包含這種日後自動恢復。這是待 Fi 確認的產品取捨。
7. **有限範圍。** 不做廣告攔截、不改 Twitch 影片／音量／播放品質、不改 Holodex Vuex mutation 原始碼、不修全站 SecurityError、不全域壓 console、不加 overlay、不增加遙測或遠端設定、不改其他 options 行為、不做 Firefox 發佈／簽章或 Chrome 上架。

### 規模與分波估計

第一 PR 縮為約 10 個產品檔案（其中 6 個為新模組）、5 個測試檔＋一個局部 fixture、兩個 feature config、package／lock 配套，合計約 20 個檔案。intent 合併 controller，protocol 合併純 contracts；臨時 lint 環境不在 review diff，產品只加兩個測試 devDependency。產品碼仍估 600–950 行、測試約 500–750 行，另計測試依賴 lockfile；這是有界功能範圍估計，不能為減行數拿掉 N1／事件順序回歸。Fi 題 8 可選零新依賴並統一 node:test，或維持不同工具；選定後各 PR 仍須獨立可驗證，不共享新 helper／setup commit。

波次一（狀態機＋測試基礎）約 0.5–1 工作日；波次二（adapter、PlayerPort、競態與意圖）約 1.5–3 工作日；波次三（options、雙 build、瀏覽器實測）約 1–2 工作日，另計等待真實廣告與無法即時重現的情境。各任務以測試與可撤銷整合為邊界，先留本機小 commit，不自動合併或發佈。

## 待 Fi 決定的問題

Fi 可直接回答「1A、2A、3A……」或只回想改的題號。以下 A 均為**建議預設**，設計、步驟與測試按 A 描述；若改選，先同步改規格與預期測試，不能在實作時混用不同首播政策。列出預設不是本輪實作授權。

1. **初始四格沒有 muted、新增／首播格要如何取得聲音？**
   - **A（建議預設）：** 尚未選格時允許一次原生首播 bootstrap（必要時選已 ready 且在播的第一格）；已有 active 或全靜音決定後，Twitch／YouTube 新首播都不搶聲，新 U 格 ready 後靜音。會改變原生「新開播 YouTube 也取得聲音」的行為。
   - **B：** 初始化同 A，之後只擋 Twitch 自動首播；YouTube 保留原生新首播取得聲音，使用者選擇也可能被新 YouTube 格取代。仍須正規化其他 U、處理 debounce，不可回到全部有聲。
   - **C：** 完全禁止自動選聲，連初始化都由擴充功能將 ready 格正規化全靜音，必須手動選一格；不能把全 U 留成多格有聲。這是最明顯的啟動行為改變。
2. **整批換 preset 且原 active 不在新內容時，要重新選聲嗎？**
   - **A（建議預設）：** 舊選擇非 silence 才開始新 bootstrap；合併仍保留 active 就保持它；先前全靜音則換 preset 後仍全靜音。單格刪除／換片 active 一律等待使用者選擇。
   - **B：** 任何移除 active 的 preset 都維持全靜音，不重新 bootstrap；使用者必須再選。保留 active 的合併與重排仍不變。
3. **新選項預設與舊 localStorage off 要如何升級？**
   - **A（建議預設）：** `twitchAudioLock=true`；不自動遷移網站 `off`，改用 options 關閉。
   - **B：** 預設 true，但做一次僅讀網站 off 的遷移，不能覆蓋已有 extension 設定；先補遷移與多分頁競態規格，再實作。
4. **是否接受直接操作長時間聚焦的 iframe 可能被擋？**
   - **A（建議預設）：** 2500ms 一次性焦點訊號；接受限制，面板是可靠入口，或先移出再進入 iframe。
   - **B：** 需要額外「聽這格」按鈕才可交付；另排 overlay 設計／可及性與測試，不改成無限 hover 授權。
5. **active 因廣告／播放政策回報 muted 時，是否維持選擇？**
   - **A（建議預設）：** settle 後確認 true 就同步全靜音，需要重新選擇，不自動 unmute。
   - **B：** 記住最後選擇跨廣告保留；先補「最後選擇／目前可發聲」分離及手動 mute 不可精確辨識的規格，不能直接自動 unmute 代替。
6. **安全降級要如何通知？**
   - **A（建議預設）：** 第一版只一次 console.warn，不加頁面通知。
   - **B：** 另排 options 狀態顯示，使用者需直接看見保護已停用。
7. **是否把修 Holodex 自身 SecurityError 納入這版？**
   - **A（建議預設）：** 不納入；只限制本功能存取與捕捉自身錯誤，不改 observer／SDK。
   - **B：** 另行授權隔離實驗研究 markRaw 等方案；實驗不得阻塞或偷偷擴入本候選版。
8. **兩個上游 PR 的測試工具要接受不同，還是統一？** 目前 layout 計畫採 **node:test、零新依賴、不改 package/lockfile**；audio lock 本文採 **Vitest 3.2.6＋jsdom 26.1.0、兩個新測試 devDependency**，有 DOM/options 載入、timer 與 watcher fixture 回歸，第一 PR 會改 package/lockfile。上游 a5ff269 曾移除 @typescript-eslint/parser/plugin；**以下三選項都不把它們加回產品依賴**，lint 均採 .cache 臨時環境。
   - **A（建議預設）：接受不同。** audio lock 保留本文可直接執行的 Vitest/jsdom suite，layout 保留 node:test；多兩個測試依賴與第二套 runner 是明確成本。建議理由是保住本案真 options entry／DOM 及時間序自動回歸，同時不為純 planner 型的另一案導入框架；不是宣稱兩工具已統一或 Fi 已核准。
   - **B：兩案統一 node:test、零新測試依賴。** layout 不變；先將本案步驟／allowlist 改為既有 TypeScript 編譯＋本案自己的 Node runner，必須保留 desired/grant/Boolean watcher 與 capture→microtask→target 的 fake API 斷言，DOM/options integration 留明確人工或等價測試。先補確切 runner/config/指令再實作；不從 layout 匯入或 cherry-pick runner/helper，不讓本案依賴它先合併。
   - **C：兩案統一 Vitest。** audio lock 保留本文；協調者另更新 layout 的計畫與各自產品白名單／依賴決策。兩案各自可獨立安裝／測試、各有局部 config 與 commit，不能共用一個新 infrastructure commit，也不能由本輪擅改另一案或假定已批准其依賴變更。

Git metadata 寫入已在 `DISPATCH-2610171431178858` 核准必要例外，本輪 `DISPATCH-2610171506069175` 延續允許；只提交此計畫檔，不建立／切換分支。未來 fork→upstream 的 PR 方向不解除目前禁止 push、開 PR、merge 的規則。

## 驗收回應（第 2 版）

對應唯讀報告 `docs/plans/reviews/twitch-audio-lock-verify-1.md` 的第 1–8 項；下列 path:行號皆為原始碼證據，不是引用已變動的計畫行號。Holodex 證據為前述 `8c6d0da` 副本；本 repo 證據以受驗版 `d33360b` 為準。本輪只核對文件與原始碼，未安裝依賴或執行產品測試／build。第 3 版將測試 config/script 改為 audio-lock 專用名稱、將真 Vue runtime fixture 延後，但本段處置的三態、事件順序、aliases 與 typecheck 修正仍在第一 PR 內，不依賴另一功能。

| 發現 | 回應 | 證據與具體修訂／驗證 |
| --- | --- | --- |
| 1 high：muted 缺值 | **接受** | `.ref/holodex/src/utils/mv-utils.ts:110`、`.ref/holodex/src/components/multiview/CellContainer.vue:101`、`.ref/holodex/src/components/multiview/MultiviewLayoutMixin.ts:37` 建立的 content 省略 muted；`.ref/holodex/src/components/multiview/VideoCell.vue:95` 原樣返回。改契約為三態，區分 bootstrap／silence，新增四 U 初始化、locked 加格、preset 取代／合併測試與人工清單；U 與已知 layout 變化不再觸發未知衝突降級。另處理 `VideoCell.vue:174` 的提前返回，避免用 setMuted(false) 初始化卻沒有真正 solo。 |
| 2 high：microtask 清授權過早 | **接受** | `.ref/holodex/src/components/multiview/MediaControls.vue:90`、`:192` 的面板同步 handler 須在 trusted scope 內；HTML/DOM 規格連結已補於意圖段。改 window capture 開啟、同 Event 的 window bubble 關閉、eventPhase=NONE 檢查與 0ms 保底。新增 capture→flush microtasks→target 的回歸測試及三瀏覽器「第一擊就成功」人工項，不以 jsdom dispatchEvent 通過當證據。 |
| 3 medium：YouTube 新首播政策 | **接受** | `.ref/holodex/src/components/multiview/VideoCell.vue:192` 的原生首次播放不限 provider；`src/pages/content/holodex/twitch-audio-lock.ts:198` 原型只抑制 Twitch。新設計不再全擋初始化；Fi 題 1 明列 A 已有選擇才鎖兩者／B 只鎖 Twitch／C 全部自動選聲禁用，建議 A，題 2 另決定 preset。設計、步驟、測試與驗收均明寫所採預設的行為改變。 |
| 4 medium：SDK 全域攔截無實益 | **接受** | `.ref/holodex/src/components/player/TwitchPlayer.vue:86` 把建構回傳的同一 instance 放進 player，`:116`、`:120` 只需其公開 methods。刪除 constructor Proxy、assignment trap、未配對 registry 與還原流程；players.ts 唯一途徑為 ready 後 late-bind。測試改為 globals／constructor／descriptor 全程未變，而非測如何包裝它們。仍明示 late-bind 不會撤銷 Vue 2 getter。 |
| 5 medium：options aliases 缺失 | **接受** | `src/pages/options/index.ts:1`、`:2` 用 @utils 與 @assets CSS；`tsconfig.json:19` 的 TS paths 不會自動套入獨立 Vitest config。步驟列明五個 resolve.alias 絕對映射及 css:false，測試需載入真 options entry、mock polyfill 而不 mock @utils，確保實際 import 路徑通過。 |
| 6 low：測試未 typecheck | **接受** | `tsconfig.json:27` 的 include 沒有 tests 或 vitest.audio-lock.config.ts。新增 tsconfig.audio-lock.tests.json 與雙 tsc 的 typecheck script；步驟、驗證命令與驗收條件同步要求涵蓋 fixture／tests／config。 |
| 7 low：布林橋接過重 | **部分接受** | `src/utils/options.ts:48` 是非同步 local.get，`:63` 記載獨立 onChanged 事件，因此讀取期間變更保護仍有必要。已刪除 ready 重試、訊息 revision 與跨 context 讀取世代，改單次 ready＋單一 in-flight read 的 changedDuringRead boolean；保留 5000ms timeout 以符合有界等待要求。晚到 resolve/reject 不覆蓋已收到的新值，相關測試同步簡化。 |
| 8 low：重複 ignore | **接受** | `.gitignore:136` 已有不帶尾斜線的 .cache，`:148` 另有舊規則。本版統一輸出到 .cache，不產生 .vitest；檔案表與規模估計改為不修改 .gitignore，也不改審查報告。 |

第 1 輪全部 high／medium 均接受並落實於本文件；低嚴重度第 6、8 項接受，第 7 項縮減機制但保留非同步讀取的必要失敗邊界。Fi 尚未回覆產品選項時僅按標示預設交付候選版規格，不能稱為 Fi 已核准行為。

## 驗收回應（第 3 版）

對應唯讀 `docs/plans/reviews/twitch-audio-lock-verify-2.md` 的 N1–N4（受驗版 09b7bf2）。第 1 輪項目已由驗收者確認解決，本輪保留其修正，新增以下處置；只核對原始碼／Git 歷史與文件，不宣稱已跑產品測試、lint 或 build。

| 發現 | 回應 | 原始碼證據與修訂／必要斷言 |
| --- | --- | --- |
| N1 medium：bootstrap desired／U→false 無 watcher | **接受** | `.ref/holodex/src/components/player/PlayerMixin.ts:13` 的 Boolean mute 預設 false；TwitchPlayer.vue:57、YoutubePlayer.vue:45 只在 prop 變動時呼叫 watcher；store/multiview.module.ts:224 把被選格寫 false，不能保證實際音訊。新增 desiredMute 三態，bootstrap U/false=unassigned、poll 零 mute；首播／fallback／明確選擇共同建立一次 grant，必要時以與站方 `.ref/holodex/src/components/player/TwitchPlayer.vue:120`／`.ref/holodex/src/components/player/YoutubePlayer.vue:104` 相同的公開 SDK 路徑恢復所選 player。fixture 的 effective prop 必須 false→false、被選 watcher=0，仍斷言 rawMuted=false；另測 grant 單次、stale/停用/全靜音取消與 restore 失敗無循環。 |
| N2 medium：移除歷史與工具差異 | **接受** | `git show a5ff269 -- package.json` 明列移除；`package.json@a5ff269^:35`、`:36` 是原先兩個 ^7.8.0 套件。另一案 `00c261a:docs/plans/auto-multiview-layout.md:295` 明列 node:test／既有 TS／零依賴，`:299` 禁止本案依賴其 runner。背景與 Fi 題 8 現在列出歷史及「接受不同／兩案 Node／兩案 Vitest」三選一，本文方案 A 僅新增兩個測試 devDependency，非已獲 Fi 核准。lint parser/plugin/config/run.cjs 全放 .cache、同版對 baseline；不加回產品 package/lock 或新增 lint script。 |
| N3 low：重放原型的打包流程過長 | **接受** | 改由已驗證產品 tree 的白名單最終內容，用未來獲准後的 path-scoped git restore 取到乾淨 709e963 分支；共享既有檔案先查 hunk 不夾帶 layout。工作產品 commit 與 docs commit 繼續分開供追溯，不重播 eda、不 cherry-pick 文件；最終一個產品 commit 的 parent 仍為 709e963，兩 PR 完全獨立。 |
| N4 low：模組／review 面偏大 | **接受，採安全合併** | 意圖追蹤併 controller；protocol 型別／validator 併原窄型別成純 contracts，而非併入會 import Options/storage 的 settings。`src/utils/options.ts:1` 明確 import webextension-polyfill，page script 不能間接載入；contracts 無 side effect／extension import，供本功能兩 context 使用。新產品模組由 8 減到 6、預估總檔案約 22 減到 20；白名單、步驟、scope lint 與估計同步更新，不拿掉安全回歸，也不抽成兩功能共用 helper。 |

本次交付仍只有這份計畫文件。臨時 lint 安裝與 SDK grant 的產品程式均留待之後實作；第 3 版回應章節是驗收回應次序，本文件此次提交標記使用 r4。
