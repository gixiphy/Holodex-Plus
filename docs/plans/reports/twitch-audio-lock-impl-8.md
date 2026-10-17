# Twitch audio lock implementation report 8（fix-5-fix-2）

日期：2026-10-18（台北）。分支 `gixiphy/twitch-audio-lock`。開工 HEAD `d8acd6e`（本計畫 docs commit）。實作結束在本報告 commit 之前是 `f08807b`。

**總結：** iframe 換焦點會記 2500ms 意圖。診斷判定為 X1 後，Vue 觀察到的 Twitch 播放器在沒有 READY 時改走 iframe 管道。單元測試 8 files／173 passed。typecheck、Chrome／Firefox build、artifacts 10、假播放器 compare ×3 都是 exit 0。真直播 normal 連續 3 次 `verdict` 與 `effectiveVerdict` 都是 PASS。fallback 1 次 PASS，情境 g 成立。MVP 對照跑完，c 為 FAIL。e2e 9／12，build 2／4。工作時間約 34 分鐘。

## Commits（本輪）

| Commit | Message |
| --- | --- |
| `c16b71d` | `test(e2e): narrow host exception allowlist and add fallback probe` |
| `752ef8a` | `fix(audio-lock): record intent when focus moves between cell iframes` |
| `f08807b` | `fix(audio-lock): bind Vue-observed Twitch players without READY` |
| （本報告） | `docs: add twitch-audio-lock implementation report 8` |

## 任務 0

- `git log --oneline -1` 為 `d8acd6e docs: add twitch-audio-lock fix-5 round 3 plan`。`git status` 乾淨。
- 開始時間：2026-10-17T20:00:51Z（台北 2026-10-18 04:00:51）。結束寫報告時 2026-10-17T20:35:11Z。
- 額度起點：e2e 0／12，build 0／4。
- MVP `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort`：**28 檔**，寫入 `.cache/e2e-browser/mvp-before.sha`。跑完 MVP 後同一指令的清單與該檔 `cmp` 相同（`MVP_SHA_SAME`）。
- `npx --yes yarn@1.22.22 test:audio-lock`：8 files，**167 passed**，0 failed／skipped。

## 根因確認

計畫「根因」節對 `29aed7a` 的描述，和開工時的程式一致。

1. iframe 到 iframe 沒有頂層 `blur`。`onBlur` 是 `IFRAME_INTENT` 的唯一來源（實作前約 `controller.ts:1204–1224`）。焦點已經在 Twitch iframe 時，再點 YouTube iframe 不會產生新的 window `blur`。
2. fallback 的 `tryBind` 在沒有 READY 且 `lateBindReady` 不成立時直接 `return false`（實作前約 `players.ts:214`），`mute` 因此不送 postMessage。
3. c2 取樣在 `a924c11` 之後已經在輸入前啟動 collector。缺的是 `keyAt`。
4. H3 允許清單仍是兩個 substring，而且沒有對同輪 MVP 比對。

## 任務 1：c2 取樣核對

程式位置是開工時的 `live.mjs`（之後任務 2 有改計時起點）。

| 確認點 | 位置 | 結果 |
| --- | --- | --- |
| collector 在輸入前啟動，約每 50ms 取樣，直到輸入後滿 2000ms | 開工時 `:655–665` | 已涵蓋 |
| c2 計時起點是 `toggle.clickAt` | 開工時 `:663` | 已涵蓋。`keyAt !== null` 時未改起點，見下一列 |
| `switched` 只取 `[t, t+2000]` 內第一筆 `ytAudible && tw.muted===true` | 開工時 `:667` | 已涵蓋 |
| 1000ms 內沒變化才送 `m`，c2 是否記錄、起點是否改成 `keyAt` | 開工時 `:432–439`、`:663` | 未涵蓋。任務 2 補上：`keyAt != null` 時起點改 `keyAt`，並寫 `inputFallback: true`。否則 `inputFallback: false`。沒有第三次輸入 |

離線反例：`.cache/fix5-fix2/c2-sampling.mjs`（不提交）。虛擬時鐘，每次讀取 100ms，間隔 50ms，`originAt` 50，讓一筆取樣結束在起點後 2000ms。指令 `node .cache/fix5-fix2/c2-sampling.mjs`，exit 0。

- 真相在輸入後 1950ms 切換：`switchedInMs` **2000**，`pass` true，`sampleCount` 14。2000 落在 1950–2050。
- 真相在輸入後 2100ms 切換：`switchedInMs` **null**，`pass` false。同一組 offsets 最後一筆是 2000，看不到 2100 的切換。

## 診斷

### 既有 review-7 `fallback.json`（任務 3 Step 1）

指令：`python3 .cache/fix5-fix2/diag-review7.py`（腳本不提交）。這份資料分不出 X1／X3／X4。沒有 `code`，也沒有元件欄位。

- `updateStates` 209 筆。`muted` 變化：`null` → `false` → `true` → `false` → `null` → `false`（時間 1792265978776、1792265978896、1792265984034、1792265984272、1792265988557、1792265988594）。
- `twitchCommandLog` `[]`。`twitchCommandsReceived` `{mute:0, unmute:0}`。
- `focusEvents` 31 筆。開頭有 YouTube iframe blur，以及 `player.twitch.tv` channel `eslcs` 的 blur。
- AudioLock 警告一筆：`t=1792265974577`，`type` warning，文字 `[Holodex+ AudioLock] Object`。同一時間戳有 `[Holodex+] Activated`（log）。警告沒有比 Activated 更晚的第二筆 AudioLock。
- 情境 a 取樣 179。`twAudible` 173／179。抽樣的 store `b` 是 `null`（腳本印出的前 6 筆與末 3 筆都是 `null`）。

### 本輪診斷實跑（build 1，尚無 Y1）

指令：

```bash
perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs live-fix-diag dist_chrome .cache/e2e-browser/live-fix-diag.json --mode=fallback
```

- 開始 2026-10-17T20:16:40Z，結束 2026-10-17T20:18:29Z，約 109 秒。
- exit **1**。`verdict` **FAIL**。`failReason` `scenario-failed`。
- picks：YouTube `1-LpQekNa9g`，Twitch `eslcs`。`twitchObserved` true。`vIsRefErrors` 1209。`updateStateMessages` 210。`twitchCommandsReceived` `{mute:0, unmute:0}`。
- `twitchMountRetry` null。
- AudioLock `code`：只有 `twitch-guard-unavailable`。
- 情境：a false，b false，c 三輪 `switchedInMs` 都是 null（c2 `inputFallback` true），e true，g false。c2 視窗內 `focusEvents` type `blur` 有 1 筆。

`fallbackProbe` 五筆（a-end、b-end、c1／c2／c3-before-input）欄位相同，最後一筆原值：

| 欄位 | 值 |
| --- | --- |
| `twPlayerSet` | false |
| `twPlayerIsInstance` | false |
| `instHasOb` | true |
| `instHasSetMuted` | true |
| `instHasGetMuted` | true |
| `readyListeners` | 2 |
| `iframeOrigin` | `https://player.twitch.tv` |
| `iframeCount` | 1 |
| `wrapperInstalled` | true |
| `muteOthers` | true |
| `twitchCommandsReceived` | `{mute:0, unmute:0}` |
| `lastUpdateMuted` | false |
| `audioLockWarningCodes` | `["twitch-guard-unavailable"]` |

a-end 到 c2 的 `storeBMuted` 在 JSON 裡沒有這個鍵（頁面值是 `undefined`，結構化複製時被丟掉）。c3-before-input 的 `storeBMuted` 是 true。

### 判定：X1

符合計畫表：`twPlayerSet:false`、`instHasOb:true`、`instHasSetMuted:true`、`readyListeners` 2（≥ 1）、`wrapperInstalled:true`、`mute === 0`、沒有 degraded 類 code（只有 `twitch-guard-unavailable`）。不是 X3（wrapper 已裝上）。不是 X4（沒有其他 AudioLock code）。因此做任務 4。

## 修正前 FAIL

`npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts`，產品尚未改 `controller.ts`。

| 測試 | 結果 |
| --- | --- |
| `iframe_to_iframe_focus_reverse_switch_healthy_twitch` | **FAIL** `expected 'b' to be 'a'` |
| `iframe_to_iframe_focus_reverse_switch_broken_twitch` | **FAIL** `expected 'b' to be 'a'` |
| `focused_iframe_poll_does_not_refresh_same_cell_intent` | **PASS**（第一次跑因 store 沒對齊而 active 變成 undefined。對齊 store a `true`、b `false` 並先 `manualCheckMuted` 加 1600ms 後 PASS。這是測試設定，不是產品行為） |
| `focused_iframe_poll_ignored_when_hidden_or_preexisting` | **PASS** |
| `broken_twitch_without_ready_event_binds_via_iframe_channel` | **FAIL** `expected 0 to be greater than or equal to 1`（沒有 postMessage） |
| `twitch_placeholder_player_without_ready_is_not_bound` | **PASS**（修正前後都 PASS） |

X1 兩支測試在焦點 commit `752ef8a` 之前剪到 `.cache/fix5-fix2/x1-tests.ts.txt`，判定 X1 之後貼回，隨 `f08807b` 提交。

## 產品修正

`controller.ts`：`syncFocusedIframeIntent` 在 `reconcileCell` 讀播放器之前（約 `:570`）與 `setMuted` wrapper 送 `OBSERVED_MUTED` 之前（約 `:687`）。`lastFocusedFrame` 在 `onBlur` 找到格時更新，`onFocusIn` 離開 iframe 時清掉，`beginSession` 建立 session 後把當下 iframe 焦點當基準（約 `:1097`），`teardownSession` 兩支都清掉（約 `:976`、`:1006`）。沒有新 listener，沒有新 timer。`onBlur` 仍是每次 blur 都送意圖。

`players.ts` `tryBind`：READY 與 `lateBindReady` 都不成立時，`observedTwitchWithIframe`（約 `:212`）為真才設 `iframeChannel`、`boundInstance`，並 `fireOnReadyOnce`。`methods` 維持 null。placeholder `{}` 沒有 `setMuted`，不會綁上。

`grep -rn "focus()\|activeElement" tests/audio-lock/*.test.ts`：沒有符合。既有測試用 `focusIframeAndBlurWindow`。修正後全套仍通過，包含 `repeated_blur_intent_still_expires_after_2500ms`。

## 修正後測試、型別、建置

| 檢查 | 結果 |
| --- | --- |
| `test:audio-lock`（焦點 commit 前，不含 X1 兩支） | 8 files，**171 passed** |
| `typecheck:audio-lock` | exit 0 |
| `test:audio-lock`（Y1 與兩支 X1 測試貼回後） | 8 files，**173 passed**，0 failed／skipped |
| `node --check` `live.mjs`、`live-compare.mjs` | exit 0 |
| `node --test tests/e2e-browser/audio-lock/live-exceptions.test.mjs` | 6 pass，exit 0。含 `rejects_non_null_error_with_fetchVideoData_in_stack` |
| `yarn eslint tests/e2e-browser/audio-lock/*.mjs` | **沒跑成**。ESLint 8.57.1 找不到外掛 `@typescript-eslint/eslint-plugin`（`.eslintrc` 引用）。沒有安裝套件 |
| build 1／4（診斷前，已含焦點修正，尚未 Y1） | exit 0。Chrome 與 Firefox |
| build 2／4（Y1 之後，同時是任務 6 Step 1） | exit 0。Chrome 與 Firefox |
| `test:artifacts` | **10 passed**，exit 0 |

沒有第三次、第四次 build。

## 假播放器 ×3

build 2 之後，README 的迴圈。三次 `compare.mjs` 都是 exit 0。候選欄判定都是 PASS。對照證據 MVP 欄是 FAIL（`flags.v3/newHandle`、`preReloadYtStoreMuted`、`prePlayYtStoreMuted`），這是既有對照檔，不是本輪 fix JSON。三次合併牆鐘（含在同一次指令裡的 build 與 artifacts 之後）約 191 秒。沒有各次分開計時。

JSON：`docs/plans/reports/e2e-fix5-fix2/fix-1.json`、`fix-2.json`、`fix-3.json`。

## 真直播

機器是這次開工的 darwin arm64。暫存 profile 在 `.cache/e2e-browser/live-prof-*`，harness 結束時刪除。結束時該目錄沒有殘留 `live-prof-*`。picks 都是 YouTube `1-LpQekNa9g`、Twitch `eslcs`。`twitchMountRetry` 全部是 null（沒有空白掛載重載）。

e2e 計次：診斷 1、假播放器 3、normal 3、fallback 1、MVP 1，合計 **9／12**。沒有重試。

### 診斷

見上方。exit 1，FAIL。這次 build 還沒有 Y1。

### normal ×3

| 標籤 | 牆鐘 | exit | verdict | effectiveVerdict | a | b | c1 | c2 | c3 | d | e | f |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `live-fix-1` | 20:22:56Z 起，約 138 秒 | 0 | PASS | PASS | PASS | PASS | 74ms | 842ms | 87ms | PASS | PASS | PASS |
| `live-fix-2` | 20:25:14Z 起，約 134 秒 | 0 | PASS | PASS | PASS | PASS | 80ms | 523ms | 49ms | PASS | PASS | PASS |
| `live-fix-3` | 20:27:28Z 起，約 136 秒 | 0 | PASS | PASS | PASS | PASS | 84ms | 681ms | 44ms | PASS | PASS | PASS |

三輪 c 的 `inputFallback` 都是 false，`muteDelta` 都是 1。c2 點擊前 `activeElement` 是 `https://player.twitch.tv/?…channel=eslcs…`，點擊後是 `https://www.youtube.com/embed/1-LpQekNa9g?…`。`keyAt` null，`method` `trusted-button`。`[clickAt, clickAt+2500]` 內 `focusEvents` type `blur` 是 **0**。

b：三份 `pass` true，`unmuteUpdateStateAt` 有值，`firstRemuteAt` null。

f：`hostAllowedPendingMvp` 是空陣列（這 5 秒沒有新的 host 例外）。`live-compare` 的 `fHostMvpMatch` true。`effectiveVerdict` PASS。

情境 g：normal 沒有跑，compare 顯示 SKIP。

### fallback ×1（Y1 build）

`live-fix-fallback`。20:30:00Z 起，20:31:47Z 結束，約 107 秒。exit **0**。`verdict` PASS。`effectiveVerdict` PASS。

- `twitchObserved` true。`vIsRefErrors` 1250。`updateStateMessages` 219。結束時 `twitchCommandsReceived` `{mute:3, unmute:0}`。
- a PASS，b PASS（`unmuteUpdateStateAt` 有值，`firstRemuteAt` null），c1 663ms，c2 **1888ms** `inputFallback` false，c3 48ms，e PASS，g **PASS**。d／f 沒跑（SKIP）。
- c2 點擊前是 Twitch iframe，方法 `trusted-button`，視窗內 blur **0**。
- AudioLock code 只有 `twitch-guard-unavailable`。e `badWarns` 0。
- 最後一筆 `fallbackProbe`（`c3-before-input`）：`twPlayerSet` false，`instHasOb` true，`instHasSetMuted` true，`readyListeners` 1，`wrapperInstalled` true，當時 cmds `{mute:2, unmute:0}`。`cell.twPlayer` 仍是 false，因為 Y1 不寫 VideoCell 的 `twPlayer`，只讓 port 走 iframe。之後 c3 再送一次 mute，結束計數變成 3。

### MVP ×1

`live-mvp`。載入 `/Applications/Extensions/holodex-plus-audiolock-chrome`。20:31:47Z 起，20:34:06Z 結束，約 139 秒。exit **1**。`verdict` FAIL。`effectiveVerdict` FAIL。

- a PASS。b FAIL。c1／c2／c3 FAIL。c2 `switchedInMs` null，`inputFallback` true（`trusted-button-then-m`），視窗內 blur 0。d FAIL。e PASS。f FAIL。g SKIP。
- f 失敗原因：新的 unclassified 19 筆，第一行都是 `SecurityError: Failed to read a named property '__v_isRef' from 'Window': An attempt was made to break through the security policy of the user agent.` YouTube `youtubeStillAudible` false。`hostAllowedPendingMvp` 空陣列。
- `vIsRefErrors` **1468**。`twitchObserved` true。
- `centerClickSwitch`：`{"storeA":false,"twitchVideoMuted":true,"youtubeVideoMuted":false}`。JSON 沒有 `storeB` 鍵。
- `hostExceptions` 3 筆，見下一節。
- 資料夾 SHA 前後相同，28 檔。

`live-compare.mjs` 對五份 JSON 的 exit 是 **0**（第一份 `effectiveVerdict` 是 PASS）。並列表原文在本輪終端，欄位含 `effectiveVerdict` 與 `fHostMvpMatch`。

## Host 例外與 AudioLock code

三份 normal 與 MVP 的 `hostExceptions`：

| allowId | firstLine | 同輪 MVP |
| --- | --- | --- |
| `null-length-fetchVideoData` | `TypeError: Cannot read properties of null (reading 'length')` | 有 |
| `getCurrentTime-not-function` | `TypeError: this.player.getCurrentTime is not a function` | 有 |
| null | `Error: Request failed with status code 400` | 有。frames 都在 `https://holodex.net/assets/vendor.be3ecd61.js`，所以 kind 是 host，但不在允許清單。三份 PASS 的 f 視窗沒有把它算進新例外，所以 f 仍 PASS |

fallback PASS 那次只有 `null-length-fetchVideoData`。診斷那次有允許清單的兩筆，沒有 400。

AudioLock code：

- normal ×3：沒有 `[Holodex+ AudioLock]` 警告。
- 診斷與 fallback PASS：只有 `twitch-guard-unavailable`。
- MVP：大量 `code` 為 `null` 或字串 `"18"`。e 在 MVP 仍 PASS，因為 e 的 degraded 判斷只看那五個 code，`"18"` 與 null 不在其中。這些不是本輪產品的 degraded code。

## SHA-256

| 檔案 | SHA-256 |
| --- | --- |
| `fix-1.json` | `8c3a18514a0ba879f2f7c2d8951d9c89c122ef62fab25d403eea3caa68335da3` |
| `fix-2.json` | `abdb1df0681abc04823af2da7a05f5ec97df00a0bb2c542e59b94075870cab1e` |
| `fix-3.json` | `0ddad5b3ced22f5f90257c0281e6b7c47d2b56fdb2ee53dbad04d1da9eca2fc5` |
| `live-fix-diag.json` | `b3968e8ecc8b67dfc288380f226a563fd9a1ad492d05da048f02901f3a96b7b0` |
| `live-fix-1.json` | `3559665ee2b86818f074412fe7511ea9a42d9fc8885fb8a87f674d580997e703` |
| `live-fix-2.json` | `61e4c8abf18fe2674e5bbbe64ade808a14e7afe7c0dc936a5c483ef7b032eb32` |
| `live-fix-3.json` | `dad55983e57db0e5f8c93970cd06b7b8a65bf493b12a481dc230632307f2e3d3` |
| `live-fix-fallback.json` | `63cca9502c4427668bb0e7c91b9e2b79dcc41d10d8d436366754ccb2333816f2` |
| `live-mvp.json` | `0f1ab4b3c13a79bf98f075074b9e54b92256e3d3b14dbf0e4dbc364a836fae1e` |

## 偏離

- ESLint 無法執行，原因是本機沒有 `@typescript-eslint/eslint-plugin`。沒有改 `package.json`。
- c2 離線反例用虛擬時鐘，並把 `originAt` 設成 50，讓 100ms 讀取結束在 2000ms。沒有用會抖動的 `setTimeout` 相位。1950ms 案例的 `switchedInMs` 是 2000，2100ms 案例是 null。
- `focused_iframe_poll_does_not_refresh_same_cell_intent` 第一次因 store 與播放器不一致而 FAIL。補上與既有反向切換測試相同的 store／1600ms 設定後，修正前 PASS。
- build 1 是任務 3 診斷用。build 2 是 Y1 之後的重建，同時當作任務 6 Step 1，沒有再 build 第三次。
- 情境 g 只在報告記錄。`twitch-embed.ts` 檔頭沒有改。

## 新發現

- Holodex `vendor` 的 `Error: Request failed with status code 400` 會被分成 host，而且 `allowId` 是 null。它沒有出現在這三份 PASS 的 f 視窗裡。若它出現在 f 的 5 秒內，f 會 FAIL。
- Y1 之後 `fallbackProbe.twPlayerSet` 仍是 false。綁定發生在 port 的 `iframeChannel`，不是 VideoCell.`twPlayer`。驗收時不要把 `twPlayerSet:false` 讀成「還沒綁上」。PASS 那次結束的 mute 計數是 3。
- MVP 的 f 有 19 筆跨來源 `__v_isRef` SecurityError，分類是 unclassified，YouTube 在那 5 秒不是有聲。這是 MVP 對照結果，不是 fix build。
