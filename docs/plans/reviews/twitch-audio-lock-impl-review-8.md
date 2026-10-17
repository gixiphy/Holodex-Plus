VERDICT: FAIL

受審範圍：`d8acd6eeb9fcf5d7696cdb6003ce799edeb3a7a8..a2005059701613bad41754e307d54041d1d94958`。本報告第一階段先提交可離線驗收的實跑證據；真直播尚未執行，因此暫列 FAIL，並非已判定產品缺陷。repo 根目錄沒有 AGENTS.md／CLAUDE.md，採用 Fi 提供的 Code Review Rules；未在 PR 留言或 review。

## 實跑結果

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

red 階段暫時以 d8acd6e 的 controller.ts／players.ts 原始 bytes 取代產品改動，finally 恢復受審 HEAD bytes；未改 git index，恢復後逐位元確認一致。healthy／broken 的 iframe→iframe 反向切換均停在 active=b；無 READY 測試 mute 指令為 0，三者如預期 FAIL。其餘 20 個測試 PASS；恢復後全套 173 PASS，沒有 skip／only。基準 167 + 本輪 6 = 173，既有測試名稱和斷言保持相同。

範圍只含 controller.ts 的焦點追蹤及 players.ts 的 observed Twitch READY bypass；src 沒有新增 listener／timer。state.ts、contracts.ts／TIMING、twitch-embed.ts、建置設定、package.json、yarn.lock、artifacts 測試、run.mjs、compare.mjs、evidence／既有 reviews 均未改；fakes.js 與 fix-3 證據逐位元相同。Twitch namespace／UPDATE_STATE／指令 10 的協定定義仍集中在 twitch-embed.ts。檔頭維持保守的未驗證描述，未誇大 live 結果。

## 真直播結果

待第二階段實跑 normal ×3、fallback ×1、MVP ×1，使用同組 picks：YouTube `1-LpQekNa9g`、Twitch `eslcs`。不以實作者 JSON 代替本輪實跑。

## review-7 覆核

| 項目 | 第一階段結果 |
| --- | --- |
| high：iframe→iframe c2 | healthy／broken 新測試 red→green；真直播待驗 |
| medium：c2 零取樣 | collector 在輸入之前啟動；`keyAt` 有值時改用它當起點；1950／2100ms 離線反例符合 |
| medium：H3 允許清單 | firstLine + host frame predicate；非 null 的 fetchVideoData 錯誤被拒；compare 要求同輪 MVP allowId／firstLine 一致 |

## 發現清單

第一階段尚無可報的新程式碼缺陷。最終裁決待真直播證據。

## 給 Fi

範圍、red→green、173 個單元測試、型別檢查與雙平台 build 都通過。c2 的兩種 SDK 路徑在單元測試中已可反向切換，H3 也已收窄。真直播與 MVP 對照尚未執行，暫時不能宣稱交付通過。本輪不會修改產品程式碼或開新一輪修正。

VERDICT: FAIL
