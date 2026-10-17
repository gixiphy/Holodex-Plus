VERDICT: FAIL

# Twitch audio lock fix-5 implementation review 6

DISPATCH-2610180210380160。驗收者 Codex；基準 `ea9a65cfeb2206e0cb07c92079e1dd8767f74ae9`；受審 HEAD `7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`。機器 arm64 Apple M5。開始約 2026-10-18 02:11 Asia/Taipei。根目錄無 AGENTS.md／CLAUDE.md，採用派工規則。

本次先以 `f2860a4` 提交實跑測試／build／範圍檢查結果，再進入真直播。最終未達驗收條件 5、6、7；無已確認的新產品邏輯 high，但有下列 medium 驗收缺陷，因此 FAIL。

## 實跑結果

所有命令設定 `npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。yarn 固定 `npx --yes yarn@1.22.22`。

| 指令（均有外層 Perl alarm） | 結束碼 | 數量／結果 |
| --- | --- | --- |
| `perl -e 'alarm 180; exec @ARGV' -- npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts` | 1 | 14 tests: 11 failed / 3 passed（預期 red） |
| `perl -e 'alarm 180; exec @ARGV' -- npx --yes yarn@1.22.22 test:audio-lock` | 0 | 8 files / 164 passed / 0 skipped |
| `perl -e 'alarm 180; exec @ARGV' -- npx --yes yarn@1.22.22 typecheck:audio-lock` | 0 | 兩份 tsconfig 通過 |
| `perl -e 'alarm 240; exec @ARGV' -- npx --yes yarn@1.22.22 build` | 0 | Chrome＋Firefox；本輪 build 1 次 |
| `perl -e 'alarm 180; exec @ARGV' -- npx --yes yarn@1.22.22 test:artifacts` | 0 | 10 passed |
| `perl -e 'alarm 260; exec @ARGV' -- node tests/e2e-browser/audio-lock/run.mjs review6-fake-1 dist_chrome .cache/review6/fake-1.json` | 0 | PASS |
| `perl -e 'alarm 30; exec @ARGV' -- node tests/e2e-browser/audio-lock/compare.mjs .cache/review6/fake-1.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | PASS |
| `perl -e 'alarm 260; exec @ARGV' -- node tests/e2e-browser/audio-lock/run.mjs review6-fake-2 dist_chrome .cache/review6/fake-2.json` | 0 | PASS |
| `perl -e 'alarm 30; exec @ARGV' -- node tests/e2e-browser/audio-lock/compare.mjs .cache/review6/fake-2.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | PASS |
| `perl -e 'alarm 260; exec @ARGV' -- node tests/e2e-browser/audio-lock/run.mjs review6-fake-3 dist_chrome .cache/review6/fake-3.json` | 0 | PASS |
| `perl -e 'alarm 30; exec @ARGV' -- node tests/e2e-browser/audio-lock/compare.mjs .cache/review6/fake-3.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | PASS |

修正前驗證在 `.cache/review6/baseline/` 進行：拷貝本輪測試，將所有既有受改動 src 檔還原為基準版本；新增 `twitch-embed.ts` 僅留給 fixtures import，基準 controller／players 不引用它。指定九項回歸測試全因 degraded／原生呼叫／無 postMessage／未切換／bootstrap 錯誤而 FAIL，沒有 import error。正式 src 未被修改。

範圍檢查：七個 src 檔皆符合允許清單；holodex-adapter 只新增 readMuteOthersHint；TIMING 無變更；三個 protocol 值只在 twitch-embed.ts 定義（players.ts 另有 UPDATE_STATE 說明註解，沒有重複定義）。建置設定、tests/build-artifacts、yarn.lock、evidence、fakes.js 均無變更；fakes.js 與證據逐位元相同。package.json 僅新增 live script；128 個既有測試名稱全保留，新增 36 個，無 skip／only。

| 假播放器 | run / compare exit | ytMutedSamples | 使用者取消 Twitch 靜音後 | AudioLock warnings |
| --- | --- | --- | --- | --- |
| 1 | 0 / 0 | 0 / 168 | TW | 0 |
| 2 | 0 / 0 | 0 / 168 | TW | 0 |
| 3 | 0 / 0 | 0 / 168 | TW | 0 |

| 其他實跑指令 | 結束碼 | 數量／結果 |
| --- | --- | --- |
| `perl -e 'alarm 30; exec @ARGV' -- python3 .cache/review6/scope-verify.py` | 0 | 範圍、來源未改、MVP 28 檔未變、profile 0 |
| `perl -e 'alarm 30; exec @ARGV' -- node .cache/review6/harness-probes.mjs` | 0 | 3 個反例確認受審 harness 錯誤接受 |
| `perl -e 'alarm 30; exec @ARGV' -- node --check tests/e2e-browser/audio-lock/live.mjs` | 0 | 最終 harness 語法檢查 |
| `perl -e 'alarm 30; exec @ARGV' -- node tests/e2e-browser/audio-lock/live-compare.mjs <normal-1/2/3.json> <fallback.json> <mvp.json>` | 1 | 5 份 JSON 比較，首份未 PASS；詳見下表 |

## 真直播結果

全部為 M5 有畫面 Chrome 155.0.0.0、Vue 2.7.8；暫存 profile 建於 `.cache/e2e-browser/live-prof-*` 並於各回合刪除。所有回合 picks 均為 YouTube `1-LpQekNa9g`／Twitch `eslcs`，未換台。下表的「未測」表示沒有完成該情境，並非 PASS；提早停止時的 0 次錯誤也不能證明 guard 正常。

每次命令均設定前述三個 cache 環境變數，外層 `perl -e 'alarm 320; exec @ARGV' --`，內層 300 秒全域逾時。實際命令為 `node tests/e2e-browser/audio-lock/live.mjs <label> <extension> docs/plans/reviews/e2e-fix5-review/<file>`；fallback 另加 `--mode=fallback`。

| label / JSON | extension | exit | verdict | a | b | c1 / c2 / c3 | d | e | f | g | vIsRefErrors | twitchObserved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| review6-normal-1 / [normal-1.json](e2e-fix5-review/normal-1.json) | dist_chrome | 2 | FAIL | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 0 | 未取得 |
| review6-normal-2 / [normal-2.json](e2e-fix5-review/normal-2.json) | dist_chrome | 2 | FAIL | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 0 | 未取得 |
| review6-normal-3 / [normal-3.json](e2e-fix5-review/normal-3.json) | dist_chrome | 2 | FAIL | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 0 | 未取得 |
| review6-fallback / [fallback.json](e2e-fix5-review/fallback.json) | dist_chrome | 2 | FAIL | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 未測 | 34 | true |
| review6-mvp / [mvp.json](e2e-fix5-review/mvp.json) | 唯讀 MVP 路徑 | 2 | FAIL | PASS | FAIL | FAIL / FAIL / FAIL | 未測 | 未測 | 未測 | 未測 | 1151 | true |

- normal 1／2／3：Twitch iframe/session 消失或無法對應，尚未完成校準及 a–g。第 3 次的唯讀 CDP 診斷確認頂層已在 `https://holodex.net/`，與繼承的固定「空白」點擊 `(20,20)` 落在導覽區一致；不是產品音訊失敗的證據。
- fallback：真 Twitch 在播且 SDK 已被 Vue 觀察，34 次 `__v_isRef` 錯誤；YouTube 校準遇到 `missing mute control/video: youtube`，未進 a/g。JSON 的 UPDATE_STATE／command 0 是尚未刷新計數時的預設值，不能推論 iframe 沒送狀態。
- MVP：兩個播放器校準皆成功；a 的 YouTube 靜音／store true／Twitch 有聲取樣均為 0。b 為 FAIL；c 三輪原始判定均 FAIL，但前兩輪未滿足「Twitch 有聲、YouTube 靜音」前提，不能當作有效的反向切換測試；第 3 輪前提成立，Twitch 未於 2 秒內靜音，符合 MVP 已知問題。d 因 reload 時仍讀到舊文件、隨後 `$store` 不存在而中止；e/f 未完成。MVP 整輪不能宣稱跑完。

| 觀察 | fix normal | fix fallback | MVP |
| --- | --- | --- | --- |
| 正式門檻 | 0/3 PASS | 0/1 PASS | 有執行，未完整跑完 |
| 校準 | 未完成 | 未完成 | YouTube／Twitch 都成功 |
| UPDATE_STATE 計數 | 未取得 | 未刷新 | 199（最後成功刷新時） |
| postMessage mute / unmute 計數 | 未取得 | 未刷新 | 0 / 0（最後成功刷新時） |
| centerClickSwitch | 不適用 | 不適用 | storeA=false；storeB 未定義；Twitch video muted=true；YouTube video muted=false |

MVP 實際唯讀載入 `/Applications/Extensions/holodex-plus-audiolock-chrome`。測試前後 `find … -type f -exec shasum {} +` 的 28 檔清單以 `cmp` 比對完全相同。

校準只讀 iframe `<video>` 的 muted／volume／paused／readyState／currentTime，不用 SDK 回報當真相，不直接寫入 media state。MVP YouTube 透過受信任點擊進播放器後按 `m`，muted false→true；Twitch 受信任靜音鈕點擊使 muted true→false、volume 0→0.5；前後均 paused=false、readyState=4。最後實測的 YouTube 是行動版 UI（`.ytdVolumeControlsMuteIconButton`／`.ytmCuedOverlayPlayButton`），沒有舊 `.ytp-mute-button`；讀取其 DOM 控件的診斷只連本輪建立的暫存瀏覽器。

## 發現清單

以下全部定位受審 HEAD `7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`，不是驗收用 harness 修正 commit。無 high；medium 依實際阻礙與驗收風險排序。第 5 條依派工規則只列標題。

### 1. medium — b 將不含 x/y 的校準結果拿來點擊，無法完成真直播驗收

`tests/e2e-browser/audio-lock/live.mjs:655–659 @ 7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`

```js
  }
  const mutePt = result.clickPoints.twitchMute;
  if (mutePt) {
    await clickAt(mutePt.x, mutePt.y);
    await sleep(200);
    await clickAt(blankClick.x, blankClick.y);
  }
```

第 524–527 行把 `twToggle` 存入 `twitchMute`，但 twToggle 只有 `{ok,label}` 或 `{ok:false}`，沒有 x/y，而且兩種物件都 truthy。只要校準成功進到 b，就會對 CDP 傳 undefined 座標而例外；無法產出 normal／fallback／MVP 完整結果。應重新讀取控件位置並送受信任輸入。驗收 harness 已改成實際座標與播放器鍵盤途徑。

### 2. medium — 未完成情境 g，產品檔頭卻宣稱真 iframe 已驗證

`src/pages/content/holodex/audio-lock/twitch-embed.ts:9–9 @ 7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`

```ts
 *
 * Verified against fix-5 live scenario g on a real player.twitch.tv iframe.
 */
```

實作報告第 6 輪明確記錄 fallback 未跑、真直播沒有 PASS；本輪 g 也未完成，沒有證據支持這句話。這會把尚未證實的私有 Twitch protocol 備案誤標為驗收完成，直接違反真直播 g 為必要門檻的要求。應在取得有效 g PASS 前移除或改成未驗證；本輪依限制沒有改 src。

### 3. medium — c 未逐輪重建 b 前提，且可把暫停或雙聲視為靜音成功

`tests/e2e-browser/audio-lock/live.mjs:705–714 @ 7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`

```js
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const s = await sampleOnce();
      if (s.ytAudible && !s.twAudible) { switched = true; break; }
      await sleep(100);
    }
    const hold = await sampleFor(5000);
    const rebound = hold.some((s) => s.twAudible && !s.ytAudible);
    await refreshCounters();
    const muteDelta = result.twitchCommandsReceived.mute - muteBefore;
    const pass = switched && !rebound && (mode !== 'fallback' || muteDelta > 0);
    cRounds.push({
```

b 只做一次，c 的第 2／3 輪沒有先切回 Twitch，因此後續輪可未發生反向切換就接受既有狀態。`!twAudible` 同時接受「Twitch 暫停但未靜音」；hold 只排除「Twitch 有聲且 YouTube 無聲」，因此雙方同時有聲也不算 rebound。對原始 HEAD 表達式實跑三個小型反例，其中兩個確認 c 會接受上述錯誤狀態。此外第 696 行直接呼叫 cell.setMuted，不會經過媒體面板的受信任事件與 intent 分類；第 719 行時間又包含 5 秒 hold。此結果不足以證明計畫的三輪面板／iframe 切換門檻；驗收 harness 已補前提、真 UI 點擊、明確 muted 與連續 hold 斷言。

### 4. medium — a 的取樣漏掉 Twitch 加入與開播，可能漏報原始搶聲回歸

`tests/e2e-browser/audio-lock/live.mjs:593–594 @ 7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`

```js
  // Scenario a
  const aSamples = await sampleFor(45000);
  const aYtMuted = aSamples.filter((s) => s.ytMutedVideo).length;
  const aStoreATrue = aSamples.filter((s) => s.store.a === true).length;
```

Twitch 在第 443–450 行已點播放、等在播，接著第 513–541 行關閉 Mute Others 做校準，再開回來；直到此處才開始取樣。若 Twitch 開播時短暫把 YouTube／store 靜音，而校準後恢復，a 仍會 PASS，違反驗收 5a「含點 Twitch 播放鈕之後」的零取樣要求。第 435 行 scenarioAStarted 只控制逾時分類，沒有啟動取樣。驗收 harness 已改成校準後重新建立晚到 Twitch，從加入之前連續取樣。

### 5. medium — reload 判準可接受兩個播放器皆未播放（`tests/e2e-browser/audio-lock/live.mjs:735–744 @ 7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`）

## 邊界與審查結論

既有測試已覆蓋：Vue 觀察後 SDK 不可信、iframe 暫缺與 postMessage 首次失敗重試、送出後未靜音繼續重試、SDK 缺方法不退回原生、首次狀態未更新不採信 SDK false、Twitch 不降級、反向切換、Twitch bootstrap 不搶 YouTube、僅 Twitch 版面維持原行為。檢查過 provider 變更的既有測試，符合計畫／實作報告列出的降級生命週期與持續重試理由，沒有移除原有測試。

另以原始 HEAD 的判斷式實跑 3 個 harness 反例：d 接受兩個 paused=true/readyState=0 的播放器；c 接受 Twitch paused=true/muted=false；c 的 hold 接受 20 筆雙方皆有聲。三者都重現，驗收 harness 的相應判準已收緊。Standards 與 Spec 兩軸按 code-review skill 獨立唯讀審查：未確認新的 src 行為 bug，也未發現計畫外產品功能改動。依計畫刻意保留的 YouTube 全域降級、完全無 UPDATE_STATE 的盲靜音限制不列為新缺陷；對 synthetic message、未證實的 stale state／guard 重裝推測也不列發現。

## 驗收 harness 修正與限制

獨立英文 commit：`27354591a62356e33b7e8db208cb73254dd2507b`，`test(e2e): repair live audio-lock input and independent measurements`，只改 `tests/e2e-browser/audio-lock/live.mjs`。

- 移除 `video.muted`／volume 直接寫入，改用受信任播放器按鈕與 `Input.dispatchKeyEvent` 的 m；加入行動版 YouTube 控件支援。輸入座標先檢查有限數字；移開焦點的位置由 DOM 排除導覽、控件、iframe 後選取，不再使用固定 (20,20)。點擊位置記錄在各 JSON 的 clickPoints。
- 播放只點一次實際播放鈕，不再點按鈕後又無條件點中央；在播以 paused=false／readyState>=2 量測。Twitch 格高度改為 16，實測 iframe 高 423px，避免原 12 高度只有 299px。
- 增加同程序 iframe execution context 備援、detached session 清理、最小診斷／階段記錄；追加 `--site-per-process` 和本輪 profile 的臨時 debugging port，供唯讀檢查同一個自啟瀏覽器，沒有連使用者瀏覽器。
- UPDATE_STATE 計數於新文件建立時註冊，指令計數於 iframe 恢復執行前註冊；取樣開始於 Twitch 加入之前，每輪 c 先確認 b 前提；第 1／3 輪受信任點擊真正 `.media-controls-list`；切換時間在首次觀察成功時計算，hold 要求 YouTube 始終有聲、Twitch 始終 muted。
- reload 等待新 document marker 消失，避免舊 app 仍存在就過早開始取樣；d 也要求兩邊確實在播。這個 reload 修正與行動版 selector 補充發生在 MVP 回合後，**只做語法檢查，沒有剩餘 e2e 額度複驗**。

偏離／未完成：本輪為固定預設 picks 的量測修正，縮減了舊 harness 的替代挑台程式；未執行替代挑台。五次真直播使用逐步修正中的 harness，並非同一版本三連跑；最終 harness 只在 MVP 部分流程驗證過，不宣稱 normal／fallback 已可完整測量或產品通過。原始 JSON 保留各回合當時輸出，不回填未測情境。所有 live exit 都為 2；不是產品情境 FAIL 的 high 證據。未再啟動第 9 次測試，也未改方案 D、src 或計畫。

技術參考：[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)、[Twitch embed API](https://dev.twitch.tv/docs/embed/video-and-clips/)。這些文件只支援輸入與播放器操作方式，不替代真直播驗收證據。

## 額度與檔案邊界

| 項目 | 本輪 |
| --- | --- |
| e2e | 8/8＝假 3＋normal 3＋fallback 1＋MVP 1（含失敗） |
| build | 1 次，Chrome＋Firefox |
| 時間 | 約 02:11 至報告提交；低於 60 分鐘 |
| 暫存 profiles | 最終 0；本輪自啟 profile 全刪除 |
| MVP | 28 檔前後 SHA-1 清單完全相同 |
| 產品／計畫 | 未修改；`git diff 7cb4849 -- src` 為空 |
| 寫入／動作 | worktree 內 cache、報告、live JSON、live.mjs，以及允許的 Git metadata；無 push／PR／merge／notarize／sudo，未碰 Microlife、Chorus、Orca 安裝或使用者 profile |

## 真直播 JSON SHA-256

| 檔案 | SHA-256 |
| --- | --- |
| fallback.json | `a9fb431c72c613a0f504b2dfea724f0b5d7b20af6bc75ddb3f320f0c24b9e337` |
| mvp.json | `30dab3f573172dd07b140b1399fff07afc98b8e5365e976ef315363011cc4a81` |
| normal-1.json | `1513dba867b3c7880f95677fa7229512075ccf64bfe0a7a142ad0f63eed69b55` |
| normal-2.json | `2a09cb41db9e91f0299b79d72ae4d7dc1f4898a223916a13250df8edb8a7fd45` |
| normal-3.json | `4df3920eeee3a4b418abd66e0ba45b684f59474df68e1a5ea5e9a861db76a39e` |

## 給 Fi 的摘要

164 個單元測試、typecheck、兩種瀏覽器 build、10 個 artifacts 檢查與假播放器三連跑都通過，指定的修正前回歸測試也確實失敗。真直播 normal 三次與 fallback 一次都沒有完成合格驗收，MVP 只有部分情境取得有效量測，因此本輪判 FAIL。找到的主要問題在驗收 harness 的輸入、取樣與通過判準，尚無足夠證據把本輪中止歸因為新的產品 high；原始碼宣稱 scenario g 已驗證也不屬實。e2e 已達 8／8，已保留結果、提交 harness 修正並清除全部自建 profile，產品程式碼與計畫未修改。

VERDICT: FAIL
