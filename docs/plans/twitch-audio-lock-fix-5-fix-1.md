# Twitch audio lock fix-5 第 2 輪修正計畫（fix-5-fix-1）：同一個 iframe 第二次點擊的意圖被去重丟掉，以及 live harness 跑完 a–g

> 執行者是 Cursor，驗收者是 Codex。逐任務實作，步驟用 checkbox（`- [ ]`）追蹤。實作偏離本計畫時，寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-7.md` 的「偏離」段落。不要回頭改本計畫、`docs/plans/twitch-audio-lock-fix-5.md`、主計畫或既有報告／審查。

**Goal：** 在真的 `player.twitch.tv` iframe 上，使用者第二次（以後）點同一個 Twitch iframe 取消靜音時，也會切到 Twitch，不被壓回；live harness 修到 normal／fallback／MVP 都能完整跑完各自的情境，並達到 fix-5 驗收條件 5、6、7 的門檻。

**Architecture：** 產品只改兩處：(1) `controller.ts` 的 window `blur` 意圖偵測拿掉「同一個 iframe 不重複記錄」的去重，每次 blur 時 `document.activeElement` 是某格的 iframe 就送一次 `IFRAME_INTENT`（照 MVP，每次 blur 都記錄時間），2.5 秒意圖窗不變；(2) `twitch-embed.ts` 檔頭改成「尚未在真 iframe 驗證」。harness 先確認 Codex 在 `2735459` 做的修正，再補上本輪協調者實跑暴露的缺陷（面板關閉後找不到空白區而例外、主機例外與 harness 例外混在一起、單一情境例外就整輪中止、靜音切換可能被鍵盤備援再切回）。

**Tech Stack：** 既有 TypeScript、Vitest＋jsdom（`vitest.audio-lock.config.ts`）、既有 `tests/e2e-browser/audio-lock/live.mjs`（Node 內建模組 + CDP pipe），不新增 dependency。

**依據：** `docs/plans/twitch-audio-lock-fix-5.md`（以下稱「原計畫」）、`docs/plans/reviews/twitch-audio-lock-impl-review-6.md`（第 1 輪驗收 FAIL，0 high／5 medium）、`docs/plans/reports/twitch-audio-lock-impl-6.md`、協調者 2026-10-18 02:4x 在 M5 用 `live.mjs @2735459` 對 fix build 跑的 normal 一次（證據 `docs/plans/evidence/twitch-audio-lock-fix-5/round2/normal-1.json`、`normal-1.log`）。

日期：2026-10-18。分支 `gixiphy/twitch-audio-lock`，規劃基準 HEAD `7eafecf`；本計畫的 docs commit 是這一輪的基準。fix-5 已失敗 1／3，本輪是第 2 輪。

## 根因（規劃時唯讀確認）

### 協調者實跑（`round2/normal-1.json`）

| 項目 | 觀察 |
| --- | --- |
| 校準 | YouTube（行動版 `.ytdVolumeControlsMuteIconButton`，trusted-button）muted false→true；Twitch（`button[data-a-target="player-mute-unmute-button"]`）muted true→false、volume 0→0.5。都 `ok:true` |
| a | PASS：`ytMutedSamples 0`、`storeATrueSamples 0`、`twAudibleSamples 0`、Twitch 有播；`twitchObserved=false`、`vIsRefErrors=0`（`__v_skip` 在真 iframe 生效） |
| b | FAIL：點 Twitch 靜音鈕後第一筆取樣 Twitch `muted:false, volume:0.5`，約 250ms 後變回 `muted:true`；store 一直 `a:false, b:true`。頂層收到的 `UPDATE_STATE`：`…587625 muted:false` → `…587885 muted:true`（260ms）；Twitch iframe 收到的 SetMuted 指令累計 `mute:2, unmute:1`（a 之後才建的新 iframe，Twitch 以 `muted:true` 建構，a 期間不需要靜音指令） |
| 中止 | c 第 1 輪的面板 `close()` 按 Escape 後立刻呼叫 `blank()`，丟出 `Error: no verified blank region`（`live.mjs:467` → `:255–259`），整輪 exit 2 |
| 主控台例外 | `TypeError … fetchVideoData`（`main.*.js`）、`TypeError: this.player.getCurrentTime is not a function`（`TwitchPlayer.*.js` ← `MultiView.*.js`）。兩者也出現在 review-6 的 `mvp.json`、`fallback.json`、`normal-2.json`（grep 各 3 筆字串），堆疊全在 holodex.net 的 assets，不在擴充 |

### 產品根因：iframe 意圖的去重

`src/pages/content/holodex/audio-lock/controller.ts @ 7eafecf`：

| 行 | 內容 |
| --- | --- |
| `:1204` | `let lastIframe: Element \| null = null;` |
| `:1205–1227` | `onBlur`：`schedule(..., 0)` 後讀 `doc.activeElement`；不是 IFRAME 就 return |
| `:1211` | `if (active === lastIframe) return;` ← **去重** |
| `:1212` | `lastIframe = active;` |
| `:1213–1225` | 找到包含此 iframe 的格，送 `IFRAME_INTENT`（`source: "iframe"`） |
| `:1229–1238` | `onFocusIn`：只有 `focusin` 之後 activeElement 不是 IFRAME 才 `lastIframe = null`，並清掉 iframe 來源的 intent |
| `:1263–1264` | 只註冊 window `blur` 與 `focusin`；沒有 window `focus` |

`state.ts:585–596` 的 `IFRAME_INTENT` 設定 `intent.expiresAt = now + TIMING.USER_INTENT_MS`（`contracts.ts:215`，2500）；`state.ts:690–695` 的 Twitch `muted:false` 邊緣要 `tokenValid`（`state.ts:161–166`：未消耗、未過期、同一格）才選中，否則走「不是使用者造成的取消靜音 → 靜音回去」。

在真瀏覽器：點跨網域 iframe 會讓頂層 window 失焦（觸發 window `blur`）；之後點頂層頁面**不可聚焦**的地方（例如 `.mv-background`），焦點回到頂層 document、activeElement 變回 `body`，但**不會**觸發 `focusin`（只會觸發 window `focus`），`lastIframe` 留著舊值。再點同一個 iframe 時 blur 觸發，`active === lastIframe`，意圖被丟掉。

協調者這一輪的流程正好如此：情境 a 重新加入 Twitch 後，harness 點 Twitch 播放鈕（新 iframe，記錄意圖，`lastIframe` = 這個 iframe），再點空白處（`.mv-background`，不可聚焦，沒有 focusin）；情境 b 點同一個 iframe 的靜音鈕 → blur 被去重 → 沒有意圖 → `muted:false` 邊緣被當成 Twitch 自己取消靜音 → 送靜音（指令計數與 260ms 後的 `UPDATE_STATE muted:true` 吻合）。Fi 的實際用法「先點 Twitch 播放，點別處，之後再點 Twitch 取消靜音」也會踩到。

既有單元測試沒有涵蓋：`tests/audio-lock/**` 沒有任何測試派送 window `blur`／`focus` 或改 `activeElement`；`twitch-broken.test.ts:117–121` 的 `triggerIframeIntent` 是對 iframe 派送 `pointerdown`（走 `controller.ts:1177` 的 `onPointerDown`），真瀏覽器裡點跨網域 iframe 不會把 pointerdown 送到頂層，所以那條路徑在 live 上不起作用。

**剩下一種沒修的情況**（列入「待 Fi 決定」1）：使用者點 Twitch 播放後焦點一直留在 iframe 內、沒有點別處，超過 2.5 秒才點 Twitch 靜音鈕 → 頂層根本沒有 blur，任何 blur 型偵測（含 MVP）都抓不到。本輪不處理。

### 修法比較

| 方案 | 內容 | 評估 |
| --- | --- | --- |
| **A（採用）** | 拿掉 `lastIframe` 與 `:1211–1212` 去重；每次 blur 且 activeElement 是某格 iframe 就送 `IFRAME_INTENT`（新的 2.5 秒窗）。`onFocusIn` 保留「焦點到非 iframe 元素就清掉 iframe intent」 | 和 MVP 一樣每次 blur 記錄時間；改動最小。頂層 window `blur` 只會在頂層失焦時觸發一次，焦點已在 iframe 時切換 app、在 iframe 內再點都不會重複觸發，去重本來就沒有保護到什麼。`visibilityState === "hidden"` 的排除保留 |
| B | 保留去重，加 window `focus` handler 把 `lastIframe` 清掉 | 也能修；但多一個 listener，去重仍沒有實際用途。而且若在 `focus` 時一併清 intent，harness 與使用者「點完靜音鈕 200ms 內點別處」時，intent 會在 Twitch `UPDATE_STATE`（輪詢最多 1000ms）到達前被清掉 → b 失敗。不採用 |
| C | 意圖窗改 10 秒（MVP） | 違反「`TIMING` 不改」，且不能解決去重。不採用 |

**不要**在 window `focus` 時清 intent（理由見 B）。

## Global Constraints

- 禁止 push、開 PR、merge（不合併任何分支、不碰 remote）、公證（notarize）、sudo；不建立或切換分支；不另開 worktree。
- 所有寫入限於本 worktree；commit 寫入主 repo 的 Git metadata 屬允許範圍。禁止刪除 worktree 以外的任何東西。Chrome 暫存 profile 一律放 `.cache/e2e-browser/`，結束時刪除（正常、FAIL、例外、逾時都刪）。**不碰 Fi 的 Vivaldi 或 Chrome profile。**
- 真直播瀏覽器測試**只在 M5** 跑，暫存 profile（Fi 已核准）。不在 M1 跑；不碰 Microlife／Chorus 專案、Orca 的安裝。
- 快取：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；yarn 一律 `npx --yes yarn@1.22.22`，需要安裝時用 `--frozen-lockfile`。
- **不新增 dependency**；`package.json`、`yarn.lock` 這一輪都不改。
- commit 訊息只用英文，Conventional Commits。
- 產品程式碼**只**允許改：
  - `src/pages/content/holodex/audio-lock/controller.ts`：只改 `onBlur`（`:1204–1227`）與因此不再使用的 `lastIframe` 相關行（含 `onFocusIn` 裡的 `lastIframe = null;`，`:1232`）。`onFocusIn` 清 intent 的邏輯、`onPointerDown`、listener 註冊不動。
  - `src/pages/content/holodex/audio-lock/twitch-embed.ts`：只改檔頭註解第 9 行。
  - 其他 src 一律不動（含 `state.ts`、`contracts.ts`／`TIMING`、`players.ts`、`holodex-adapter.ts`、`twitch-audio-lock.ts`、`holodex-inject.ts`、`custom-vite-plugins.ts`、`vite.config.*.ts`）。
- 測試只允許改：`tests/audio-lock/twitch-broken.test.ts`（新增測試）、`tests/audio-lock/fixtures.ts`（只新增 helper，不改既有 helper 行為）、`tests/e2e-browser/audio-lock/live.mjs`、`tests/e2e-browser/audio-lock/live-compare.mjs`、`tests/e2e-browser/README.md`（只改「Live players」一節）。`tests/build-artifacts/**`、`run.mjs`、`compare.mjs` 不動；`fakes.js` 保持和 `docs/plans/evidence/twitch-audio-lock-fix-3/harness/fakes.js` 逐位元相同。
- 既有測試名稱、斷言一律不改、不刪、不 skip／only。
- `docs/plans/evidence/**`、`docs/plans/reviews/**`、`.ref/` 唯讀。
- MVP 擴充 `/Applications/Extensions/holodex-plus-audiolock-chrome` 只能透過 CDP `Extensions.loadUnpacked` 唯讀載入；跑前跑後 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort` 比對完全相同（review-6 記錄為 28 檔）。資料夾不存在時照原計畫 Global Constraints 的替代路徑處理。
- 不要自己改成方案 D（帶 `muted=true` 重新載入 iframe）；`__v_skip` 或 postMessage 在真 iframe 無效時照實寫「新發現」。

## 回合與額度上限

- fix-5 系列已失敗 1／3，本輪是第 2 輪；驗收 FAIL 累計 3 次就停止，由協調者回報 Fi。
- **Cursor 本輪**：工作時間上限 **90 分鐘**；e2e 合計最多 **12 次**（假播放器 `run.mjs` 與真直播 `live.mjs` 都算，含 fallback、MVP、SKIP、例外中止）；`yarn build` 最多 4 次。必跑：假播放器 3、真直播 normal 3、fallback 1、MVP 1，共 8 次，剩 4 次給重試／harness 除錯。
- **Codex 本輪**：驗收上限 **60 分鐘**；e2e 合計最多 **8 次**（同樣 3＋3＋1＋1，不留重試；任一次未達門檻即 FAIL）。
- 每次真直播 e2e 內層 300 秒全域逾時；外層再包 `perl -e 'alarm 320; exec @ARGV' --`。
- 超過上限就停在目前狀態寫報告，不硬做。

## Review Focus

1. **同一個 iframe 第二次點擊**：先點過 Twitch（播放或校準），再點頁面不可聚焦的空白處（沒有 `focusin`），之後再點同一個 Twitch iframe 取消靜音，要切到 Twitch → 任務 1 的 `same_iframe_second_click_after_blank_click_switches_to_twitch`（healthy SDK）與 `same_iframe_second_click_broken_twitch_switches`（SDK 被 Vue 觀察）。
2. **意圖窗沒有被放寬**：每次 blur 記錄的是新的 2.5 秒窗，不是永久許可；blur 之後超過 2500ms 才發生的 Twitch 取消靜音仍要被壓回 → `repeated_blur_intent_still_expires_after_2500ms`。
3. **harness 不把 harness 自己的動作算成產品行為**：靜音鈕點擊延遲生效時，鍵盤 `m` 備援不能把狀態再切回去；指令與 `UPDATE_STATE` 要有時間戳，能分辨是誰靜音 → 任務 3 H4、H6。
4. **主機（Holodex）自己的例外不算擴充的副作用，但要照實列出**：情境 f 的判準只排除堆疊完全在 holodex.net assets、而且 MVP 同一輪也出現同一訊息的例外 → 任務 3 H3。

---

## 檔案

| 檔案 | 動作 | 用途 |
| --- | --- | --- |
| `src/pages/content/holodex/audio-lock/controller.ts` | 修改（`onBlur` `:1204–1227`、`onFocusIn` `:1232`） | 拿掉 `lastIframe` 去重，每次 blur 到某格 iframe 都送 `IFRAME_INTENT` |
| `src/pages/content/holodex/audio-lock/twitch-embed.ts` | 修改（第 9 行註解） | 改成尚未在真 iframe 驗證 |
| `tests/audio-lock/fixtures.ts` | 修改（只新增 helper） | `focusIframeAndBlurWindow(iframe)`、`returnFocusToPageWithoutFocusIn()` |
| `tests/audio-lock/twitch-broken.test.ts` | 修改（新增 3 個測試） | 同一 iframe 第二次點擊（healthy、broken）與意圖窗到期 |
| `tests/e2e-browser/audio-lock/live.mjs` | 修改 | 確認 `2735459` 的修正、補 H1–H8 |
| `tests/e2e-browser/audio-lock/live-compare.mjs` | 修改（如需要） | 顯示新增欄位（`scenarioErrors`、`hostExceptions`、`extensionExceptions`、`toggleLog`） |
| `tests/e2e-browser/README.md` | 修改（「Live players」一節） | 記錄空白點選取、面板關閉等待、例外分類、情境隔離 |
| `docs/plans/reports/twitch-audio-lock-impl-7.md` | 新增 | 實作報告 |
| `docs/plans/reports/e2e-fix5-fix1/*.json` | 新增 | 本輪所有 e2e 原始 JSON（含 FAIL／SKIP／例外） |

---

## 步驟

### 任務 0：開工檢查

- [ ] **Step 1**：`git log --oneline -1` 應是本計畫的 docs commit；`git status` 乾淨。
- [ ] **Step 2**：記下開始時間；建立額度表（e2e 0／12、build 0／4）。
- [ ] **Step 3**：MVP 資料夾 `find … -type f -exec shasum {} + | sort > .cache/e2e-browser/mvp-before.sha` 並記錄檔數。

### 任務 1：單元測試（先寫，修正前要 FAIL）

**Interfaces（新增於 `fixtures.ts`）：**

```ts
// 模擬真瀏覽器「點跨網域 iframe」：activeElement 變成 iframe，頂層 window 收到 blur。
export function focusIframeAndBlurWindow(iframe: HTMLIFrameElement): void;
// 模擬「點頁面不可聚焦的空白處」：activeElement 回到 body，只派送 window focus，不派送 focusin。
export function returnFocusToPageWithoutFocusIn(): void;
```

- [ ] **Step 1：helper**
  - `focusIframeAndBlurWindow`：讓 `document.activeElement === iframe`（優先 `iframe.focus()`；若 jsdom 不讓 iframe 取得焦點，改用 `vi.spyOn(document, "activeElement", "get")` 或同等方式，並在 helper 註解寫明），然後 `window.dispatchEvent(new Event("blur"))`。
  - `returnFocusToPageWithoutFocusIn`：讓 `document.activeElement === document.body`，然後 `window.dispatchEvent(new Event("focus"))`。**不能**派送 `focusin`。若用 `iframe.blur()`，要確認 jsdom 沒有在 body／window 上派送 `focusin`（測試裡掛一個 `focusin` 計數 listener，斷言計數為 0）。
- [ ] **Step 2：新增測試（放在 `twitch-broken.test.ts` 的 `describe("twitch broken SDK / no-degrade")` 內，沿用 `setupBrokenEnv`、`makeHandle`、`postTwitchUpdateState`、`pollSeconds`）**

  | 測試名稱 | 設定 | 斷言 | 修正前預期 |
  | --- | --- | --- | --- |
  | `same_iframe_second_click_after_blank_click_switches_to_twitch` | `setupBrokenEnv({ healthyTwitch: true, twitchBroken: false })`；YouTube a 有聲、Twitch b 靜音、`muteOthers:true`、active=a。(1) `focusIframeAndBlurWindow(b 的 iframe)`、`advanceTimersByTimeAsync(0)`（模擬點播放）；(2) `returnFocusToPageWithoutFocusIn()`；(3) `advanceTimersByTimeAsync(3000)`（第一次的意圖過期，settle 也過期）；(4) 再 `focusIframeAndBlurWindow(同一個 iframe)`、`advanceTimersByTimeAsync(0)`；(5) Twitch SDK `rawMuted=false`（healthy 路徑）並送 `postTwitchUpdateState(iframe,{muted:false})`；輪詢 2 秒 | `active.key === "b"`；store `a.muted === true`、`b.muted === false`；Twitch 沒有收到 `setMuted(true)`／`params===true` 的 postMessage；`focusin` 計數 0 | FAIL（active 仍是 a，Twitch 被靜音回去） |
  | `same_iframe_second_click_broken_twitch_switches` | 同上，但 `setupBrokenEnv()`（SDK 被 Vue 觀察，走 iframe `UPDATE_STATE`）；步驟 (5) 只送 `postTwitchUpdateState(iframe,{muted:false})` | 同上（Twitch 狀態看 `postSpies.get("b")` 沒有 `params===true`） | FAIL |
  | `repeated_blur_intent_still_expires_after_2500ms` | healthy Twitch；兩次 `focusIframeAndBlurWindow(同一 iframe)` 之間夾 `returnFocusToPageWithoutFocusIn()`；第二次 blur 後 `advanceTimersByTimeAsync(2600)` 才送 `muted:false` | active 仍是 a；Twitch 收到靜音（SDK `setMuted(true)` 或 postMessage `params===true` 至少 1 次）；store a 不變成 `true` | PASS（保護意圖窗；修正前後都 PASS，報告註明） |

- [ ] **Step 3：修正前跑**：`npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`。Expected：前兩個新測試 FAIL，失敗原因是 `active` 不是 b／Twitch 被送了靜音，**不是** import 或 helper 錯誤；第三個 PASS。把輸出摘要寫進報告。
- [ ] **Step 4**：不 commit，進任務 2。

### 任務 2：產品修正

- [ ] **Step 1：`controller.ts` `onBlur`**：刪除 `let lastIframe…`（`:1204`）、`if (active === lastIframe) return;`（`:1211`）、`lastIframe = active;`（`:1212`），以及 `onFocusIn` 裡的 `lastIframe = null;`（`:1232`）。`onBlur` 其餘邏輯（`schedule(..., 0)`、`enabled`、`visibilityState === "hidden"`、activeElement 必須是 IFRAME、逐格 `el.contains(active)`、`source: "iframe"`）不變。`onFocusIn` 清 iframe intent 的邏輯保留。不新增 window `focus` listener。
- [ ] **Step 2：`twitch-embed.ts:9`** 改成：
  ```ts
   * Not yet verified on a live player.twitch.tv iframe; live scenario g results are recorded in the fix-5 reports.
  ```
- [ ] **Step 3：跑測試**：`npx --yes yarn@1.22.22 test:audio-lock`。Expected：8 個檔、全部 passed、0 failed／skipped；總數＝修正前 HEAD 的實跑數＋3（review-6 記錄修正前為 164，所以預期 167；若 HEAD 實跑數不同，以實跑為準並在報告寫明）。
- [ ] **Step 4**：`npx --yes yarn@1.22.22 typecheck:audio-lock` exit 0。
- [ ] **Step 5：Commit**
  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts src/pages/content/holodex/audio-lock/twitch-embed.ts tests/audio-lock/fixtures.ts tests/audio-lock/twitch-broken.test.ts
  git commit -m "fix(audio-lock): record iframe intent on every window blur"
  ```

### 任務 3：live harness 確認與補強（`live.mjs`）

先確認 `2735459` 對 review-6 發現 1、3、4、5 的修正，再補本輪新發現。每一條在報告列「確認方法／結果／是否修改」。

- [ ] **Step 1：確認 `2735459`（讀程式碼，必要時用 `node --check` 與小型離線反例；不另跑 e2e）**

  | review-6 | 確認點（`live.mjs @7eafecf` 行號） | 預期 |
  | --- | --- | --- |
  | 發現 1（b 點擊沒有座標） | `toggleMute` `:342–363` 用 `controlPoint` 的實際座標；`clickAt` `:249–254` 檢查有限數字 | 協調者實跑 `clickPoints.twitchMute` 有 x/y，已生效 |
  | 發現 3（c 前提與判準） | `:471–481`：每輪先 `switchToTwitch`；`precondition` 要求 `before.twAudible && before.yt.muted`；`pass` 要求 2000ms 內 `ytAudible && tw.muted===true`，hold 5 秒每筆都成立；第 1、3 輪用 `.media-controls-list` 受信任點擊 | 已改；但 `pass` 有算 `precondition`（`b.pass && before.twAudible`），保留 |
  | 發現 4（a 取樣起點） | `:420–433`：校準後移除 Twitch、`blank()`、等 3 秒，sampler 在 `addTwitch()` 之前啟動 | 已改；補 H7 |
  | 發現 5（d 可接受兩邊未播） | `:483–492`：等新 document（`__hplusBeforeReviewReload` 消失）、兩邊 `waitPlaying`、每筆 `ytAudible` | 程式碼已改；**未經 e2e 驗證**，本輪第一次 normal 實跑時確認 d 有跑完並把結果寫進報告 |
  | 行動版 YouTube selector | `:317`、`:344`：`.ytmCuedOverlayPlayButton`、`.ytdVolumeControlsMuteIconButton` | 協調者實跑已用到並成功；fallback 模式仍未驗證 |

- [ ] **Step 2：補強（H1–H8）**
  - **H1 面板關閉後的空白點**（本輪中止原因）：`panelUnmuteYoutube().close`（`:467`）按 Escape 後，先等 `!document.querySelector('.v-dialog--active') && !document.querySelector('.v-overlay--active')`（最多 3 秒）；等不到就點 overlay 外側一次再等，並在 `clickPoints.panelClose` 記錄用了哪種方式。`blank()`（`:255–259`）改成最多重試 3 秒（每 250ms 找一次）再丟錯；錯誤訊息附上當時 `document.elementFromPoint` 的取樣摘要。刪掉不再使用的 `blankClick = { x: 20, y: 20 }`（`:242–243`），避免報告誤讀。
  - **H2 情境隔離**：把 b／c 每輪／d／f 各自包 try/catch。例外時該情境記 `{ pass:false, error }`，加到 `result.scenarioErrors`，然後繼續下一個情境；只有瀏覽器啟動、擴充載入、校準、情境 a 的前置（YouTube 播放、加入 Twitch）例外才整輪 exit 2。整輪 verdict 照原規則（任一必要情境不是 PASS 就 FAIL、exit 1）。
  - **H3 例外分類**：`Runtime.exceptionThrown`（`:146–150`）存到 `result.pageExceptions`（含時間戳、message、堆疊 URL 清單），harness 自己的錯誤存 `result.harnessErrors`，不要再混在 `result.errors`。分類：堆疊或 `url` 有 `chrome-extension://`、或訊息含 `AudioLock`／`Holodex+` → `extensionExceptions`；其餘且所有堆疊 URL 都是 `https://holodex.net/assets/` → `hostExceptions`。情境 f：刪除 Twitch 格後 5 秒內 `extensionExceptions` 沒有新增、`hostExceptions` 新增的訊息都在**允許清單**（目前只有 `this.player.getCurrentTime is not a function`、`fetchVideoData` 的 `Cannot read properties of null`，條件是本輪 MVP JSON 也出現相同訊息），而且 YouTube 仍有聲。未分類（兩者都不是）的新例外算 f FAIL。報告逐筆列出 host 例外與 MVP 是否也有。
  - **H4 靜音鈕與鍵盤備援不互相抵消**：`toggleMute`（`:342–363`）點擊後不要只等 100ms；改成每 100ms 讀一次、最多 1000ms，有變化就不送 `m`；1000ms 都沒變才送 `m`，送後再等最多 1000ms。回傳值加 `method`、`clickAt`、`changedAt`、`keyAt`。
  - **H5 b 的紀錄**：`switchToTwitch`（`:450–456`）把 `toggleMute` 的回傳值存到該輪的 `toggle`；b 的結果加上 `unmuteUpdateStateAt`（第一筆 `muted:false` 的 `UPDATE_STATE` 時間）與 `firstRemuteAt`（之後第一筆 `muted:true` 的時間，若有）。
  - **H6 指令時間戳**：Twitch iframe 的指令計數 listener（`:166`、`:174`）在計數外加 `log:[{t, params}]`（最多 200 筆），頂層 `__hplusUpdates` 已有時間戳；`refreshCounters` 一併讀回 `twitchCommandLog`。報告用它說明 b／c 裡每次靜音是誰送的（擴充的 SetMuted 指令 vs. harness 的 `m` 鍵）。
  - **H7 a 的取樣守門**：`:427–431` 在 `aSamples[0]` 不存在時（sampler 還沒拿到第一筆）先等第一筆再算 45 秒，不要讀 `undefined.t`。另外記 `aSamples[0].t` 早於 Twitch iframe 出現的時間（`twitchIframeAt`），報告寫兩者差值，證明取樣涵蓋加入與點播放。
  - **H8 fallback 與 MVP 完整跑完**：fallback 跑 a、b、c×3、e、g；normal 與 MVP 跑 a、b、(MVP 另跑 b′)、c×3、d、e、f。不論前一情境 PASS／FAIL，都往下跑（H2）。MVP 的 c 前提（b）大概不成立，照實記 `precondition:false`，不要為了 MVP 改判準。
- [ ] **Step 3：`live-compare.mjs`**：並列表加 `scenarioErrors` 數、`hostExceptions` 數、`extensionExceptions` 數；`c` 每輪顯示 `precondition` 與 `switchedInMs`。仍是「第一份 PASS 時 exit 0」。
- [ ] **Step 4：README「Live players」**：補 H1–H4、H8 的行為與 host 例外允許清單規則。
- [ ] **Step 5**：`node --check tests/e2e-browser/audio-lock/live.mjs`、`node --check tests/e2e-browser/audio-lock/live-compare.mjs` exit 0；能跑的話 `npx --yes yarn@1.22.22 eslint tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs`（跑不起來照實記錄）。
- [ ] **Step 6：Commit**
  ```bash
  git add tests/e2e-browser/audio-lock/live.mjs tests/e2e-browser/audio-lock/live-compare.mjs tests/e2e-browser/README.md
  git commit -m "test(e2e): isolate live scenarios and classify page exceptions"
  ```

### 任務 4：建置與 e2e（M5）

- [ ] **Step 1**：`npx --yes yarn@1.22.22 build`（Chrome＋Firefox）、`npx --yes yarn@1.22.22 test:artifacts`。Expected：exit 0；artifacts 10 passed。
- [ ] **Step 2：假播放器 ×3**：README 既有的 `for n in 1 2 3` 迴圈（`run.mjs` → `compare.mjs` 對照 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`），3 次 `compare.mjs` exit 0。
- [ ] **Step 3：真直播 normal 連續 3 次 PASS**：
  ```bash
  perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs live-fix-$n dist_chrome .cache/e2e-browser/live-fix-$n.json
  ```
  同一組 picks（預設 YouTube `1-LpQekNa9g`、Twitch `eslcs`）。SKIP 不算數也不中斷連續；FAIL 從頭算；每次都計入額度。第一次跑完先看 d 是否完整（Step 1 的發現 5 確認），若 harness 本身有缺陷，修 harness（另一個 `test(e2e): …` commit）後從頭算三次。
- [ ] **Step 4：真直播 fallback 1 次 PASS**：同上加 `--mode=fallback`，label `live-fix-fallback`。前提 `twitchObserved=true`、`vIsRefErrors>0`。和 Step 3 分開記錄、不能互抵。
- [ ] **Step 5：MVP 1 次對照**：label `live-mvp`，extension `/Applications/Extensions/holodex-plus-audiolock-chrome`，同一組 picks。要求跑完 a、b、b′、c×3、d、e、f（各自 PASS／FAIL 照實）；預期 c FAIL；記錄 `vIsRefErrors`、`centerClickSwitch`。跑完後 `find … | sort` 和 `mvp-before.sha` 比對完全相同。
- [ ] **Step 6**：`node tests/e2e-browser/audio-lock/live-compare.mjs .cache/e2e-browser/live-fix-1.json .cache/e2e-browser/live-fix-2.json .cache/e2e-browser/live-fix-3.json .cache/e2e-browser/live-fix-fallback.json .cache/e2e-browser/live-mvp.json`，輸出貼進報告。
- [ ] **Step 7**：所有 e2e JSON（含 FAIL／SKIP／例外那幾次與假播放器）複製到 `docs/plans/reports/e2e-fix5-fix1/`，報告列 SHA-256。`.cache/e2e-browser/` 沒有殘留 `live-prof-*`。

### 任務 5：報告

- [ ] **Step 1：寫 `docs/plans/reports/twitch-audio-lock-impl-7.md`**：根因確認（附本計畫的檔案:行號）、修正前 FAIL 摘要、修正後測試數、typecheck、build、artifacts、假播放器 ×3、每次真直播（mode、picks、秒數、exit、verdict、a／b／c1–c3／d／e／f／g）、b 的 `unmuteUpdateStateAt` 與是否有 `firstRemuteAt`、c 每輪 `switchedInMs`、`twitchCommandLog` 歸因、host 例外清單與 MVP 對照、`2735459` 確認表（任務 3 Step 1）、H1–H8 的修改、MVP SHA 比對、e2e／build 次數、工作時間、偏離、新發現。
- [ ] **Step 2：不要**在 `twitch-embed.ts` 寫回「已驗證」；若情境 g 真的 PASS，只在報告記錄。
- [ ] **Step 3：Commit**
  ```bash
  git add docs/plans/reports/twitch-audio-lock-impl-7.md docs/plans/reports/e2e-fix5-fix1
  git commit -m "docs: add twitch-audio-lock implementation report 7"
  ```

---

## 測試

| 層級 | 指令 | 通過標準 |
| --- | --- | --- |
| 單元（修正前） | `npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`（只套新測試、src 為基準） | `same_iframe_second_click_after_blank_click_switches_to_twitch`、`same_iframe_second_click_broken_twitch_switches` FAIL，原因是沒切到 Twitch／Twitch 被靜音回去；`repeated_blur_intent_still_expires_after_2500ms` PASS |
| 單元（修正後） | `npx --yes yarn@1.22.22 test:audio-lock` | 8 files，全部 passed（預期 167＝164＋3），0 failed／skipped；既有測試名稱全保留 |
| 型別 | `npx --yes yarn@1.22.22 typecheck:audio-lock` | exit 0 |
| 建置 | `npx --yes yarn@1.22.22 build`、`npx --yes yarn@1.22.22 test:artifacts` | exit 0；artifacts 10 passed |
| harness 語法 | `node --check` 兩支 live 腳本 | exit 0 |
| 假播放器 ×3 | README 迴圈 | 3 次 `compare.mjs` exit 0 |
| 真直播 normal ×3（M5） | `live.mjs` | 連續 3 次 `verdict:"PASS"` |
| 真直播 fallback ×1（M5） | `live.mjs --mode=fallback` | 1 次 `verdict:"PASS"`，情境 g 成立 |
| MVP 對照 ×1（M5） | `live.mjs` 載入 MVP | 跑完 a–f（不因 harness 例外中止），c 照實（預期 FAIL） |

## 驗收條件

Codex 驗收時，以下每一項都要**自己實跑**確認，不採信實作報告的數字。任何一項不符即 FAIL。

1. **範圍**：`git diff <本計畫 commit>..HEAD -- src` 只動 `controller.ts` 的 `onBlur`／`lastIframe` 相關行與 `twitch-embed.ts` 第 9 行註解；`onFocusIn` 清 intent 的邏輯、`TIMING` 沒變；沒有新增 window `focus` listener。`package.json`、`yarn.lock`、`custom-vite-plugins.ts`、`vite.config.*.ts`、`tests/build-artifacts/**`、`run.mjs`、`compare.mjs` 沒變；`fakes.js` 和證據逐位元相同；`docs/plans/evidence/**`、`docs/plans/reviews/**` 沒被改。
2. **檔頭**：`twitch-embed.ts` 不再宣稱已在真 iframe／scenario g 驗證。
3. **單元測試**：把本輪 src 改動 revert、只保留測試，任務 1 列為「修正前 FAIL」的 2 個測試都 FAIL，原因符合「測試」段；`repeated_blur_intent_still_expires_after_2500ms` 兩邊都 PASS。套回後全套全部 passed（預期 167，或報告寫明的實跑數＝基準＋3），既有測試名稱與斷言沒變，沒有 skip／only。
4. **typecheck、Chrome／Firefox build、artifacts** 都 exit 0；兩支 live 腳本 `node --check` exit 0。
5. **假播放器 e2e**：fix build 連續 3 次 `compare.mjs` exit 0（原計畫驗收 4 的每一條）。
6. **真直播 normal**：照原計畫驗收條件 5 的 a–f 與校準，fix build 連續 3 次 `verdict:"PASS"`。補充：b 的切換要有對應的 `UPDATE_STATE muted:false`，而且之後 3 秒內沒有擴充送出的 SetMuted `true`（以 `twitchCommandLog` 判斷）；f 的「不產生新的未捕捉例外」依任務 3 H3 判定：`extensionExceptions` 與未分類例外 0，host 例外只限允許清單且同輪 MVP 也出現。
7. **真直播 fallback**：照原計畫驗收條件 6，fix build 1 次 `verdict:"PASS"`，和第 6 項分開記錄、不能互抵。
8. **MVP 對照**：照原計畫驗收條件 7：同一組 picks 在 M5 跑一次 MVP，a–f 都有結果（沒有因 harness 例外整輪中止），`vIsRefErrors` 與 `centerClickSwitch` 有記錄，c 照實列出（預期 FAIL）；MVP 資料夾前後 SHA 清單相同。
9. **harness 確認**：報告有任務 3 Step 1 的確認表；H1–H8 都有實作或寫明為何不需要；情境例外會記在 `scenarioErrors` 而不是整輪中止。
10. **額度與邊界**：e2e、build 次數與工作時間都在「回合與額度上限」內；真直播只在 M5；`.cache/e2e-browser/` 沒有殘留 profile；沒有碰 Fi 的瀏覽器 profile、Microlife／Chorus、Orca 安裝；沒有 push、PR、merge、notarize、sudo；沒有寫入 worktree 以外的位置。
11. **報告**：`docs/plans/reports/twitch-audio-lock-impl-7.md` 與 `docs/plans/reports/e2e-fix5-fix1/*.json` 已提交，JSON 的 SHA-256 和報告一致。

Fi 在 M1 Vivaldi 的實測與 Firefox 真機載入，仍是交付後的人工項目，本輪不宣稱完成。

---

## 待 Fi 決定

| # | 問題 | 採用的假設 | 選錯的影響 |
| --- | --- | --- | --- |
| 1 | 使用者點 Twitch 播放後**焦點一直留在 iframe 內**（沒點別處），超過 2.5 秒才點 Twitch 靜音鈕：頂層不會有新的 blur，意圖偵測不到。要不要加「Twitch 取消靜音時，焦點正停在這一格 iframe 內，也算使用者意圖」？ | 本輪不加：協調者要求保留 2.5 秒意圖窗，而這個規則等於讓「焦點在 iframe 內」無限期有效，屬於行為擴充；MVP 同樣抓不到。 | Fi 若常「點 Twitch 播放 → 不點別處 → 過一陣子點 Twitch 取消靜音」，仍會被壓回。要支援，下一輪在 `OBSERVED_MUTED` 前檢查 `document.activeElement` 是否為該格 iframe，並補測試。 |
| 2 | 情境 f 的 Holodex 原生例外（`this.player.getCurrentTime is not a function`、`fetchVideoData` 的 null `length`）要不要算擴充的副作用？ | 不算，但只限堆疊全在 `holodex.net/assets/`、且同一輪 MVP 也出現的訊息（允許清單），報告逐筆列出。這比原計畫驗收 5f 的字面「不產生新的未捕捉例外」寬。 | 若 Fi 要求字面嚴格，f 在 fix 與 MVP 都可能因 Holodex 自己的例外 FAIL，需改成加一次「不載入擴充」的對照（e2e 多 1 次）來證明。 |
| 3 | 拿掉去重後，Holodex 或其他腳本若以程式呼叫 `iframe.focus()`，也會被當成意圖（2.5 秒）。 | 接受：修正前第一次程式聚焦同樣會被記錄，去重並沒有防到這件事；正常使用沒有看到這種呼叫。 | 若之後發現 Holodex 會自動聚焦 Twitch iframe，可能在 2.5 秒內把 Twitch 自己的取消靜音誤判成使用者操作，需要改成只接受有 `pointerdown`／可見輸入跡象的 blur。 |
| 4 | 本輪若 normal 三次仍因外部因素（直播下架、Twitch 廣告、Holodex 改版）無法連續 PASS，額度用完怎麼辦？ | 照額度停止、寫報告，由協調者回報；不換方案、不改 D。 | 會消耗 fix-5 第 2／3 輪。 |
