VERDICT: FAIL

# Twitch audio lock 實作驗收第 4 輪（fix-3）

受審 HEAD：`0f7eafd3823ab778d51dd18cf50c02a544782bde`。計畫 commit：`f77423c50b6d7a1ad6c91a5196965a57a28e6883`；以 `git log`／`git diff` 確認範圍為計畫之後的全部 3 個 commit：`f59dbb5ea05a3f69a1cef06a646a809fb8257eca`、`d1991086b75b011f12235d01dc598271175a9271`、受審 HEAD。根目錄沒有 AGENTS.md／CLAUDE.md，採 dispatch 的 Code Review Rules。

自動測試、建置與產物檢查通過；**必驗的 Chrome 情境連續兩次失敗，1 high、0 medium、0 low**。頁面腳本已執行，但 YouTube 被靜音取樣兩次均為 168/168，現場與證據 MVP 都為 0/168。本輪數字全部來自自行實跑，沒有採信實作報告的數字。

## 實跑結果

所有 Yarn 指令均使用 `npx --yes yarn@1.22.22`。環境固定為 `npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。外層 `.cache/review-4/check.py` 以 Python subprocess timeout 限時，逾時結束碼 124；每個指令的結束碼、秒數與原始輸出保存在 `.cache/review-4/`。表內為內層指令的實際結束碼。

| 指令 | 逾時 | 結束碼 | 數量／結果 |
| --- | ---: | ---: | --- |
| `yarn install --frozen-lockfile` | 180s | 0 | Already up-to-date；lockfile 無變更 |
| `yarn test:audio-lock` | 180s | 0 | 5 files／117 tests passed；state 28、adapter 13、players 14、settings 14、controller 48 |
| `yarn typecheck:audio-lock` | 120s | 0 | 兩段 tsc 均通過 |
| `yarn eslint --max-warnings 0 --ext .ts <音訊鎖與本輪檔案>` | 120s | 2 | 原生 lint blocker：缺少 `@typescript-eslint/eslint-plugin`，未執行規則檢查 |
| `node .cache/audio-lock-lint/run.cjs` | 120s | 0 | 使用既有本地 parser／plugin；音訊鎖 scoped lint 0 errors／0 warnings |
| `node .cache/audio-lock-lint/run.cjs --max-warnings 0 --format json --ext .ts,.mjs,.js custom-vite-plugins.ts vite.config.base.ts tests/build-artifacts/page-scripts.test.mjs tests/e2e-browser/audio-lock` | 120s | 1 | 擴大 lint blocker：6 files、13 errors／0 warnings；custom plugin、產物測試與 compare 各 0 errors |
| `yarn vite build --config .cache/review-4/no-classic.chrome.ts` | 180s | 0 | 負對照 Chrome：暫時設定移除 classic-page-scripts，未改產品設定 |
| `yarn vite build --config .cache/review-4/no-classic.firefox.ts` | 180s | 0 | 負對照 Firefox：同上 |
| `yarn test:artifacts`（負對照產物） | 120s | 1 | 2 suites／10 tests：6 pass、4 fail；兩個 dist 的解析與執行測試均報 import SyntaxError |
| `yarn build:chrome` | 180s | 0 | 41 modules；holodex page script 36,534 bytes |
| `yarn build:firefox` | 180s | 0 | 41 modules；holodex page script 36,534 bytes |
| `yarn test:artifacts`（正式產物） | 120s | 0 | 2 suites／10 tests：10 pass、0 fail；無 skip／cancel |
| `node .cache/review-4/artifacts.mjs` | 60s | 0 | 每個 dist 的全部 2 支頁面注入腳本均能傳統解析與實際執行；各 11 個 WAR 資源存在 |
| `yarn vite build --config .cache/review-4/missing-entry.ts` | 120s | 1（預期） | 暫時設定指定 bundle 不存在的入口，plugin 明確報 entry not found；產物僅寫入 `.cache/review-4/missing-entry-dist` |
| `python3 .cache/review-4/mutation-probes.py` | 120s | 0 | 1 個原樣對照＋4 個故障產物副本，逐一執行下列測試；4 種故障皆被拒絕 |
| `node --test --test-timeout=60000 .cache/review-4/control.test.mjs` | 90s | 0 | 10 pass／0 fail |
| 同上，`undiscovered-page-script.test.mjs` | 90s | 1（預期） | 移除 Chrome 頁面腳本的可掃描引用：6 pass／4 fail |
| 同上，`runtime-throw.test.mjs` | 90s | 1（預期） | Chrome 頁面腳本可解析但執行時 throw：9 pass／1 fail |
| 同上，`missing-page-WAR.test.mjs` | 90s | 1（預期） | Chrome manifest 未列頁面腳本 WAR：9 pass／1 fail |
| 同上，`missing-WAR-file.test.mjs` | 90s | 1（預期） | Chrome WAR 引用不存在檔案：9 pass／1 fail |
| `node tests/e2e-browser/audio-lock/run.mjs fix dist_chrome docs/plans/reviews/twitch-audio-lock-fix-3-harness-result.json` | 280s | 0 | 62.05s；168 個點 Twitch 前取樣＋20 個使用者操作後取樣；完成但驗收不通過 |
| `node tests/e2e-browser/audio-lock/run.mjs mvp /Applications/Extensions/holodex-plus-audiolock-chrome .cache/review-4/mvp.json` | 280s | 0 | 62.00s；168＋20 個取樣；MVP 僅唯讀載入 |
| `node tests/e2e-browser/audio-lock/run.mjs none none .cache/review-4/none.json` | 280s | 0 | 62.02s；168＋20 個取樣；Twitch 搶聲對照有效 |
| `node tests/e2e-browser/audio-lock/run.mjs fix-rerun dist_chrome .cache/review-4/fix-rerun.json` | 280s | 0 | 62.21s；168＋20 個取樣；相同未修改 build 再度失敗 |
| `node tests/e2e-browser/audio-lock/compare.mjs <fix> <MVP 證據>` | 30s | 1 | 首次檢查 5 個失敗理由，見下表 |
| 同 compare，`<fix> <MVP 現場> <MVP 證據> <none>` | 30s | 1 | 四組並列，候選失敗 |
| 同 compare，`<fix> <MVP 現場> <MVP 證據> <none> <fix-rerun>` | 30s | 1 | 最終五組並列，兩次 fix 行為一致 |

原生 lint 的 `<音訊鎖與本輪檔案>` 實際參數為 `src/pages/content/holodex/audio-lock src/pages/content/holodex/twitch-audio-lock.ts src/pages/content/holodex/audio-lock-settings.ts tests/audio-lock vitest.audio-lock.config.ts custom-vite-plugins.ts vite.config.base.ts tests/build-artifacts/page-scripts.test.mjs tests/e2e-browser/audio-lock`。擴大 lint 的 13 errors 分布：`vite.config.base.ts` 2 個既有 unused imports；`fakes.js` 5 個（證據檔原樣複製）；`run.mjs` 6 個（unused expression、empty catch）。按審查規則，lint 能抓到的診斷僅記錄為 blocker，不列產品發現。沒有修改依賴或規則以消除診斷。

## 瀏覽器驗收

使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` **155.0.8059.80** headless，Node **v26.12.0**。run.mjs 本身有 240s 全域逾時，外層 280s；4 次執行均完整結束，沒有因例外／逾時重試。profile 全在本 worktree `.cache/e2e-browser/`，結束後 `prof-*` 殘留 0；未碰使用者 profile。正式兩個 dist 在瀏覽器驗收前已用產品設定重新建置。

以下為 `compare.mjs` 實際輸出，僅將兩個同名 mvp 欄加上現場／證據標示以利核對：

| 檢查 | 新 build（fix） | MVP 現場 | MVP 證據 | none | 新 build 重跑 |
| --- | --- | --- | --- | --- | --- |
| 頁面腳本有跑 | yes | yes | yes | no | yes |
| Twitch 晚播後 | none | YT | YT | TW | none |
| 自己取消靜音後 | none | YT | YT | TW | none |
| 延遲＋重複 6 次後 | none | YT | YT | TW | none |
| 延遲期間被搶次數 | 116 | 0 | 0 | 116 | 116 |
| YouTube 被靜音取樣／總取樣 | 168/168 | 0/168 | 0/168 | 156/168 | 168/168 |
| 使用者點 Twitch 後 | TW | TW | TW | TW | TW |
| AudioLock 警告數 | 0 | 0 | 0 | 0 | 0 |
| 判定 | FAIL (afterBothPlay, afterSelfUnmute1, afterLaggedRepeats, everStolenDuringLag, ytMutedSamples/samples) | FAIL (flags.v3/newHandle) | FAIL (flags.v3/newHandle) | FAIL (flags.v3/newHandle, afterBothPlay, afterSelfUnmute1, afterLaggedRepeats, everStolenDuringLag, ytMutedSamples/samples) | FAIL (afterBothPlay, afterSelfUnmute1, afterLaggedRepeats, everStolenDuringLag, ytMutedSamples/samples) |

MVP 的候選判定只因缺少正式版 newHandle 而 FAIL，行為各列均符合預期；compare 的結束碼僅取第一個候選。fix 的 `none` 表示兩邊都靜音，和「無擴充 none」欄不同。表內「延遲期間被搶次數」實際為 `storeA === true` 的取樣數：fix 的 116 不代表 Twitch 搶聲 116 次，而是 YouTube 原本就一直被靜音。這不影響「YouTube 一直有聲、被靜音取樣 0」未達標的結論。

獨立重算四次現場執行的完整 timeline，均為 yt-play 12、tw-play 16、self-unmute 24、六次 lag-unmute 各 16、lag-settle 20、user-unmute 20；前 168 個取樣與 checks.samples／ytMutedSamples 一致。兩次 fix 的 flags.v3／newHandle 均 true，各有 2 次 `[Holodex+] Activated`，errors 為空，SyntaxError 與 AudioLock 警告均 0。使用者點 Twitch 後 activeElement 為 IFRAME，音訊確實轉成 TW。GA／vue-i18n／站點 vendor 的其他 console 診斷未算成本輪缺陷。

最終 compare 完整指令：

```sh
node tests/e2e-browser/audio-lock/compare.mjs \
  docs/plans/reviews/twitch-audio-lock-fix-3-harness-result.json \
  .cache/review-4/mvp.json \
  docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json \
  .cache/review-4/none.json \
  .cache/review-4/fix-rerun.json
```

提交的第一輪原始 harness JSON SHA-256：`d86641eda573eb2d74fb3d96452e5812affdf1120ab407b9f5201d808439aab9`；沒有以重跑結果覆蓋。重跑原始 JSON 在 `.cache/review-4/fix-rerun.json`，SHA-256 `a1329bd16dc73f704dc2cbeb2fc4e6cd4eacabdd21e4b149c1249b54d560212c`。

## 產物與範圍核對

已從 `src/**` 的所有 `?script` import、`inject()` 呼叫與 DOM script 建立處確認，實際頁面注入入口只有 holodex 與 yt-chat，yt-player 注入程式碼已註解。另獨立掃描全部 dist JS 的 `/assets/*.js` 常數，未依預期入口前綴過濾，兩個 dist 各找到同樣 2 支頁面腳本：

| 頁面腳本（兩個 dist 相同） | bytes | SHA-256 | 驗證 |
| --- | ---: | --- | --- |
| `assets/holodex-inject.ts-BjDs9NrB.js` | 36534 | `4ddff57d96267c875b4c5e1da9f5f6fcbd80e675cb8e32fd36fde6a77c1bb733` | 開頭 `(function(){"use strict";`；vm.Script 成功；jsdom 中 installed／installedV3／archive 均 true，handle.dispose 存在 |
| `assets/inject.ts-CQQBYCft.js` | 255 | `e464fbc1c3f3c43a0e87b51ea3d07164c52b394559da8026e6370538ee0bef55` | vm.Script 成功；jsdom 中 dark_theme=1／0 分別設置／移除 dark |

兩支均無 static import／export、dynamic import、import.meta、process.env 或 extension API 殘留。除了頁面腳本本身，也獨立確認各自引用它的 content script chunk 在對應站點 WAR 內。Firefox 負對照與正式建置的 29 個檔案逐一 SHA-256 比對，只有 holodex page script 內容改變，另 28 個完全相同（包含 yt-chat、manifest 與 content scripts）。

`git diff f77423c..0f7eafd` 只有計畫白名單 9 個檔案；`package.json` 僅新增兩個 scripts。`src/**`、yarn.lock、manifest、Chrome／Firefox config、既有音訊鎖測試與證據資料夾皆未改動。`fakes.js` 已用 cmp 確認與唯讀證據完全相同；harness diff 保留原情境、時間、取樣、Fetch 攔截，另加 profile 路徑、清理及 manifest 路徑檢查。

## 發現清單

1. **high — 新增 harness 未確立與 MVP 相同的 YouTube 起始選聲，必驗連續兩次失敗。**

   `tests/e2e-browser/audio-lock/run.mjs:78-84 @ 0f7eafd3823ab778d51dd18cf50c02a544782bde`

   含前後各一行的原始上下文：

   ```text
   77  await waitFor(`!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&document.querySelector('#app').__vue__.$store)`, 60000, 'vue store');
   78  await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;
   79    st.commit('multiview/setLayout',[{x:0,y:0,w:12,h:12,i:'a'},{x:12,y:0,w:12,h:12,i:'b'}]);
   80    st.commit('multiview/setLayoutContent',{a:{type:'video',id:'ytFAKE00001',video:{id:'ytFAKE00001',type:'stream',status:'live',title:'YT',channel:{id:'c1',name:'yt'}}},
   81      b:{type:'video',id:'fakechannel',video:{id:'fakechannel',type:'twitch',status:'live',title:'TW',channel:{name:'fakechannel'}}}});
   82    st.commit('multiview/setMuteOthers',true); return JSON.stringify(st.state.multiview.layoutContent);})()`);
   83  await sleep(1500);
   84  await send('Page.reload', {}, S);
   85  await sleep(1000);
   ```

   新增的 setup 只設定內容與 Mute Others，再等待固定時間 reload，未確立起始選聲。兩次使用全新 profile 執行時，fix 的 checks.initial 都已是 `storeA=true, storeB=true, ytMuted=true, twMuted=true`；MVP 現場與證據則都是 `storeA=false, storeB=true, ytMuted=false, twMuted=true`。後續 `__startPlaying()` 不會解除既有靜音，因此 fix 三個 audible 檢查點均為 `none`，前 168 個取樣的 YouTube 全部靜音，與 MVP 要求的 0/168 不符。第 102–103 行只記錄 `forcedYT=true`，沒有建立 YouTube 選聲。這讓本輪新增的端到端驗收無法重現計畫宣稱的起始情境，且實際必驗不通過；依 Fi「任何一項不符就是 high」列級。

   應釐清 seed／reload 後形成全靜音的啟動流程，讓候選與 MVP 從可核對的相同初始選聲執行情境，再完整重跑；不能只以產物測試或 run.mjs exit 0 宣稱通過。已確認注入格式修正有效。**歸因限制：**本輪未完全定位全靜音形成的時點；既有 reducer 明確將全 muted 視為 silence，不把這個刻意政策另列 bug，也沒有證據可指稱 IIFE 包裝改壞演算法。此發現定位於本輪新增的 harness setup 與必驗缺口，未要求修改既有 silence 政策。

沒有其他 high／medium／low。Lint 診斷、Markdown 行尾空白、既有邏輯與未改動行均未另列發現。

## 邊界、限制與交付

產物負對照已實際抓到 ESM 解析失敗；新增的四種故障副本也證明找不到入口、執行期錯誤、WAR 漏列／缺檔不會被測試空轉掩蓋。另以不存在的入口跑真 Vite build，plugin 正確讓建置失敗。兩份正式產物未被故障副本測試修改。音訊鎖既有 117 tests 中的 intent expiry、degraded／route reentry、Mute Others off、BFCache、READY late bind 與缺 method 情境全部通過；沒有順手擴大產品功能。

本輪 e2e 共 4 次（上限 6），Vite 外層建置共 5 次（兩個負對照、兩個正式 target、一個缺入口測試），沒有超過計畫額度。Firefox 真機載入與 Fi 的 M1 Vivaldi 實測仍是交付後人工項，未宣稱完成。依指定順序，先以 `7aa25b4` 保存測試／建置證據，再進行瀏覽器驗收；最終只提交本報告與指定 harness 結果。產品程式碼、計畫、證據、依賴與 build 產物未提交改動；未 push、開 PR、merge、notarize、sudo，未使用外掛／plugin skill 或 PR 留言／review 操作。

## 給 Fi 的摘要

本輪判定 FAIL，必驗的 Chrome 情境連跑兩次都未達標，列一項 high。頁面腳本確實已執行，但新 build 起始就是兩格全靜音，YouTube 靜音取樣為 168/168，MVP 現場與證據均為 0/168。使用者點 Twitch 後可以正確切換，117 個單元測試、typecheck、兩個 build 與 10 個產物測試也通過。下一輪需先釐清並建立與 MVP 相同的起始選聲再重驗，原始失敗 JSON 已保存，lint blocker 也已如實列入。

VERDICT: FAIL
