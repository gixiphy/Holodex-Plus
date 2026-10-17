你是 Holodex-Plus（MIT，Chrome/Firefox 擴充功能，Vite + React + TS，manifest 由 manifest.json.ts 產生）的規劃者。工作目錄是本 worktree（分支 gixiphy/twitch-audio-lock，HEAD eda5b52 = 原型 commit）。

## 硬性規則（違反就停下回報）
- 禁止 push、禁止開 PR（pull request）、禁止 merge 到任何 remote 分支、禁止公證（notarize）、禁止 sudo。
- 禁止刪除 worktree 以外的任何東西；所有寫入限於本 worktree（只寫入本 worktree），不要寫到 iCloud 主 checkout 或家目錄。
- 可以使用外掛／plugin skill（如 Superpowers）的流程，但產出一樣只寫入本 worktree。
- `.ref/` 是唯讀參考資料（已被 git exclude），不要修改、不要 commit。
- 這一輪只寫計畫，不改 src/ 底下的程式碼。可以跑 `npm install`／`npx yarn install`、`yarn build:chrome` 之類的指令來確認現況，但不要 commit 產物或 lockfile 變動。

## 背景
- holodex.net 多窗（multiview，Vue 2）有「靜音其餘影片 / Mute Others」設定。問題：Twitch 格子會自己變回有聲，Holodex 的 VideoCell 每秒輪詢 isMuted，發現某格沒靜音就當成使用者選了那格、把其他格靜音，於是 Twitch 搶走正在聽的 YouTube 聲音。
- 原型：`src/pages/content/holodex/twitch-audio-lock.ts`（新檔）＋ `src/pages/content/holodex/holodex-inject.ts` 一行 hook。做法是記住「使用者要聽的那格」，其他格自己變回有聲就壓回靜音；使用者在播放器內點擊取消靜音只在點進那格 10 秒內或滑鼠停留時才算數；依賴 Holodex 內部 VideoCell 元件名稱；開關目前放 localStorage。
- 研究筆記：`.ref/holodex-twitch-audio.md`。Holodex 前端原始碼（dev 分支，唯讀）：`.ref/holodex/`，重點看 `src/components/multiview/VideoCell.vue`、`src/components/player/TwitchPlayer.vue`、multiview 的 Vuex store。
- 實測：Fi 在 M1 Vivaldi 裝了原型（unpacked），確認 Twitch 現在可以靜音、功能可用。但 console log 有原型的 re-mute 嘗試，也有大量（約 6800 次）cross-origin SecurityError，來源是 Holodex 把 Twitch player 物件（含 `_embedWindow`，一個跨網域 iframe 的 window）包進 Vue 2 reactive，Vue 走訪/代理時碰到跨網域 window 就丟錯。這些錯誤大多是 Holodex 本身產生的。

## 任務
寫一份正式版的細部計畫到 `docs/plans/twitch-audio-lock.md`，把原型強化成可以長期用的版本，之後交給 Cursor 依計畫實作（Cursor 只看這份計畫，所以要具體到檔案、函式、步驟）。計畫必須包含以下四個章節標題（Markdown 標題，文字要含這些字）：「檔案」、「步驟」、「測試」、「驗收條件」，另加「背景與目標」「設計」「風險與不做的事」「待 Fi 決定的問題」。

計畫要涵蓋（先讀原型與 .ref 原始碼再判斷，不合理的可以提出替代方案並說明理由）：
1. 掛勾方式更穩健：找 Vue root / Vuex store / VideoCell 元件的方式不要只靠元件名稱字串；名稱或結構找不到時要安全降級（不動作＋一次性 console.warn），不能讓頁面壞掉。說明怎麼偵測 Holodex 改版。
2. 對 SecurityError 雜訊的容忍：存取 player 時用 raw／未被 Vue 代理的物件（例如從 iframe/embed 實例或 Twitch.Player 原始參考取得，或 `__ob__`/markRaw 類手法在 Vue 2 下的等價做法），所有跨網域存取都 try/catch，不要讓我們的程式增加錯誤量；評估能不能在不改 Holodex 行為的前提下降低 Holodex 自己的錯誤（若有風險就列為不做）。
3. 「使用者要聽哪一格」的判定：改善 10 秒/hover 限制（例如偵測 iframe focus/blur、pointerdown 在 cell 上、媒體控制面板按鈕），清楚定義狀態機（誰是 active cell、何時換、何時壓回）。
4. 設定開關移到擴充功能的 options 頁（沿用 repo 既有的 options/storage 機制，看 src/pages/options 與現有設定怎麼存），預設值、與 Holodex 自己的 Mute Others 設定的關係。
5. 測試：在可行範圍加自動測試（例如用 vitest＋jsdom 測狀態機與降級邏輯，或用假的 player 物件），說明 repo 目前沒有測試框架時要加哪些 devDependency 與 script，以及需人工測試的清單（真實 Twitch 廣告插播、斷線重連、多格 YouTube＋Twitch、換格）。測試要有逾時。
6. 建置：Chrome 和 Firefox 都要能 build（`yarn build:chrome`、`yarn build:firefox`），列出驗證指令與預期產出路徑；manifest 權限是否需要變動。
7. 估計改動規模與分波（若需要拆成多個小任務）。

完成後：把 `docs/plans/twitch-audio-lock.md` 在本機 commit（只 commit 這個計畫檔與必要的 docs/ 檔，訊息例：docs: plan for twitch audio lock production version），然後在終端最後一行印出 `twitch-audio-lock-plan-DONE`。
