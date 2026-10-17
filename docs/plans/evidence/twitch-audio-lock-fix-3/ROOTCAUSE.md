# A twitch-audio-lock：Fi 21:15「鎖不住」根因（協調者 Grok Bot，2026-10-17 21:45 台北時間）

## 結論
正式版 build（gixiphy/twitch-audio-lock HEAD 3893149，dist_chrome）在 holodex.net 上**頁面腳本根本沒有執行**：
- `assets/holodex-inject.ts-BjDs9NrB.js` 第一行是 `import{…}from"./contracts-WeqbDogD.js"`（Vite/Rollup 因為 content script 和頁面腳本共用 `contracts`，把它拆成共用 chunk）。
- 但注入它的 `misc` 函式是用 `<script type="text/javascript" src=…>`（傳統 script）插進頁面：
  `function I(a){const c=document.createElement("script");return c.src=D.runtime.getURL(a),c.type="text/javascript",…}`
- 結果 Chrome 丟 `SyntaxError: Cannot use import statement outside a module`（headless Chrome 實測，每次載入頁面都出現），整支頁面腳本一行都沒跑：音訊鎖沒裝上，`window.HOLODEX_PLUS_INSTALLED_V3`、`ARCHIVE_CHAT_OVERRIDE` 也都沒設（holodex.net 上其他 Holodex+ 頁面功能一併失效）。
- MVP（/Applications/Extensions/holodex-plus-audiolock-chrome）的頁面腳本是單一檔案、沒有 import，所以傳統 script 注入沒問題。

## 為什麼測試沒抓到
117 個單元測試、15 個 probe、typecheck、build exit 0 都是對原始碼模組或 build 結束碼；沒有任何一步把 dist_chrome 真的載進瀏覽器跑在 holodex.net 上，也沒有檢查注入的 chunk 能不能當傳統 script 執行。

## 重現（M1，headless Google Chrome 155，CDP Extensions.loadUnpacked，暫存 profile，不碰 Vivaldi）
- 真 holodex.net/multiview；Twitch embed 和 YouTube iframe API 換成假播放器（真的 Twitch 在 headless 不會 ready），一格 YouTube＋一格 Twitch，Mute Others 開。
- 情境：YouTube 先播、Twitch 晚 3 秒播；Twitch 自己取消靜音 1 次；Twitch 靜音延遲 2.5 秒並每 4 秒自己取消靜音共 6 次；最後真的滑鼠點進 Twitch 播放器並取消靜音（應切換）。
| build | 頁面腳本 | Twitch 晚播後 | 自己取消靜音後 | 延遲＋重複 6 次 | YouTube 被靜音的取樣 | 使用者點 Twitch |
|---|---|---|---|---|---|---|
| 無擴充（原生） | — | Twitch 搶走 | Twitch | Twitch | 156/168 | Twitch |
| MVP | 有跑 | YouTube | YouTube | YouTube | 0/168 | 切到 Twitch |
| 正式版 3893149 | SyntaxError，沒跑 | Twitch 搶走 | Twitch | Twitch | 156/168 | Twitch |
| 正式版只把 contracts 內嵌進頁面腳本（診斷用，未改 repo） | 有跑 | YouTube | YouTube | YouTube | 0/168 | 切到 Twitch |
=> 正式版的行為和「沒裝擴充」完全一樣；只修好注入格式後，鎖定邏輯在同一套情境下和 MVP 一樣有效。

## 其他和 MVP 的差異（在這次重現中沒有造成失敗，列給修正計畫參考）
1. MVP 包住 `window.Twitch.Player`，建構時預設 `muted:true`；正式版沒有。
2. 正式版有「degraded」模式：連續 3 次靜音沒生效（player-mute-did-not-settle）、store 沒收斂、契約檢查失敗等就整個放棄、退回原生行為，直到換頁才重置；MVP 每秒無條件壓回靜音、不放棄。
3. 正式版使用者意圖窗 2.5 秒（點擊/iframe focus），MVP 10 秒。
4. 正式版對 VideoCell/播放器的契約檢查很嚴格（cellContent、twPlayer/ytPlayer、iframe host 等），任何一項不符就 degraded。

## 證據檔
- 本資料夾 harness/、results/（box 另有 /workspace/a-diag/ 的完整診斷檔）
- M1：/tmp/hplus-repro/{none,mvp,new,newfix}.json
