# twitch-audio-lock fix-5 計畫審查，第 1／1 輪

DISPATCH-2610180051512062

建議：先修訂下列 4 項，再依計畫實作。主修法有記錄來源，但備案目前會放棄必要行為，且驗收可以完全沒走過備案就通過。

審查範圍：僅 `docs/plans/twitch-audio-lock-fix-5.md`；背景使用指定 evidence，必要時唯讀追查現有 audio-lock 程式碼與測試。四份指定清單僅作提示。未讀或執行 SKILL.md、未跑 git diff、未執行測試、未開子 agent。以下是計畫審查，真 iframe 的執行結果均未驗證。

## Findings

### 1. [critical] 備案明確放棄 Twitch iframe 的主動選聲，違反保留 MVP 行為的要求

**Location**: `docs/plans/twitch-audio-lock-fix-5.md:344`；另見 `:168`、`:219`。

**Finding**: SDK 已被 Vue 觀察時，計畫一律把 Twitch 讀取視為不可信，卻沒有提供獨立的狀態來源。使用者從 Twitch 播放器自己的按鈕取消靜音，將不會切到 Twitch；計畫甚至接受兩台同時有聲直到下一次選聲。這不是保留 MVP 全部正確行為後修復反向切換。

**Evidence**: 計畫第 344 行直接承認這項結果。執行路徑是 `readMuted → unavailable/untrusted → UNTRUSTED_POLL`；第 216 行只允許發出 `MUTE_PLAYER`，沒有讀取真實靜音變化或辨識取消靜音的事件。現有 `state.ts:660` 的 iframe 選聲還需要可信的靜音觀察及 `true → false` 邊緣，因此單有 iframe intent 也無法補足。指定證據 `ROOTCAUSE-3.md:19` 至 `:23` 把「使用者取消 Twitch 靜音時切過去」列為須保留的 MVP 基準；本次審查要求也明確包含它。這個分支的實站發生頻率未驗證，但計畫所指定的行為缺口是明確的。

**Suggestion**: 在既有 `twitch-embed.ts` 集中實作不經壞掉 SDK getter 的狀態觀察，例如根據已記錄的 `UPDATE_STATE` 協定接收 iframe 訊息，驗證 source、origin、namespace 與欄位，再與使用者 intent 配對。補上「SDK 不可信，使用者在真 Twitch iframe 取消靜音 → 切到 Twitch → 再切回 YouTube」測試，不把這項必需行為列成下一輪選配。

### 2. [critical] 一次靜音嘗試失敗就鎖住整個 epoch，反向切換無法恢復

**Location**: `docs/plans/twitch-audio-lock-fix-5.md:214`、`:216`；另見 `:191`、`:218`。

**Finding**: `lastMuteEpoch` 在 `MUTE_SENT` 時無條件更新，同 epoch 的後續不可信輪詢全部跳過。計畫沒有把送出失敗排除，因此第一次備案靜音失敗後，即使 iframe 恢復可用，也不會再嘗試。

**Evidence**: 現有 `controller.ts:258` 至 `:265` 先取得 `ok = await port.mute()`，接著不論 ok 都送 `MUTE_SENT`，最後才處理 `!ok`。計畫第 218 行只停用 Twitch 的失敗計數，沒有改這個順序；第 214 行又在 `MUTE_SENT` 記錄當前 epoch。當 Twitch 原本有聲、使用者選 YouTube、原生 watcher 因 SecurityError 失敗，而第 143 行的 postMessage 因 iframe 暫時缺席或丟錯回 false，接下來所有 `UNTRUSTED_POLL` 都會被第 216 行擋掉。第 191 行要求 20 秒「剛好 1 次」的測試也沒有區分送出成功與失敗。另外，第 169 行把成功呼叫 postMessage 當成成功送出，並未證明播放器已套用；廣告／重載忽略指令正是第 84 行列出的情況。

**Suggestion**: 至少讓失敗的嘗試保持可重試，沿用冷卻時間並避免 degraded／原生接手；不要把失敗寫成已完成本 epoch。若用 iframe 狀態確認，讓重試持續到靜音已確認。新增「第一次 postMessage 失敗，下一次可送出」及「送出但未套用」的測試，確認反向切換仍在期限內完成。實站是否會遇到第一筆丟失未驗證；失敗後不會重試的路徑可由現有控制流程確認。

### 3. [warning] 保留 Twitch 契約失敗的全域降級，仍會恢復原生 Mute Others 路徑

**Location**: `docs/plans/twitch-audio-lock-fix-5.md:348`；另見 `:212`。

**Finding**: 計畫明確保留 READY 後缺少 `getMuted`／`setMuted` 時的 `cell-contract-changed` 全域 degraded，並承認可能重現 YouTube 被靜音。這是「無法讀取或靜音時絕不退回原生處理」的例外，未符合本次要求。

**Evidence**: 現有 `players.ts:74` 至 `:79` 在缺方法時回 null，`:199` 至 `:202` 報契約不符；`controller.ts:514` 至 `:517` 接著呼叫 `failSession`。`failSession` 在 `:146` 呼叫 `teardownSession`，後者在 `:940` 拆掉全部 wrapper，原生 `manualCheckMuted` 重新接手。第 212 行還要求既有 `ready_sdk_missing_methods_degrades` 維持此結果。這不是沒有呼叫者的假設：repo 已有專門覆蓋該分支的測試；真直播是否曾遇到缺方法則未驗證。

**Suggestion**: Twitch 契約不符時也保留防止原生接手的保護；能取得合法 iframe 時走不依賴 SDK 的管道，無法處理時隔離該格，避免拆掉其他格的攔截。相應修改 Twitch 測試，斷言原生檢查與非使用者授權的 Mute Others 都不被呼叫。其他 provider 的降級生命週期可繼續保留。

### 4. [warning] 真直播三次 PASS 可以完全沒有驗證反向切換的 postMessage 備案

**Location**: `docs/plans/twitch-audio-lock-fix-5.md:290`；另見 `:321`、`:322`。

**Finding**: 計畫把 B 當作已觀察實例的正式備案，卻允許報告僅寫「未在真 iframe 驗證」。正常三次 PASS 還要求 `twitchObserved=false`，因此不能證明壞掉 SDK 時備案的協定、靜音效果或使用者切換真的有效。

**Evidence**: 第 135 行只用 jsdom spy 驗證自己組出的訊息，第 162、164、192 行也只斷言送出訊息；它們沒有真正的 Twitch 接收端。第 48、143 行把協定效果標成未驗證，而第 290 行明確允許直到交付報告仍未驗證。第 321 行起的真直播驗收沒有刻意觸發備案的情境。即使主修法通過全部三次，備案仍可能完全無效而未被抓到。

**Suggestion**: 在本輪既有額度內加入必跑的真 iframe 備案情境，明確製造晚注入／已被 Vue 觀察的實例或可控的 SDK 靜音失敗，記錄實際走過的管道；用 iframe `<video>` 的獨立觀察確認 Twitch 靜音在 2000ms 內完成、YouTube 保持有聲、沒有原生接手或 degraded。不要只以 postMessage 呼叫成功或 SDK 回報判 PASS。把這項結果加入驗收門檻，並與正常 `__v_skip` 三次連續 PASS 分別記錄。

## 整理

- **Act on**：1、2、3、4。分別補足備案的使用者選聲、失敗恢復、禁止原生接手，以及真 iframe 證明。
- **Consider**：無另列發現；上述項目都直接影響本次必需行為或其驗收可信度。
- **Noted**：`__v_skip` 的來源與 Vue 行為依據在計畫第 23–27、47–55 行有記錄；真跨網域 iframe、獨立 `<video>` 觀察及校準、YouTube 先播 Twitch 晚到、三輪往返、reload、警告與刪格也已有驗收描述。這些描述尚非執行證據，本輪均未實跑。
- **Dismissed**：要求一律重建 iframe 或回到 MVP 重寫。沒有證據顯示必須採用這兩種替代方案；先修補上述具體缺口即可，不能只因實作偏好要求換架構。

holodex-twitch-audio-lock-fix5-REVIEW-DONE
