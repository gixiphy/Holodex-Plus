# Twitch audio lock 實作報告 5（fix-4）

日期：2026-10-17。分支 `gixiphy/twitch-audio-lock`。實作者：Cursor。依據：`docs/plans/twitch-audio-lock-fix-4.md`。

## 逐條對照修正計畫

| 任務 | 計畫要求 | 結果 | Commit |
| --- | --- | --- | --- |
| 1 | `BINDING_REBOUND` 型別＋`transition` case；`state.test.ts` 新增 5 測 | 33 passed（原 28＋5） | `7b78c40` |
| 2 | `reboundActive`、同內容 remount 改送 `BINDING_REBOUND`、`syncBindings`／`processLayout` 呼叫；`rebind.test.ts` 6 測 | 全套 6 files／128 passed；typecheck exit 0 | `6d50791` |
| 3 | `run.mjs` 三段 `prePlay` 取樣＋4 checks；`compare.mjs` 三個新判定；README；lint | lint 兩條皆 0 errors／0 warnings | `373e1af` |
| 4 | build、artifacts、連續 3 次 e2e、MVP／none、報告與 JSON | 見下方數字 | 本報告 commit |

產品 `src` 只動白名單三檔：`contracts.ts`、`state.ts`、`controller.ts`。未改 `package.json`、`yarn.lock`、建置設定、`fakes.js`、`.ref/`、計畫／證據原文。

## 單元測試

### 修正前（只留新測試、src 還原到計畫基準 `a034127`）

指令：`vitest run --config vitest.audio-lock.config.ts tests/audio-lock/rebind.test.ts tests/audio-lock/state.test.ts`

摘要（完整輸出在 `.cache/e2e-browser/red-phase-summary.txt`，未提交）：

- 7 failed｜32 passed（39）
- `late_bind_keeps_snapshot_selected_youtube_audible`：`expected true to be false`（`a.muted`）
- `same_content_remount_keeps_active`：`expected true to be false`（`a.muted`）
- `late_bind_then_twitch_first_play_cannot_steal`：同上
- 任務 1 新測中 `rebound_remount_*`、`rebound_clears_*`、`rebound_late_bind_*`、`rebound_without_matching_*` FAIL（型別／行為未實作）
- `rebound_ignores_content_change`、`active_content_change_still_enters_silence`、其餘既有 PASS

### 修正後

| 指令 | 結束碼 | 數量 |
| --- | ---: | --- |
| `yarn test:audio-lock` | 0 | 6 files／**128 passed**／0 failed／0 skipped |
| `yarn typecheck:audio-lock` | 0 | 兩段 tsc 通過 |

既有 117 個測試名稱與數量不變（state 28→33、controller 48、adapter 13、players 14、settings 14，另加 rebind 6）。

## Lint

| 指令 | 結束碼 | 結果 |
| --- | ---: | --- |
| `node .cache/audio-lock-lint/run.cjs` | 0 | 0 errors／0 warnings（含 `rebind.test.ts`） |
| 同上，針對 `run.mjs`＋`compare.mjs` | 0 | 0 errors／0 warnings |

原生 `yarn eslint` 仍缺 `@typescript-eslint/eslint-plugin`（既有 blocker，未安裝 dependency）。

**範圍外（照實記錄，不算本輪缺陷）：** `fakes.js` 5 個 lint；`vite.config.base.ts` 2 個 unused import。

## 建置與產物

| 指令 | 結束碼 | 結果 |
| --- | ---: | --- |
| `yarn build`（chrome＋firefox） | 0 | 各 41 modules；holodex page script ≈37.65 kB |
| `yarn test:artifacts` | 0 | 2 suites／**10 pass**／0 fail |

本輪 `yarn build` 使用次數：**1**（上限 6）。

## 瀏覽器 harness（e2e）

環境：Chrome headless、profile 僅 `.cache/e2e-browser/`；結束後 `prof-*` 殘留 **0**。外層 `python3 .cache/run-with-timeout.py 280`。

| 標籤 | 秒數 | run 結束碼 | compare 結束碼（對 MVP 證據） |
| --- | ---: | ---: | ---: |
| fix-1 | 64 | 0 | 0 |
| fix-2 | 63 | 0 | 0 |
| fix-3 | 63 | 0 | 0 |
| mvp | 64 | 0 | （五欄並列） |
| none | 63 | 0 | （五欄並列） |

本輪 `run.mjs` 使用次數：**5**（3 fix＋mvp＋none；上限 10）。連續 3 次 fix 無中斷重算。

### 五欄並列表（現場）

| 檢查 | fix-1 | fix-2 | fix-3 | mvp | none |
| --- | --- | --- | --- | --- | --- |
| 頁面腳本有跑 | yes | yes | yes | yes | no |
| reload 前 YT 被設靜音取樣 | 0/12 | 0/12 | 0/12 | 0/12 | 0/12 |
| reload 後播放前 YT 被設靜音取樣 | 0/38 | 0/38 | 0/38 | 0/38 | 0/38 |
| 播放前初始 YT store | false | false | false | false | false |
| Twitch 晚播後 | YT | YT | YT | YT | TW |
| 自己取消靜音後 | YT | YT | YT | YT | TW |
| 延遲＋重複 6 次後 | YT | YT | YT | YT | TW |
| 延遲期間被搶次數 | 0 | 0 | 0 | 0 | 116 |
| YouTube 被靜音取樣／總取樣 | 0/168 | 0/168 | 0/168 | 0/168 | 156/168 |
| 使用者點 Twitch 後 | TW | TW | TW | TW | TW |
| AudioLock 警告數 | 0 | 0 | 0 | 0 | 0 |
| 判定 | PASS | PASS | PASS | FAIL (flags.v3/newHandle) | FAIL（搶聲＋flags） |

fix 三欄行為與 MVP 一致（YT／YT／YT／0／0/168／TW）。MVP 僅因缺 `flags.v3/newHandle` FAIL。none 顯示 Twitch 搶聲。

### 原始 JSON SHA-256（`docs/plans/reports/e2e-fix4/`）

| 檔案 | SHA-256 |
| --- | --- |
| `fix-1.json` | `a9658ebff72e8c87e9337b20bf67c22403821b4ad6644b85cf08d7bbcb2cdf70` |
| `fix-2.json` | `ccecd95b1278f6b63accb32024ac3ed31c09b4d1037e640d695675a6155e4736` |
| `fix-3.json` | `5d2daa7369858af3682eaa75ed7f18bc3761f310282cb9c2470c48c7ffe459c0` |
| `mvp.json` | `22c726271526659cb4dacfb746e1efb664477306ee01dcdb685691238a1d1e95` |
| `none.json` | `72ef273ae13a5fa4bd3c748bb2894bc1a6b4bdb7e114454d0329ce738c68f1be` |

## 偏離

1. **任務 1／2 的嚴格 TDD 紅燈步驟**：產品實作與測試在同一次編輯中完成，未先單獨提交失敗測試。事後以 `git checkout a034127 --` 還原三個產品檔重跑，確認計畫要求的 FAIL（含 `expected true to be false`）再還原，摘要如上。
2. **`syncBindings` 結尾在 `reboundActive()` 之後呼叫 `checkStoreSettle(adapter.buildSnapshot())`**：計畫 Interfaces 只寫呼叫 `reboundActive()`。不加這行時，late-bind 修正幽靈 active 並更新 `storeSettleEpoch` 後，500ms settle 計時器仍可能在尚未跑 `processLayout` 時觸發 `STORE_DID_NOT_SETTLE`，使 `late_bind_rebound_does_not_degrade` 失敗。此呼叫與 `processLayout` 內「rebound → checkStoreSettle」對稱，不改 bootstrap／silence／意圖窗。
3. **remount 分支**一併更新 `storeSettleTarget`／`storeSettleEpoch`（計畫只在 `reboundActive` 描述），避免同內容重建後 settle 目標停在舊 generation。

## 新發現

無第三條會在未播放時寫 `SET_STORE_MUTED` 到 YouTube 的路徑；方案 A 在本 harness 與單元探針下已足夠。`providerFromContent` 猜錯 Twitch provider 的問題仍在（本輪刻意不修），靠 late-bind 不比 provider 避開。

## 邊界

未 push、未開 PR、未 merge、未 notarize、未 sudo；未改 worktree 外檔案；未使用外掛／plugin skill。Firefox 真機載入與 Fi 的 M1 Vivaldi 實測仍屬交付後人工項，本輪不宣稱完成。
