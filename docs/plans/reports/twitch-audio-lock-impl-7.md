# Twitch audio lock implementation report 7（fix-5-fix-1）

日期：2026-10-18（台北）。分支 `gixiphy/twitch-audio-lock`。計畫基準 docs commit `9b1cab9`。實作結束 HEAD 見下方 commits。

**總結：** 產品根因（同一個 iframe 第二次 blur 被 `lastIframe` 去重丟掉）已修，單元測試修正前 FAIL／修正後 167 passed，typecheck／build／artifacts／假播放器 ×3 皆過。真直播上情境 **a、b 在 fix build 上穩定 PASS**（`firstRemuteAt=null`，不再出現 260ms 壓回）。但 **情境 c（媒體面板）／d／f 與 fallback／MVP 整輪未能 PASS**；e2e 額度 12／12 用盡，無法湊滿 normal 連續 3 次 PASS。本輪驗收條件 6、7 未達成。

## Commits（本輪）

| Commit | Message |
| --- | --- |
| `00af737` | `fix(audio-lock): record iframe intent on every window blur` |
| `ef7e162` | `test(e2e): isolate live scenarios and classify page exceptions` |
| `722638a` | `test(e2e): harden live panel unmute and b unmute timestamps` |
| `9a993b1` | `test(e2e): click only the per-cell panel mute control` |
| `44967d4` | `test(e2e): always close media panel after unmute attempts` |
| （本報告） | `docs: add twitch-audio-lock implementation report 7` |

## 根因確認

計畫所述路徑（規劃時 `controller.ts` ≈1204–1232）：

- `let lastIframe` + `if (active === lastIframe) return` 讓「點 iframe → 點不可聚焦空白（無 `focusin`）→ 再點同一 iframe」第二次 blur 不送 `IFRAME_INTENT`。
- Twitch `muted:false` 邊緣需要有效 intent；沒有 intent 就被壓回靜音（協調者 `round2/normal-1`：約 260ms 後 `UPDATE_STATE muted:true`）。

**採用方案 A：** 刪除 `lastIframe` 與去重；每次 blur 且 `activeElement` 為某格 iframe 就送 `IFRAME_INTENT`。`onFocusIn` 清 iframe intent 保留。未加 window `focus` listener。`TIMING` 未改。

## 任務 0

- HEAD 開工為 `9b1cab9`；working tree 乾淨。
- 開始時間：2026-10-18 02:53:21 CST（`start_ts` 記錄於本機）。
- MVP `find … shasum`：**28 檔** → `.cache/e2e-browser/mvp-before.sha`。
- 機器：arm64（M5）。

## 任務 1：單元測試（修正前）

Helpers（`fixtures.ts`）：`focusIframeAndBlurWindow`、`returnFocusToPageWithoutFocusIn`（只 spy `activeElement` + `window` blur／focus，避免 jsdom `focus()` 觸發 `focusin`）。

| 測試 | 修正前 |
| --- | --- |
| `same_iframe_second_click_after_blank_click_switches_to_twitch` | **FAIL** `expected 'a' to be 'b'` |
| `same_iframe_second_click_broken_twitch_switches` | **FAIL** `expected 'a' to be 'b'` |
| `repeated_blur_intent_still_expires_after_2500ms` | **PASS** |

指令：`npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts` → 2 failed / 15 passed（既有 14 + 新 1 PASS）。

## 任務 2：產品修正

- `controller.ts`：移除 `lastIframe` 與相關三處。
- `twitch-embed.ts:9`：改為尚未在真 iframe 驗證之文案（計畫指定句）。
- 全套：`npx --yes yarn@1.22.22 test:audio-lock` → **8 files，167 passed**（164＋3），0 failed／skipped。
- `typecheck:audio-lock` exit 0。
- Commit `00af737`。

## 任務 3：`2735459` 確認與 H1–H8

### Step 1 確認表（讀碼；未另跑 e2e）

| review-6 | 確認方法 | 結果 | 是否修改 |
| --- | --- | --- | --- |
| 發現 1（b 點擊座標） | 讀 `toggleMute`／`clickAt`／`controlPoint` | 已用真實座標；本輪 live 的 `clickPoints.twitchMute` 有限數字 | 否（已在） |
| 發現 3（c 前提／判準） | 讀 c 迴圈 | 每輪 `switchToTwitch`；`precondition`／`switchedInMs`／hold 5s 在 | 之後 H1／H2 補強 |
| 發現 4（a 取樣起點） | 讀 a 段 | 校準後移除 Twitch、`blank`、等 3s，sampler 在 `addTwitch` 前 | 補 H7 |
| 發現 5（d） | 讀 d 段 | 等新 document、兩邊 `waitPlaying` | 本輪有跑完 d（結果 FAIL，見下） |
| 行動版 YT selector | 讀 selectors | `.ytmCuedOverlayPlayButton`／`.ytdVolumeControlsMuteIconButton` 在 | 否 |

### H1–H8

| 項 | 結果 |
| --- | --- |
| H1 面板關閉後空白點 | Escape 後等 dialog／overlay 清除（最多 3s，可外側點）；`blank()` 最多重試 3s；刪 `blankClick={20,20}` |
| H2 情境隔離 | b／c／d／e／f 包 try/catch → `scenarioErrors`；非整輪 exit 2 |
| H3 例外分類 | `pageExceptions`／`hostExceptions`／`extensionExceptions`／`harnessErrors`；f 用允許清單 |
| H4 toggleMute | 點擊後最多等 1000ms 才送 `m`；回傳 `method`／`clickAt`／`changedAt`／`keyAt` |
| H5 b 紀錄 | `toggle`、`unmuteUpdateStateAt`、`firstRemuteAt`（相對於 toggle 時間，避免吃到校準期間的 UPDATE_STATE） |
| H6 指令時間戳 | `__hplusCmdLog` → `twitchCommandLog` |
| H7 a 取樣守門 | 等 `aSamples[0]`；記 `sampleLeadMs` |
| H8 模式跑完 | fallback：a–c、e、g；normal／MVP：a–f（含 b′）；不因前一情境 FAIL 中止 |

`node --check` 兩支 live 腳本 exit 0。`eslint`：套件缺 `@typescript-eslint/eslint-plugin`，無法跑（與歷史相同）。

Commit `ef7e162` 及後續 harness 修正 commits。

## 任務 4：建置與 e2e

### 額度

| 種類 | 次數 | 上限 |
| --- | --- | --- |
| `yarn build` | 1 | 4 |
| e2e（假＋真） | **12** | 12 |
| 工作時間 | ~34 分鐘 | 90 |

e2e 明細：假播放器 4（含一次重跑前的 fix-1）＋ live normal 6（1 初跑＋4 streak 除錯＋1 額度末次）＋ fallback 1＋ MVP 1＝12。

### Build／artifacts

- `yarn build`（Chrome＋Firefox）exit 0。
- `yarn test:artifacts` → **10 passed**。

### 假播放器 ×3

指令：`run.mjs fix-$n` → `compare.mjs` 對照 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`。

| 次 | run | compare |
| --- | --- | --- |
| fix-1 | exit 0 | exit 0（判定 PASS） |
| fix-2 | exit 0 | exit 0 |
| fix-3 | exit 0 | exit 0 |

### 真直播 normal

同一組 picks：YouTube `1-LpQekNa9g`，Twitch `eslcs`。外層 `perl alarm 320`。

| 標籤／產物 | exit | verdict | a | b | c1–c3 | d | e | f | 備註 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 初跑（後被覆蓋；分析自當下 JSON） | 1 | FAIL | PASS | PASS | F／P／F | FAIL | PASS | FAIL | **b 無產品壓回**；c2（YT 播放器靜音）曾 PASS；c1／c3 面板未改 store；`firstRemuteAt` 誤指校準期（後已修 H5） |
| live-fix-fail-1..4 | 1 | FAIL | PASS | PASS | 面板 thrash／失敗 | FAIL | PASS | FAIL | 嘗試多按鈕時誤觸 delete 候選；b 皆 PASS 且 `remuteAt=null` |
| live-fix-1（額度末次） | 1 | FAIL | PASS | PASS | 找不到 panel row（標題不再含字面 `YT`） | FAIL | PASS | FAIL | `unmuteUpdateStateAt` 有、`firstRemuteAt=null` |

**連續 3 次 PASS：未達成**（額度用盡）。

b 歸因（fix build）：toggle `trusted-button`；hold 期間 Twitch 保持有聲、YouTube muted；`twitchCommandLog` 未見「unmute 後短時間內擴充 SetMuted true」的壓回模式（與修前 round2 相反）。

c：面板開啟後列查找／點擊未能穩定觸發 `setMuted(false)`（store `a` 常維持 `true`）。後期改為只點 per-cell 最後一顆 mute 鈕並強制關面板，但 row matcher 在實況標題下曾回 `mute button missing`。**未在額度內驗證最後一版 close-on-error 修正。**

d：reload 後取樣常見 store `a:true,b:true`、YouTube `<video muted>`，`ytAudible` 全假 → FAIL。f：常因 d 後 YouTube 已無聲 → `youtubeStillAudible:false`。

### 真直播 fallback ×1

`live-fix-fallback`：exit 1，`verdict:FAIL`。`twitchObserved=true`，`vIsRefErrors=942`（fallback 有觸發），但 a／b／c／e／g 皆 FAIL（a 的 `twAudibleSamples` 過高）。**未達驗收 7。**

### MVP ×1

`live-mvp`：exit 1。有跑完 a–f（未因 harness 例外整輪中止）。a PASS；b FAIL（預期：無本輪 blur 修正）；c FAIL（含 `precondition:false`）；d／f FAIL；e PASS。`bPrime.centerClickSwitch` 有記錄。`vIsRefErrors=1173`，`twitchObserved=true`。

MVP SHA：跑後與 `mvp-before.sha` **完全相同**（28 檔，`diff` 空）。

### live-compare（貼上）

```
label	mode	verdict	a	b	c1	c2	c3	d	e	f	g	vIsRef	observed	ytMuted	scenarioErr	hostEx	extEx
live-fix-1	normal	FAIL	PASS	PASS	FAIL	FAIL	FAIL	FAIL	PASS	FAIL	SKIP	0	false	0	2	3	0
live-fix-fallback	fallback	FAIL	FAIL	FAIL	FAIL	FAIL	FAIL	SKIP	FAIL	SKIP	FAIL	942	true	0	2	2	0
live-mvp	normal	FAIL	PASS	FAIL	FAIL	FAIL	FAIL	FAIL	PASS	FAIL	SKIP	1173	true	0	2	3	0
```

（完整輸出含每輪 `precondition`／`switchedInMs` 見 `.cache/e2e-browser/live-compare-out.txt`。）

### Host 例外與 MVP 對照

fix 與 MVP 同輪常見 host 訊息：

1. `Cannot read properties of null (reading 'length')`（`fetchVideoData`／`main.*.js`）
2. `this.player.getCurrentTime is not a function`（`TwitchPlayer.*.js`）
3. 有時另有 `Request failed with status code 400`（`vendor.*.js`）— **不在** H3 允許清單

`extensionExceptions` 在上述 live 結果中為 0。情境 f 的「允許清單且 MVP 同現」因 f 本身常因 YouTube 無聲 FAIL，未當成整輪 PASS 依據。

### Profile 清理

每次 `done()` 刪 `.cache/e2e-browser/live-prof-*`。結束時無殘留 profile。

## 任務 5：產物 SHA-256

目錄：`docs/plans/reports/e2e-fix5-fix1/`

```
f48b7a677092b310d53d397dd28329baf3a9b0abbbeb403041330a44ab981c47  fake-fix-1.json
12143e49056ba4d41af4f28f8e78a0b8ac12578715e47e00dbd881df0e06fb8f  fake-fix-2.json
6d71c38b34e0115544faf94dc8197ec80f6ab0ccd8e1c9ebe3f402397202691a  fake-fix-3.json
aa726eb1a64b74b3b48192c7d88fcdc737efc33db908ca54d8cbbc214496567f  live-fix-1.json
8bf4c365711909c4b3da74d7fb65358154941cc9901dec7f6bae2f1d09c81ea5  live-fix-fail-1.json
32b03d7837183f191b3e33357b5480c0ce6de428bb4b388d520a3e2cdf3e0ba9  live-fix-fail-2.json
c1a96810750348a51c88301f99bf34ac0308af80a2abc0ad50c70ebe884db9c9  live-fix-fail-3.json
9b21fdef1cef785be50096c8fcb40815b718e2b4a1d09902442f9149eab3ee45  live-fix-fail-4.json
ed31e2dfbe96c3175370eae68207fa575362ae3838d53ebcff152c15dfdf75a8  live-fix-fallback.json
3939e9e1c09d881272452f52c5431c5d31ce077f571db32b3e0f5421e8e5c5d0  live-mvp.json
```

## 偏離

1. 假播放器曾多跑 1 次 fix-1（shell `PIPESTATUS`／tee 誤判後重跑）；計入額度。
2. live harness 在額度內迭代多次（面板點擊、H5 時間戳、關面板）；最後一版 `always close media panel`（`44967d4`）**沒有**再用 live e2e 驗證。
3. 初跑 live JSON 被後續 `live-fix-1` 覆蓋；初跑行為以當下分析與 `live-fix-fail-*`／日誌佐證。
4. `eslint` 無法執行（缺 plugin）。
5. Fi「待決定」項採計畫預設假設（焦點留在 iframe 不加意圖；host 例外允許清單；接受程式 `iframe.focus` 誤判風險；額度用盡即停）。

## 新發現

1. **產品 blur 去重修法在真 iframe 上對情境 b 有效**（fix：`a`/`b` PASS，`firstRemuteAt=null`；MVP：`b` FAIL）。
2. 媒體控制面板列在實況中標題會變成真實影片名，字面 `YT` 不可靠；且 CDP 點 per-cell mute 時 store 常不變（`hasPanelDispatch`／點擊目標仍可疑）。這是本輪 c／後續 d／f 連鎖失敗的主因，**不是** blur 去重迴歸。
3. Host 例外除允許清單二者外，偶發 `Request failed with status code 400`（holodex assets）。
4. fallback 雖觸發 `twitchObserved`／大量 `vIsRefErrors`，a 的 Twitch 有聲取樣仍超標 → g 不成立。

## 驗收對照（實作方自評；Codex 需自跑）

| # | 結果 |
| --- | --- |
| 1 範圍 | PASS（src 僅 `controller` onBlur／lastIframe 與 `twitch-embed` 註解） |
| 2 檔頭 | PASS |
| 3 單元 | PASS（修正前 2 FAIL／1 PASS；修正後 167） |
| 4 typecheck／build／artifacts／node --check | PASS |
| 5 假播放器 ×3 | PASS |
| 6 真直播 normal ×3 | **FAIL**（無連續 3 PASS） |
| 7 真直播 fallback | **FAIL** |
| 8 MVP 對照跑完 a–f、SHA | 跑完與 SHA：**大致達標**；整輪 verdict FAIL（預期 c FAIL，另有 b／d／f FAIL） |
| 9 harness 確認表與 H1–H8 | PASS（有實作；末版 panel close 未再 live 驗證） |
| 10 額度／邊界 | PASS（12／12，未 push／PR／sudo／碰 Fi profile） |
| 11 報告與 JSON | 本文件與 `e2e-fix5-fix1/*.json` |

`twitch-embed.ts` **未**寫回「已驗證」。
