# Twitch audio lock 實作報告 6（fix-5）

日期：2026-10-18。分支 `gixiphy/twitch-audio-lock`。執行者 Cursor（本 worktree）。計畫 `docs/plans/twitch-audio-lock-fix-5.md`（Fi 核准，HEAD 起點 `ea9a65c`）。

## 總結

任務 1–5 的產品／測試程式與假播放器 e2e×3、typecheck、build、artifacts 已完成並通過。真直播 e2e（normal×3、fallback×1、MVP×1）在額度用盡前未能取得 PASS；依計畫「超過上限就停在目前狀態寫報告」停止，未改方案 D。

## Commit SHA（相對計畫 docs commit `ea9a65c`）

| SHA | 訊息 |
| --- | --- |
| `aeb5358` | `fix(audio-lock): construct Twitch players muted and outside Vue reactivity` |
| `c50afcf` | `fix(audio-lock): read Twitch state from the iframe when the SDK is unusable` |
| `6af1d32` | `fix(audio-lock): never degrade or fall back to native handling on Twitch failures` |
| `09b34f2` | `fix(audio-lock): keep Twitch first play from claiming bootstrap audio` |
| `8047fbf` | `test(e2e): add live Twitch and YouTube audio lock harness` |
| `a61bd15` | `fix(audio-lock): satisfy typecheck after lastMuteEpoch and Player ctor types` |
| `031e054`…`1e78d23` | live harness 修正（Input.enable、iframe session、校準、播放點擊等） |

本 docs commit 接在上述之後。

## 任務對照

### 任務 1：`twitch-embed.ts` 建構攔截

已完成。`installTwitchPlayerGuard`（Proxy construct、`muted` 預設、`__v_skip`）、`installTwitchStateListener`／`readTwitchIframeState`／`postTwitchSetMuted`、`readMuteOthersHint`、`twitch-audio-lock.ts` 在 top frame 安裝 guard＋listener。單元測試 11 passed。

### 任務 2：Twitch PlayerPort iframe 管道

已完成。`ReadMuted` 新增 `untrusted`；Vue 觀察或缺方法時讀 iframe 狀態、靜音走 postMessage；同步 SecurityError 回退 postMessage。`players.test.ts` 新測試＋既有 Twitch mismatch 預期改為 `untrusted`。

### 任務 3：不降級、盲靜音、反向切換

已完成。`failuresDegrade`、`MUTE_SENT.ok`、`UNTRUSTED_POLL`、`lastMuteEpoch`；controller／state 對 Twitch 不計入 degraded。`twitch-broken.test.ts` 11 項＋state 4 項。既有降級生命週期測試改 YouTube 觸發（見下表）。

### 任務 4：bootstrap Twitch 不搶選聲

已完成。`hasNonTwitchBinding`；有非 Twitch 格時吞掉 Twitch 首播／fallback。3 項測試通過。

### 任務 5：`live.mjs`／`live-compare.mjs`

已完成並提交。`package.json` 僅新增 `e2e:audio-lock:live`。eslint 因專案缺少 `@typescript-eslint/eslint-plugin` 無法跑（照計畫記錄）。

### 任務 6：建置／e2e／報告

單元／typecheck／build／artifacts／假播放器×3 完成。真直播未達驗收門檻（見額度）。

## 測試／建置數字

| 項目 | 結果 | 結束碼 |
| --- | --- | --- |
| `test:audio-lock` | **8 files、164 passed**、0 failed／skipped | 0 |
| `typecheck:audio-lock` | 通過 | 0 |
| `yarn build`（Chrome＋Firefox） | 通過（本輪 **1／6**） | 0 |
| `test:artifacts` | **10 pass** | 0 |
| 假播放器 e2e ×3 + `compare.mjs` | 3 次皆 PASS（對照 fix-3 mvp.json） | 0／0／0 |
| 真直播 normal ×3 | **未達成**（見下） | — |
| 真直播 fallback ×1 | **未跑**（額度用盡） | — |
| MVP 對照 ×1 | **未跑**（額度用盡） | — |
| `live-compare.mjs` | **未跑**（缺少合格 live JSON 組） | — |

## 真直播 e2e 嘗試（計入額度）

合計真直播相關 **7** 次 + 假播放器 **3** 次 = **10／10**（已達上限）。

| # | 標籤 | exit | verdict | 摘要 |
| --- | --- | --- | --- | --- |
| 1 | live-fix-1 | 2 | FAIL | `Input.enable` 不存在（已修） |
| 2 | live-fix-1 | 4 | SKIP | `no-live-youtube`（之後可播） |
| 3 | live-fix-1 | 4 | SKIP | `no-live-twitch`（`eslcs` readyState 0） |
| 4 | live-fix-1 | 1 | FAIL | `truth-method-invalid`（Mute Others 把校準 unmute 壓回） |
| 5 | live-fix-1 | 1 | FAIL | 校準仍失敗（頁面座標點不到 mute） |
| 6 | live-fix-1 | 1 | FAIL | 同上 |
| 7 | live-fix-1 | 2 | FAIL | YouTube 校準後 `timeout waiting twitch iframe` |
| 8–10 | （含重試／最終） | 2／1／2 | FAIL | 最後一次 YouTube 校準 ok（含 `video.muted` fallback），隨後 Twitch iframe 逾時 |

最後一次原始 JSON：`docs/plans/reports/e2e-fix5/live-fix-1-last.json`。

中間曾觀察到（校準前）兩邊 `<video>` 皆 `readyState:4`、`paused:false`；Twitch embed URL 含 `muted=true`（guard）。`twitchObserved`／`vIsRefErrors` 在完整情境 a 前未穩定寫入。

## 假播放器 e2e 產物 SHA-256

| 檔案 | SHA-256 |
| --- | --- |
| `docs/plans/reports/e2e-fix5/fake-fix-1.json` | `f17851c65e5201f5408f797642378cc972ad96a94936d7ab4c9cee033c188ea6` |
| `docs/plans/reports/e2e-fix5/fake-fix-2.json` | `ec31f342e2cd91506faf31ba228859e46ff2847600a1eb6170c6f402f19c1d4b` |
| `docs/plans/reports/e2e-fix5/fake-fix-3.json` | `47280ec8f453fcab0fb5d0653a008073355cba44dce5a965f66fca6eb833026c` |
| `docs/plans/reports/e2e-fix5/live-fix-1-last.json` | `9cd58c2bf57362432e1bdae4743af0e1438a2b0a86db76075d5245960d1c38b5` |

## 既有測試修改表

| 測試 | 改法 | 理由 |
| --- | --- | --- |
| `controller.test.ts` `degraded_is_not_reinstalled_by_discovery` | b→youtube + `hangRead` | Twitch 讀取逾時不再降級 |
| `degraded_route_reentry_recovers` | 同上 | 同上 |
| `route_watch_released_on_disable_and_dispose` | 同上 | 同上 |
| `route_watch_released_on_dispose` | 同上 | 同上 |
| `duplicate_enable_keeps_degraded_latch` | 同上 | 同上 |
| `mute_did_not_settle_degrades_after_three` | b→youtube + `ignoreMute` | Twitch 靜音未生效不再降級 |
| `ready_sdk_missing_methods_degrades` | a／b→youtube；`ytPlayer.getIframe` 以利 late-bind | Twitch 契約不符不再降級 |
| `state.test.ts` `mute_settle_and_unsettled_count` | 降級段 identity→youtube | 同上 |
| `players.test.ts` `ready_instance_missing_methods_reports_mismatch` | Twitch `readMuted`→`untrusted` | iframe 管道 |
| `controller.test.ts` `mute_writes_respect_cooldown_and_settle` | 上界改 `<=8` 且 `>=3` | Twitch 不降級後持續依冷卻重送 |

## 點擊位置（live harness 設計／實測）

- 頁面空白：`(20, 20)`（移開 iframe 焦點）
- YouTube／Twitch 播放：優先 iframe 內播放鈕區域座標，否則 iframe 中央
- Twitch 靜音鈕：`button[data-a-target="player-mute-unmute-button"]`（曾讀到 label「取消靜音 (m)」）
- 校準曾改在 iframe session 內 `el.click()`，UI 無效時 fallback `video.muted` 翻轉（偏離，見下）

## 額度

| 項目 | 使用 | 上限 |
| --- | --- | --- |
| e2e（假＋真，含 SKIP／FAIL） | **10** | 10 |
| `yarn build` | **1** | 6 |
| 工作時間 | 約於 90 分鐘內停止真直播重試並寫報告 | 90 分鐘 |

## 偏離

1. 真直播校準：頁面座標與 iframe 內 mute UI 多次無法改變 `<video>.muted`；最後一版在 UI 失敗時用 `video.muted` 翻轉證明可讀寫（`youtubeUsedVideoMutedFallback`）。與計畫「透過播放器自己的 UI」不完全一致。
2. 校準期間暫時 `setMuteOthers(false)`，避免 lock 立刻把 Twitch unmute 壓回（計畫未寫，但否則校準必敗）。
3. eslint 無法執行（缺 plugin）。
4. 真直播 normal×3／fallback／MVP／live-compare **未完成**（額度用盡）。
5. 未改方案 D（依計畫禁止自行改用）。

## 新發現

1. Holodex Twitch embed 在 guard 預設 `muted=true` 時 URL 會帶 `muted=true`；播放可達 `readyState>=2`，但 UI unmute 與擴充 remute 競態強烈。
2. 頂層 CDP `Input.dispatchMouseEvent` 點在 iframe 控制列上，實測常不改變 iframe 內 `<video>.muted`；需 iframe session 內操作或更可靠的座標。
3. YouTube 校準過程中開關 `muteOthers` 後，偶發 `setLayoutContentById` 加入 Twitch 後 60s 內看不到 `player.twitch.tv` iframe（逾時），根因未隔離。
4. 真 iframe 上 `__v_skip`／postMessage 備案 **尚未**在驗收級情境 g 證明（未跑完 normal／fallback）。

## MVP 對照

未跑（額度）。M5 上 `/Applications/Extensions/holodex-plus-audiolock-chrome` 存在且僅規劃唯讀載入。

## 驗收建議（給 Codex）

產品單元路徑可依計畫驗收（164、typecheck、build、artifacts、假 e2e×3）。真直播門檻（驗收 5–7）本輪**不應判 PASS**；需提高 e2e 額度或先修好 live harness 的 Twitch 掛載／校準穩定性後再開一輪。
