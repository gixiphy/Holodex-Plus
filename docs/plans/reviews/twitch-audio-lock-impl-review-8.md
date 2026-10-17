VERDICT: PASS

受審 HEAD：`a2005059701613bad41754e307d54041d1d94958`（開工以 `git rev-parse HEAD` 取得）。範圍：`d8acd6eeb9fcf5d7696cdb6003ce799edeb3a7a8..a2005059701613bad41754e307d54041d1d94958` 的全部 4 commits：c16b71d、752ef8a、f08807b、a200505。後續 review commits 不屬產品受審範圍。

repo 根目錄沒有 AGENTS.md／CLAUDE.md，採用 Fi 提供的 Code Review Rules。依 [code-review skill](/Users/wuxianyou/.agents/skills/code-review/SKILL.md) 以兩個唯讀子審查軸核對 Standards／Spec，兩軸均無可報的新缺陷；測試與真直播由驗收者獨立執行。沒有採信實作報告的測試數字作為驗收證據。

## 實跑結果

依指定順序，範圍、測試、build、artifacts、假播放器三次的結果已先提交於 `7f19ee0651fac01c1de01f281c2bf1d9cfb3ca22`，之後才啟動真直播。假播放器 JSON 執行時先寫至表列路徑，完成後移至 `.cache/fix5-review3/fake-{1,2,3}.json` 保留；未提交假播放器 JSON 或 build 產物。

全部指令外包 `perl -e 'alarm N; exec @ARGV' --`：一般檢查 180s、build 300s、syntax／例外／scope／離線取樣／compare 30s、假播放器 260s。環境固定 `npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。本機 `sysctl -n machdep.cpu.brand_string` = Apple M5。

| 指令 | 結束碼 | 數量／結果 | 秒 |
| --- | --- | --- | --- |
| `npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts` | 1 | 23：預期 3 FAIL / 20 PASS | 2.24 |
| `npx --yes yarn@1.22.22 test:audio-lock` | 0 | 173 PASS / 8 files | 1.97 |
| `npx --yes yarn@1.22.22 typecheck:audio-lock` | 0 | 2 個 tsconfig | 2.05 |
| `npx --yes yarn@1.22.22 build` | 0 | Chrome + Firefox（1 次 build） | 2.31 |
| `npx --yes yarn@1.22.22 test:artifacts` | 0 | 10 PASS / 2 suites | 0.88 |
| `node --check tests/e2e-browser/audio-lock/live.mjs` | 0 | 1 script | 0.07 |
| `node --check tests/e2e-browser/audio-lock/live-compare.mjs` | 0 | 1 script | 0.07 |
| `node --test tests/e2e-browser/audio-lock/live-exceptions.test.mjs` | 0 | 6 PASS | 0.16 |
| `node tests/e2e-browser/audio-lock/run.mjs review3-fake-1 dist_chrome docs/plans/reviews/e2e-fix5-review-3/fake-1.json` | 0 | 1 次 | 63.7 |
| `node tests/e2e-browser/audio-lock/compare.mjs docs/plans/reviews/e2e-fix5-review-3/fake-1.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | candidate PASS | 0.07 |
| `node tests/e2e-browser/audio-lock/run.mjs review3-fake-2 dist_chrome docs/plans/reviews/e2e-fix5-review-3/fake-2.json` | 0 | 1 次 | 63.42 |
| `node tests/e2e-browser/audio-lock/compare.mjs docs/plans/reviews/e2e-fix5-review-3/fake-2.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | candidate PASS | 0.08 |
| `node tests/e2e-browser/audio-lock/run.mjs review3-fake-3 dist_chrome docs/plans/reviews/e2e-fix5-review-3/fake-3.json` | 0 | 1 次 | 63.36 |
| `node tests/e2e-browser/audio-lock/compare.mjs docs/plans/reviews/e2e-fix5-review-3/fake-3.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | candidate PASS | 0.08 |
| `python3 .cache/fix5-review3/scope.py` | 0 | 範圍、既有測試、fakes、報告 9 個 SHA-256 全部一致 | <1 |
| `node .cache/fix5-fix2/c2-sampling.mjs` | 0 | 1950ms → 2000ms PASS；2100ms → null FAIL（各 14 samples） | <1 |
| `npx --yes yarn@1.22.22 test:audio-lock --config .cache/fix5-review3/vitest.extra.config.ts` | 1 | 0 tests；重複 --config，探測啟動錯誤 | <2 |
| `npx --yes yarn@1.22.22 vitest run --config .cache/fix5-review3/vitest.extra.config.ts`（首次） | 1 | 0 tests；.cache 被預設排除 | <1 |
| 同上（探測 config 修正 exclude 後） | 0 | 5 PASS；獨立邊界探測 | <2 |
| `python3 .cache/fix5-review3/audit-live.py` | 0 | 獨立覆核 5 份 raw JSON | <1 |
| `node tests/e2e-browser/audio-lock/live-compare.mjs .cache/fix5-review3/h3-probe.json docs/plans/reviews/e2e-fix5-review-3/mvp.json` | 0 | 1；同訊息 match | <1 |
| `node tests/e2e-browser/audio-lock/live-compare.mjs .cache/fix5-review3/h3-probe.json .cache/fix5-review3/h3-empty-mvp.json` | 1 | 1；預期 FAIL(mvp-missing) | <1 |

red 階段暫時以 d8acd6e 的 controller.ts／players.ts 原始 bytes 取代產品改動，finally 恢復受審 HEAD bytes；未改 git index，恢復後逐位元確認一致。healthy／broken 的 iframe→iframe 反向切換均停在 active=b；無 READY 測試 mute 指令為 0，三者如預期 FAIL。其餘 20 個測試 PASS；恢復後全套 173 PASS，沒有 skip／only。基準 167 + 本輪 6 = 173，既有測試名稱和斷言保持相同。

範圍只含 controller.ts 的焦點追蹤及 players.ts 的 observed Twitch READY bypass；src 沒有新增 listener／timer。state.ts、contracts.ts／TIMING、twitch-embed.ts、建置設定、package.json、yarn.lock、artifacts 測試、run.mjs、compare.mjs、evidence／既有 reviews 均未改；fakes.js 與 fix-3 證據逐位元相同。Twitch namespace／UPDATE_STATE／指令 10 的協定定義仍集中在 twitch-embed.ts。檔頭維持保守的未驗證描述，未誇大 live 結果。

## 真直播實跑指令與結果

以下每次均有內層 300s、外層 `perl -e 'alarm 320; exec @ARGV' --`；皆為本機 M5 的有畫面 Google Chrome，暫存 profile 放 `.cache/e2e-browser/live-prof-*`，退出後刪除。五次 picks 完全相同：YouTube `1-LpQekNa9g`、Twitch `eslcs`。不使用使用者 profile；沒有額外重試、診斷輪或挑換直播。

| 指令 | 結束碼 | 秒 | 結果 |
| --- | --- | --- | --- |
| `node tests/e2e-browser/audio-lock/live.mjs review3-normal-1 dist_chrome docs/plans/reviews/e2e-fix5-review-3/normal-1.json --mode=normal` | 0 | 135.16 | PASS |
| `node tests/e2e-browser/audio-lock/live.mjs review3-normal-2 dist_chrome docs/plans/reviews/e2e-fix5-review-3/normal-2.json --mode=normal` | 0 | 136.41 | PASS |
| `node tests/e2e-browser/audio-lock/live.mjs review3-normal-3 dist_chrome docs/plans/reviews/e2e-fix5-review-3/normal-3.json --mode=normal` | 0 | 136.87 | PASS |
| `node tests/e2e-browser/audio-lock/live.mjs review3-fallback dist_chrome docs/plans/reviews/e2e-fix5-review-3/fallback.json --mode=fallback` | 0 | 107.54 | PASS |
| `node tests/e2e-browser/audio-lock/live.mjs review3-mvp /Applications/Extensions/holodex-plus-audiolock-chrome docs/plans/reviews/e2e-fix5-review-3/mvp.json --mode=normal` | 1 | 139.33 | FAIL |

`node tests/e2e-browser/audio-lock/live-compare.mjs docs/plans/reviews/e2e-fix5-review-3/{normal-1,normal-2,normal-3,fallback,mvp}.json`（五個路徑各自展開）exit **0**；normal 三次與 fallback 的 `effectiveVerdict` 全部 PASS，MVP 為 FAIL。每一個 fix JSON 的 raw samples、指令與狀態序列另經 `perl -e 'alarm 30; exec @ARGV' -- python3 .cache/fix5-review3/audit-live.py` 獨立重新計算，exit 0，沒有只採用 harness 的 pass 布林值。

| 情境／欄位 | fix normal 1 | fix normal 2 | fix normal 3 | fix fallback | MVP |
| --- | --- | --- | --- | --- | --- |
| a | PASS | PASS | PASS | PASS | PASS |
| b | PASS | PASS | PASS | PASS | FAIL |
| c1 | PASS 92ms | PASS 53ms | PASS 53ms | PASS 654ms | FAIL |
| c2 | PASS 891ms | PASS 684ms | PASS 843ms | PASS 1992ms | FAIL |
| c3 | PASS 47ms | PASS 48ms | PASS 85ms | PASS 151ms | FAIL |
| d | PASS | PASS | PASS | SKIP | FAIL |
| e | PASS | PASS | PASS | PASS | PASS |
| f | PASS | PASS | PASS | SKIP | FAIL |
| g | SKIP | SKIP | SKIP | PASS | SKIP |
| `vIsRefErrors` | 0 | 0 | 0 | 1234 | 1466 |
| `twitchObserved` | false | false | false | true | true |
| `updateStateMessages` | 53 | 56 | 54 | 212 | 54 |
| a：YT muted／store a=true／TW audible samples | 0/0/0（共 179） | 0/0/0（共 179） | 0/0/0（共 179） | 0/0/0（共 179） | 0/0/0（共 179） |
| c2 inputFallback／取樣數 | false／43 | false／43 | false／43 | false／43 | true／62 |
| effectiveVerdict | PASS | PASS | PASS | PASS | FAIL（預期對照） |

SKIP 是該模式沒有安排的情境：normal／MVP 不跑 g，fallback 不跑 d／f；五次執行沒有整輪 SKIP，`twitchMountRetry` 也全部是 null。

聲音校準逐一以播放器自己的受信任 mute 按鈕切換，兩個播放器均 `ok:true`。量測由各 iframe 的 CDP session 獨立讀 `<video>`；在播條件為 `!paused && readyState >= 2`，有聲還需 `muted === false && volume > 0.01`。沒有用 SDK、store 或 postMessage 成功回傳冒充實際聲音。

四次 fix 的 b 均存在對應 `UPDATE_STATE muted:false`，`firstRemuteAt:null`；raw b phase command log 在該更新後 3 秒內沒有 SetMuted true，之後 3 秒 hold 也全部 Twitch 有聲／YouTube 靜音。四次 fix 的每輪 c 都有 5 秒 hold（20 筆）且全部 YouTube 有聲／Twitch 靜音。normal reload 後的 raw samples 也獨立確認 store a 沒有 true；刪格後新 extension／host／未分類例外均為 0，YouTube 仍有聲。

MVP `centerClickSwitch` 為 `{"storeA":false,"twitchVideoMuted":true,"youtubeVideoMuted":false}`；storeB 是 undefined，JSON 未序列化該鍵。a–f 都有結果；b／c×3／d／f FAIL，e PASS。MVP 的 f 有跨來源 `__v_isRef` 未分類例外且 YouTube 不是有聲，屬對照結果，未列成 fix 新缺陷。MVP 的 28 個檔案，以指定 `find /Applications/Extensions/holodex-plus-audiolock-chrome -type f -exec shasum {} + | sort` 跑前／跑後建立清單，`cmp` exit 0。

## review-7 的 1 high／2 medium 覆核

| 原發現 | 本輪實證 | 判定 |
| --- | --- | --- |
| high：iframe→iframe c2 沒意圖 | 新增 healthy／broken 測試均 red→green；normal c2 891／684／843ms，fallback c2 1992ms；四次均從 Twitch iframe 直接點到 YouTube，keyAt=null、keepFocus=true，沒有空白點擊或人工派送 blur | 修好 |
| medium：c2 零取樣 | collector 在輸入之前啟動；四次 fix c2 各有 43 筆。計時為 clickAt，只有實際送 m 才改用 keyAt；1950ms 反例取樣在 2000ms 判 PASS，2100ms 判 FAIL | 修好 |
| medium：H3 允許清單過寬 | 6 個 node tests 通過，含 stack 有 fetchVideoData 的非 null 錯誤被拒；firstLine 與 host frame predicate 同時符合才豁免，compare 還要同輪 MVP 的 allowId／firstLine 相同 | 修好 |

c2 的焦點事件另讀 normal JSON 的 `preReload.focusEvents`（沒有誤讀 reload 後重設的欄位），fallback 讀最後的 `focusEvents`：四次輸入後 2500ms 內都只有焦點 active-change 到 YouTube，沒有頂層 blur；toggle 同時保留輸入前 Twitch、輸入後 YouTube 的 iframe URL。產品的既有輪詢先建立意圖才讀播放器，setMuted refresh 前也同樣同步焦點；同一 iframe 不刷新，2500ms 常數未變。

H3 的同輪 MVP 依賴另外做了兩個離線 compare 反例：放入允許的 null-fetchVideoData pending 訊息，搭配本輪 MVP 時 exit 0／effective PASS；搭配缺少該訊息的 MVP JSON 時 exit 1／`FAIL(mvp-missing)`，effective FAIL。三次 normal 的 f 沒有新增 host 例外，實際 PASS 不依賴允許清單。normal 和 MVP 在其他階段都有 null-fetchVideoData、getCurrentTime 及 HTTP 400；400 的 allowId 為 null，沒有被豁免。

## Y1／fallback 管道與失敗邊界

本輪 fallback 的 probes 與 X1/Y1 一致：`twPlayerSet:false`、`instHasOb:true`、`instHasSetMuted:true`、`instHasGetMuted:true`、`readyListeners:1`、合法 Twitch iframe 1 個、`wrapperInstalled:true`。沒有 READY／VideoCell.twPlayer 仍空時，port 已能獨立綁定 iframe；最後的 mute 計數 3、unmute 0，`updateStateMessages:212`、`vIsRefErrors:1234`。AudioLock 警告僅 `twitch-guard-unavailable`，情境 e／g PASS。

| fallback round | 輸入時間 epoch ms | iframe 收到 mute | 收到後 UPDATE_STATE true | video 確認切換 | muteDelta |
| --- | --- | --- | --- | --- | --- |
| c1 | 1792270178199 | 1792270178833（+634ms） | 1792270178848（收到指令後 +15ms） | 654ms | 1 |
| c2 | 1792270194877 | 1792270196833（+1956ms） | 1792270196845（收到指令後 +12ms） | 1992ms | 1 |
| c3 | 1792270208692 | 1792270208832（+140ms） | 1792270208838（收到指令後 +6ms） | 151ms | 1 |

以上由 `logsByPhase.c1/c2/c3.twitchCommandLog` 的 `params:true`、同 phase 的 `updateStates` 轉成 true，以及 raw video samples 三方對時；不是單看 command count 或 store。a／b 沒有收到 mute 的計數，不能單靠那兩段證明靜音通道；c 的三輪明確補足實際指令與回報證據。

真直播完成後，另在 `.cache/fix5-review3/extra.test.ts` 建立獨立探測，不改 src 或既有測試。`perl -e 'alarm 180; exec @ARGV' -- npx --yes yarn@1.22.22 vitest run --config .cache/fix5-review3/vitest.extra.config.ts` exit **0**、**5 PASS**（使用 Vitest fake timers，秒數為模擬時間）：

- 無 READY、無 UPDATE_STATE、每次 postMessage 都 throw：20 秒持續重試，沒有 degraded／原生檢查／Mute Others，wrapper 保留、YouTube 仍有聲。
- 無 READY、已讀到 muted:false、送 mute 但永不套用：20 秒持續重試，同樣不降級、不回原生、不碰 YouTube。
- Y1 綁定後 iframe 消失、再返回：wrapper 保持，返回後重試 mute。
- healthy、未被 Vue 觀察、沒有 READY：維持等 READY，不誤走 Y1；YouTube 與 wrapper 保持。
- visible 頁面 session 開始前已在 YouTube iframe：沒有建立新意圖，自己取消靜音仍被壓回，選聲保持 Twitch。

額外探測初次執行誤把第二個 `--config` 加到 test:audio-lock（exit 1、尚未跑測試）；改用 vitest 後又因預設排除 `.cache` 而 exit 1／no tests。將僅供探測的 config 明確 include 該檔、exclude node_modules 後 5 項通過。這兩次是驗收腳本設定問題，未修改 repository config，不計入 173 個正式單元測試。

既有全套也涵蓋 unreadable／首次 post 失敗重試／送出未生效／SDK 缺方法／healthy 忽略 mute／placeholder／同焦點不刷新／hidden／2500ms 到期／關閉設定與 Mute Others。新 Y1 只對 observed Twitch 且有 setMuted 與合法 iframe 生效，YouTube 和 healthy 正常 READY 路徑不變；controller 的 Twitch 失敗分支持續保留 wrapper，不會 failSession 或原生接手。`__v_skip`／Proxy 與 twitch-embed.ts 本輪沒有改動，三次 normal 的 observed=false、vIsRefErrors=0、操作／reload／刪格結果沒有發現副作用。

## 發現清單

No issues found. Checked for bugs and AGENTS.md compliance.

高／中／低嚴重度的新缺陷皆為 0。Standards 軸沒有發現硬性規則違反；Spec 軸沒有發現漏做、錯做或範圍外功能改動。

## 注意事項與驗收界線

fallback c2 的 1992ms 符合本輪 2000ms 門檻，但只剩 8ms 餘裕，沒有把這一次結果外推為所有負載下的延遲保證。本輪未新增產品改動或 harness 修正，live.mjs 與受審 HEAD 逐位元相同。Fi 在 M1 Vivaldi 的實測與 Firefox 真機載入仍是交付後人工項目；雙平台 build／artifacts 不等同於那兩項已完成。

e2e 共 **8/8**（假播放器 3＋normal 3＋fallback 1＋MVP 1），build **1 次**；驗收時間約 2026-10-18 04:37–04:57（Asia/Taipei，約 20 分鐘），在 60 分鐘內完成，沒有額外瀏覽器重跑。`.cache/e2e-browser/` 無 prof-*／live-prof-* 殘留，也沒有本輪啟動且仍存活的瀏覽器程序。沒有使用使用者 profile、沒有干擾其他瀏覽器、沒有接觸 Microlife／Chorus／Orca 安裝；沒有 push／PR／merge／notarize／sudo。所有任務寫入留在本 worktree（commit metadata 是 Fi 明確允許的例外）。

## 本輪真直播 JSON SHA-256

| 檔案 | SHA-256 |
| --- | --- |
| `normal-1.json` | `7a5e17e7af154887dc7120fb492d333b1601821ec46b25abac806f03dd238c3b` |
| `normal-2.json` | `3a01397ed91c5ce55e8f028930b38640a9616efe93be435c86144bf7a919568f` |
| `normal-3.json` | `592c781b1f323cb24d9b1702d719b33b12bd3baaac6ab517e8623ce9f08e2f28` |
| `fallback.json` | `c0e274b8fe6901d52cded2c22b21f5d50ad53e2894cd42c0861ed42f4a7b6717` |
| `mvp.json` | `a83e4193e2145e287f6d43784a193a6ceb24f3afcb0bfc63514b56d1d4952000` |

實作者報告內原有 9 份 JSON 的 SHA-256 也已重新計算，均與實作報告一致，且原報告與 JSON 都已存在受審 commit。

## 給 Fi

這輪驗收 PASS，上一輪的 1 high／2 medium 都有本輪實跑證據確認修好。173 個正式單元測試、雙平台 build、artifacts 與假播放器連續三次全部通過，真直播 normal 連續三次、fallback 一次也都通過。fallback 三輪都能對上收到的 mute、UPDATE_STATE true 與 video 真相，無 READY／靜音失敗時也沒有回到原生 Mute Others。MVP 的 c 確實失敗，對照成立；fallback c2 為 1992ms、接近門檻，M1 Vivaldi 與 Firefox 真機仍留給交付後人工驗證。

VERDICT: PASS
