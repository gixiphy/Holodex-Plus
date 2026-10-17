VERDICT: FAIL

# Twitch audio lock fix-5 implementation review 7

DISPATCH-2610180330049797。受審基準 `9b1cab9`，受審 HEAD `d680a7d9b59a25d54a685ccbe871368e9aed5a15`（`git rev-parse HEAD` 實取）。Codex 驗收；Apple M5／arm64；2026-10-18 03:30 Asia/Taipei 開始。根目錄無 AGENTS.md／CLAUDE.md，依派工 Code Review Rules。先以 `a21663e` 提交測試、build、範圍驗證，再做真直播。最終 1 high／2 medium；normal 未連續三次 PASS，fallback 亦未 PASS，驗收 FAIL。

## 實跑結果

全部 cache／暫存放本 worktree：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。yarn 固定 `npx --yes yarn@1.22.22`。下表每項外層均使用 `perl -e 'alarm N; exec @ARGV' --`。

| 指令（N 秒逾時） | 結束碼 | 數量／實測結果 |
| --- | --- | --- |
| `npx --yes yarn@1.22.22 --cwd .cache/review7/baseline test:audio-lock tests/audio-lock/twitch-broken.test.ts`（180） | 1 | 17 tests：2 failed／15 passed；兩個 same_iframe 測試均 `expected a to be b`；expiry PASS |
| `npx --yes yarn@1.22.22 test:audio-lock`（240） | 0 | 8 files／167 passed／0 skipped |
| `npx --yes yarn@1.22.22 typecheck:audio-lock`（240） | 0 | 兩份 tsconfig 通過 |
| `npx --yes yarn@1.22.22 build`（240） | 0 | Chrome、Firefox；build 1 次 |
| `npx --yes yarn@1.22.22 test:artifacts`（240） | 0 | 10 passed／0 skipped |
| `node --check tests/e2e-browser/audio-lock/live.mjs`（30） | 0 | 受審版本與驗收 harness 版本均通過 |
| `node --check tests/e2e-browser/audio-lock/live-compare.mjs`（30） | 0 | 通過 |
| `node tests/e2e-browser/audio-lock/run.mjs review7-fake-1 dist_chrome .cache/review7/fake-1.json`（260） | 0 | compare（30 秒）exit 0；YT muted 0/168、切換後 TW、warnings 0 |
| `node tests/e2e-browser/audio-lock/run.mjs review7-fake-2 dist_chrome .cache/review7/fake-2.json`（260） | 0 | compare（30 秒）exit 0；YT muted 0/168、切換後 TW、warnings 0 |
| `node tests/e2e-browser/audio-lock/run.mjs review7-fake-3 dist_chrome .cache/review7/fake-3.json`（260） | 0 | compare（30 秒）exit 0；YT muted 0/168、切換後 TW、warnings 0 |

每次 compare 的第二參數均為 `docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json`。假播放器 JSON 留在 `.cache/review7`，依本次限制不提交；只提交真直播 JSON。

red 驗證在 `.cache/review7/baseline` 隔離副本進行：複製目前 src／測試／設定，兩個本輪 src 檔以 `git show 9b1cab9:<path>` 還原；正式 src 完全未改。兩個失敗都到達 active 選聲斷言，沒有 import/helper error；第三個 expiry 測試 red／green 兩邊皆 PASS。

範圍實查：src 只有 controller 的四行移除、twitch-embed 的檔頭註解。onFocusIn 清意圖、TIMING、listener 註冊不變。package.json、yarn.lock、建置設定、tests/build-artifacts、run.mjs、compare.mjs、evidence、舊 reviews 均未動；fakes.js 與指定證據逐位元相同。既有測試／helper 沒有刪除或修改，新增測試無 skip/only。實作報告的 10 份 JSON SHA-256 全數吻合。

| 其他實跑指令（均有 30 秒 Perl alarm） | 結束碼 | 數量／結果 |
| --- | --- | --- |
| `python3 .cache/review7/scope-verify.py` | 0 | 範圍、既有測試、實作 JSON 雜湊、MVP 28 檔與 profile 清理通過 |
| `node .cache/review7/harness-probes.mjs` | 0 | 2 個反例：c2 零取樣誤判、H3 過寬允許清單 |
| `node tests/e2e-browser/audio-lock/live-compare.mjs <normal-1/2/3.json> <fallback.json> <mvp.json>` | 1 | 五份結果完整比較；沒有 PASS streak |
| `diff .cache/review7/mvp-before.sha .cache/review7/mvp-after.sha` | 0 | MVP 28 檔完全相同 |

## 真直播結果

全部在 Apple M5、有畫面 Chrome 155.0.0.0、Vue 2.7.8 上跑。YouTube `1-LpQekNa9g`／Twitch `eslcs`，五輪 picks 相同，未換台。Chrome profile 一律由 harness 在 `.cache/e2e-browser/live-prof-*` 建立，各輪結束刪除；最後 profile 數 0。Chrome 的 `--mute-audio` 阻止實際喇叭輸出；「有聲」依 iframe 自己的 `<video>`：`!paused && readyState >= 2 && !muted && volume > .01`，不靠 SDK 自述。

每輪指令為 `perl -e 'alarm 320; exec @ARGV' -- node tests/e2e-browser/audio-lock/live.mjs <label> <extension> docs/plans/reviews/e2e-fix5-review-2/<file>.json`；fallback 另加 `--mode=fallback`。normal／fallback 的 extension 是 `dist_chrome`，MVP 是 `/Applications/Extensions/holodex-plus-audiolock-chrome`，只經 `Extensions.loadUnpacked` 唯讀載入。內層另有 300 秒逾時。下列 exit 均為實際取得值。

| 情境／結果 | fix normal-1 | fix normal-2 | fix normal-3 | fix fallback | MVP |
| --- | --- | --- | --- | --- | --- |
| JSON | [normal-1](e2e-fix5-review-2/normal-1.json) | [normal-2](e2e-fix5-review-2/normal-2.json) | [normal-3](e2e-fix5-review-2/normal-3.json) | [fallback](e2e-fix5-review-2/fallback.json) | [MVP](e2e-fix5-review-2/mvp.json) |
| label | review7-normal-1 | review7-normal-2 | review7-normal-3 | review7-fallback | review7-mvp |
| exit／verdict | 4／SKIP | 1／FAIL | 4／SKIP | 1／FAIL | 1／FAIL |
| 校準 YT／TW | 未完成 | PASS／PASS | 未完成 | PASS／PASS | PASS／PASS |
| a 晚加入／開播 | 未測 | PASS | 未測 | FAIL：雙聲 | PASS |
| b Twitch 取消靜音 | 未測 | PASS | 未測 | FAIL | FAIL |
| c1 面板 | 未測 | PASS：80ms | 未測 | FAIL，前提不成立 | FAIL，前提不成立 |
| c2 YouTube iframe | 未測 | FAIL，前提成立 | 未測 | FAIL，前提成立 | FAIL，前提成立 |
| c3 面板 | 未測 | PASS：48ms | 未測 | FAIL，前提不成立 | FAIL，前提不成立 |
| d reload | 未測 | PASS，前提成立 | 未測 | 不適用 | FAIL，前提不成立 |
| e 警告／guard | 未測 | PASS | 未測 | harness 判 FAIL（見限制） | PASS（MVP 判準） |
| f 刪 Twitch | 未測 | PASS | 未測 | 不適用 | FAIL |
| g 備案管道 | 不適用 | 不適用 | 不適用 | FAIL | 不適用 |
| vIsRefErrors | 0（提早停止） | 0 | 0（提早停止） | 1201 | 1449 |
| twitchObserved | 未取得 | false | 未取得 | true | true |
| scenarioErrors | 0 | 0 | 0 | 0 | 0 |

normal-1／3 是 `no-live-twitch` SKIP，不是產品 PASS，也不算已驗證 guard。normal-3 獨立診斷為 Twitch iframe URL 正確、document `interactive`、body 空字串、video 數 0；YouTube 正常播放。不能從這兩輪認定 Twitch 播放問題的產品根因。normal-1 在開播前 6 秒以外不再重試播放按鈕；驗收 harness 隨後改成整個等待期重試，normal-2 成功，normal-3 仍空白。

有效三輪的校準均用各播放器自己的受信任靜音按鈕，`method=trusted-button`；校準前後均在播放，muted／volume 有改變。YouTube 使用行動版 `.ytdVolumeControlsMuteIconButton`，Twitch 使用 `button[data-a-target="player-mute-unmute-button"]`。開播以播放器播放鈕（找不到才 iframe 中央）受信任點擊；焦點移開時用 `elementFromPoint` 確認 `.mv-background`。c2 刻意保留 Twitch iframe 焦點後直接點 YouTube，符合 Fi 要求的反向操作；不在兩者間插入空白點擊。

| 原始量測 | normal-2 | fallback | MVP |
| --- | --- | --- | --- |
| a：YT video muted／store a true | 0／0（179 筆） | 0／0（179 筆） | 0／0（179 筆） |
| a：Twitch audible samples | 0 | 173（門檻 ≤8，實際雙聲） | 0 |
| a：取樣早於新 Twitch iframe | 333ms | 329ms | 332ms |
| 備案 UPDATE_STATE／SetMuted mute、unmute | 不適用 | 209／0、0 | 不適用 |
| MVP centerClickSwitch | 不適用 | 不適用 | store a=false；b 未設定；TW muted=true；YT muted=false |

normal-2 的 b 有對應 `UPDATE_STATE muted:false`；驗收途中 d 前快照中的指令時間為 unmute `1792265821960`、下一筆 mute `1792265827791`（相隔 5831ms），沒有 3 秒內壓回。最終 JSON 在 reload 後會覆寫同名的 `twitchCommandLog`／`updateStates`，這段跨階段原始 log 未保留在最終 JSON，列為追溯限制；b 的 toggle、UPDATE_STATE 時間、samples／hold 仍保留。c1、c3 的 hold 5 秒全部維持 YouTube 有聲、Twitch 靜音。normal-2 的 d 前先獨立確認 `a:false,b:true`、兩邊都在播；reload 後 20 秒取樣全部保持 YouTube 有聲，沒有 store a=true。f 新增 extension／host／未分類例外均 0。

**協調者三項觀察的判定：**

- **c2：已確認產品 high。** `normal-2.scenarios.c[1]` 記錄受信任按鈕輸入，`keyAt:null`；焦點從 Twitch 轉到 YouTube，前後沒有新的頂層 blur。輸入後 53ms 取樣 YouTube 有聲，472ms 已再靜音；Twitch 全程有聲、store `a:true,b:false`、`muteDelta:0`，5 秒 hold 也沒切換。這排除了「鍵盤 m 又切回」與「取樣太晚」兩種 harness 假象。
- **c1／c3：不能統一歸因成找不到列。** 受審最終 JSON 的確在點擊前就報 row missing；較早 fail-1～4 JSON 卻已有 YT 列與按鈕座標，因此「全部都找不到列」不成立。本次等待真正的 Vuetify 2 `.v-list-item__title` 渲染、等動畫穩定、確認命中同一個 button 後，normal-2 兩輪都成功清 store a 並切聲。fallback 的初始 18px 按鈕與穩定後座標也另存 `panelGeometryLog`；這只證明幾何會動，不足以斷言舊每次點擊都落錯。未重現 normal 面板產品缺陷。
- **d：先前失敗不足以證明獨立 reload bug。** 原 harness 在 c3 失敗、仍由 Twitch 出聲且 store a=true 時直接 reload，接著要求 YouTube 自動成為選中者；f 又繼承 d 的狀態。normal-2 在明確正確前提下 d／f 都 PASS；MVP 的 d 前提本身不成立，故其 d FAIL 也不能當產品根因證據。本次沒有另報 reload 產品 bug。

fallback 的 a／g 仍是未達交付門檻的實測：播放器真相可讀、UPDATE_STATE 持續到達，但 Twitch 沒有被靜音，三輪 c 都失敗。無法用此一輪判定全部失敗都來自同一個焦點根因；c1／3 前提不成立，c2 有新的頂層 blur，並非 normal-2 的 iframe→iframe 路徑。沒有足夠 runtime 內部狀態來定位為 ready/binding 或其他原因，不捏造第二個產品根因。

**例外與警告限制：** normal-2 的 host 訊息各 1 筆：`Cannot read properties of null (reading 'length')`（fetchVideoData）、`this.player.getCurrentTime is not a function`、`Request failed with status code 400`；三者都在本輪 MVP 出現同樣訊息。400 不在允許清單，但出現於 f 之前；normal-2 的 f 沒有新增任何例外，因此不靠豁免通過。fallback 只有前兩種 host 訊息；MVP 的 f 有 19 筆未分類跨域 SecurityError，故 FAIL。各輪 extensionExceptions 都是 0。fallback 的唯一 AudioLock warning 被既有 console 收集器記成 `[Holodex+ AudioLock] Object`，遺失 code，e 無法區分允許的 guard warning 與其他警告；保留原始 FAIL，不宣稱已證明 degraded，也不宣稱 e PASS。

## 發現清單

以下位置與 SHA 均指受審 HEAD，不指驗收 harness commits。依嚴重度排列；兩個 medium 都是可實跑重現的量測邏輯問題。

### 1. high — 只靠 window blur，直接從 Twitch iframe 切到 YouTube 仍會把 YouTube 壓回靜音

`src/pages/content/holodex/audio-lock/controller.ts:1204–1210 @ d680a7d9b59a25d54a685ccbe871368e9aed5a15`

上下文（1202–1212）：

```ts
  };

  const onBlur = () => {
    schedule(() => {
      if (!enabled) return;
      if (doc.visibilityState === "hidden") return;
      const active = doc.activeElement;
      if (!active || active.tagName !== "IFRAME") return;
      for (const [, binding] of lastBindings) {
        const el = (binding.cell as { $el?: Element }).$el;
        if (el && el.contains(active)) {
```

移除同一 iframe 去重，只能讓「頂層再次失焦」刷新意圖；焦點已在 Twitch iframe 時直接點 YouTube，頂層沒有第二次 blur，所以沒有新的 YouTube `IFRAME_INTENT`。normal-2 實證詳見上文：真播放器在 53ms 出聲、472ms 被壓回，Twitch 仍出聲，不符合 2 秒反向切換。這是本次明確指定實證的交付缺口。

可行修法：在控制器生命週期內定時檢查 `document.activeElement`（或在既有輪詢讀播放器前檢查），當它**切換到另一個已綁定格的 iframe** 時建立對應意圖；維持既有 2500ms 到期、同一格不持續刷新、hidden／disabled 與 teardown 清理。避免因頂層沒有 blur 丟掉跨格意圖。補上沒有頂層 blur 的 Twitch→YouTube 受信任操作測試，healthy／postMessage 兩條路徑都要確認；現有單元 helper 人工 dispatch blur，不能涵蓋此事件序列。HTML 規範也提供從外層 document 讀取 focused iframe 的 activeElement 行為（[HTML Standard](https://html.spec.whatwg.org/multipage/interaction.html#dom-documentorshadowroot-activeelement-dev)）；本結論以本輪 Chrome 焦點與 video trace 為證。

### 2. medium — 新增兩段 1000ms 等待後，c2 可在正確切聲時完全沒有取樣

`tests/e2e-browser/audio-lock/live.mjs:424–430 @ d680a7d9b59a25d54a685ccbe871368e9aed5a15`

上下文（423–432）：

```js
    };
    if (!(await waitChange(1000))) {
      const sid = typeof point.sid === 'object' ? point.sid.sessionId : point.sid;
      keyAt = Date.now();
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', text: 'm', windowsVirtualKeyCode: 77 }, sid);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }, sid);
      method = 'trusted-button-then-m';
      await waitChange(1000);
    }
    if(after?.paused){await clickPlay(which);await waitPlaying(which,5000);after=await readVideo(which);}
```

呼叫端 c2 在 `:643` 起計時，`:644` await 整個 toggle（還有 blank／必要時播放），`:646` 才以同一個 2000ms deadline 開始取樣。離線反例直接抽出受審的 toggle 函式執行：真相在 1950ms 正確切換，100ms 輪詢直到 2000ms 才返回，原 c 迴圈執行 0 次、誤判 FAIL。應在受信任輸入期間同步取樣，從回傳的 `clickAt` 計 2 秒。驗收 harness 已修正此量測；normal-2 仍真的失敗，因此發現 1 不依賴此誤判。

### 3. medium — H3 允許清單把 fetchVideoData 內任何錯誤都豁免

`tests/e2e-browser/audio-lock/live.mjs:70–73 @ d680a7d9b59a25d54a685ccbe871368e9aed5a15`

上下文（68–74）：

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST_EXCEPTION_ALLOWLIST = [
  'this.player.getCurrentTime is not a function',
  'fetchVideoData',
];
const result = {
```

`:678` 對整段含 stack 的 message 做 substring 比對，因此 `Error: unexpected non-null regression` 只要 stack 含 `fetchVideoData` 就被視為允許；離線反例實跑接受了這個非 null 錯誤。修正計畫 H3 僅允許該函式的 `Cannot read properties of null`，不是所有錯誤。應同時確認 null-property 訊息與 fetchVideoData 歸屬，再核對同輪 MVP 同訊息。此缺陷可讓刪格造成的新 host 例外漏報；本次 normal-2 f 沒有新增 host 例外，故不影響其實測 PASS。

## 驗收覆核與邊界

| 驗收項 | 結果 |
| --- | --- |
| 範圍、檔頭、既有測試不改 | PASS；沒有新增其他產品功能，檔頭不再誇大 live 驗證 |
| red→green、167 unit tests、typecheck、雙 build、artifacts | PASS |
| 假播放器連續三次 | PASS |
| normal 連續三次 | FAIL：SKIP／FAIL／SKIP |
| fallback 一次 | FAIL，g 不成立 |
| MVP 對照與資料夾唯讀 | 已完成；同 picks、a–f 有結果、centerClickSwitch 已記、28 檔 SHA 相同 |
| H1／H2／H4–H8 | 原始碼與實跑確認：正常關閉面板、情境隔離、座標、切換前提、時間戳、取樣早於加入與三種模式均有紀錄；另補本次量測修正 |
| H3 | FAIL：允許清單過寬；原始 host／extension／未分類資料皆保存 |
| Twitch 失讀／mute 失敗不走原生 | 全套既有 missing-methods／ignore-mute／retry／no-native 測試通過；本輪產品沒有改動這些路徑。fallback 實測未確認成功靜音，不能用單元通過代替備案 PASS |
| Proxy／__v_skip 邊界 | 原始碼未變、既有建構與設定測試通過；有效 normal 回合 observed=false、vIsRefErrors=0；不延伸宣稱未跑的平台 |

驗收 harness 僅修改 `tests/e2e-browser/audio-lock/live.mjs`，獨立英文 commits：

- `a924c11`：焦點事件／activeElement 只讀紀錄；c2 保留 iframe 焦點、同步取樣並保存 toggle 時間；等待 Vuetify 2 row 與動畫、確認按鈕 hit-test；reload 前提與 inherited 狀態分開記錄。normal-1 使用此版。
- `4ee1196`：整段開播等待期都重試播放按鈕；保存無法開播時的 iframe 診斷。normal-2／3 使用此版。
- `065200b`：保存面板初始與穩定後幾何。fallback／MVP 使用此版。

沒有改 src、計畫、package、dependency 或建置產物。額度：fake 3＋normal 3＋fallback 1＋MVP 1＝8/8；build 1 次；沒有額外瀏覽器 run 或重試。最後只有報告、5 份真直播 JSON、live.mjs 的 harness 修正會提交。沒有 push／PR／merge／notarize／sudo，也沒有留言／approve／request changes；沒有操作使用者瀏覽器 profile、非本次啟動的瀏覽器、Microlife、Chorus 或 Orca 安裝。所有主動寫入都在本 worktree；Git commit metadata 依授權例外。M1 Vivaldi 與 Firefox 真機未測。

最後核對時間：2026-10-18 03:47:16 CST；本輪自 03:30 起，低於 60 分鐘上限。

## 真直播 JSON SHA-256

- `fallback.json`：`391cd78bb2b13a2ab5f396478bb9051dd39315460a88623fe27af379d9c0ac27`
- `mvp.json`：`1adcb1e164586779171ec18a6d33f5463c07ad1130a6f2ecd4fb14a8d2437ddd`
- `normal-1.json`：`76447123ccc78021e54d08e58c7d274694436b6a839dbce025ab884e1d21cf9e`
- `normal-2.json`：`febc4e0fd0708c47635eb773c0c2905f21a7009149cdaa7c3bb9f8b07bd3ab17`
- `normal-3.json`：`6c77a2124e23478f607d0a32a8379ac2122dcc4d554b9b7a312d267390b099b5`

## 給 Fi 的摘要

驗收 FAIL：已實證 Twitch iframe 直接切到 YouTube 時沒有新的頂層 blur，YouTube 在 472ms 內被壓回靜音，這是需要修的 high。面板 c1／c3 在修正量測後通過，正確前提下 reload 與刪格也通過，先前這幾項失敗不能一概當成產品問題。167 項單元、typecheck、雙 build、artifacts 和三次假播放器均通過，但 normal 沒有連續三次 PASS，fallback 也實測雙聲、沒有收到靜音指令。8 次 e2e 額度已用完，未修改產品程式碼。

VERDICT: FAIL
