VERDICT: FAIL

# Twitch audio lock fix-5 implementation review 6

DISPATCH-2610180210380160。驗收者 Codex；基準 `ea9a65cfeb2206e0cb07c92079e1dd8767f74ae9`；受審 HEAD `7cb4849bdf2bf1b9b52fb29e9a522b080f6bd2e6`。機器 arm64 Apple M5。開始 2026-10-18 02:10 Asia/Taipei。根目錄無 AGENTS.md／CLAUDE.md，採用派工規則。

本次先提交實跑測試／build／範圍檢查結果，再進入真直播。此版真直播尚未執行，因此不能判 PASS。

## 實跑結果

所有命令設定 `npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。yarn 固定 `npx --yes yarn@1.22.22`。

| 指令（均有外層 Perl alarm） | 結束碼 | 數量／結果 |
| --- | --- | --- |
| `perl -e alarm 180; exec @ARGV -- npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/twitch-broken.test.ts` | 1 | 14 tests: 11 failed / 3 passed（預期 red） |
| `perl -e alarm 180; exec @ARGV -- npx --yes yarn@1.22.22 test:audio-lock` | 0 | 8 files / 164 passed / 0 skipped |
| `perl -e alarm 180; exec @ARGV -- npx --yes yarn@1.22.22 typecheck:audio-lock` | 0 | 兩份 tsconfig 通過 |
| `perl -e alarm 240; exec @ARGV -- npx --yes yarn@1.22.22 build` | 0 | Chrome＋Firefox；本輪 build 1 次 |
| `perl -e alarm 180; exec @ARGV -- npx --yes yarn@1.22.22 test:artifacts` | 0 | 10 passed |
| `perl -e alarm 260; exec @ARGV -- node tests/e2e-browser/audio-lock/run.mjs review6-fake-1 dist_chrome .cache/review6/fake-1.json` | 0 | PASS |
| `perl -e alarm 30; exec @ARGV -- node tests/e2e-browser/audio-lock/compare.mjs .cache/review6/fake-1.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | PASS |
| `perl -e alarm 260; exec @ARGV -- node tests/e2e-browser/audio-lock/run.mjs review6-fake-2 dist_chrome .cache/review6/fake-2.json` | 0 | PASS |
| `perl -e alarm 30; exec @ARGV -- node tests/e2e-browser/audio-lock/compare.mjs .cache/review6/fake-2.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | PASS |
| `perl -e alarm 260; exec @ARGV -- node tests/e2e-browser/audio-lock/run.mjs review6-fake-3 dist_chrome .cache/review6/fake-3.json` | 0 | PASS |
| `perl -e alarm 30; exec @ARGV -- node tests/e2e-browser/audio-lock/compare.mjs .cache/review6/fake-3.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json` | 0 | PASS |

修正前驗證在 `.cache/review6/baseline/` 進行：拷貝本輪測試，將所有既有受改動 src 檔還原為基準版本；新增 `twitch-embed.ts` 僅留給 fixtures import，基準 controller／players 不引用它。指定九項回歸測試全因 degraded／原生呼叫／無 postMessage／未切換／bootstrap 錯誤而 FAIL，沒有 import error。正式 src 未被修改。

範圍檢查：七個 src 檔皆符合允許清單；holodex-adapter 只新增 readMuteOthersHint；TIMING 無變更；三個 protocol 值只在 twitch-embed.ts 定義（players.ts 另有 UPDATE_STATE 說明註解，沒有重複定義）。建置設定、tests/build-artifacts、yarn.lock、evidence、fakes.js 均無變更；fakes.js 與證據逐位元相同。package.json 僅新增 live script；128 個既有測試名稱全保留，新增 36 個，無 skip／only。

| 假播放器 | run / compare exit | ytMutedSamples | 使用者取消 Twitch 靜音後 | AudioLock warnings |
| --- | --- | --- | --- | --- |
| 1 | 0 / 0 | 0 / 168 | TW | 0 |
| 2 | 0 / 0 | 0 / 168 | TW | 0 |
| 3 | 0 / 0 | 0 / 168 | TW | 0 |

## 真直播結果

待執行：normal ×3、fallback ×1、MVP ×1。e2e 已用 3/8，build 1 次。

## 發現清單

待真直播完成後補入；目前不宣告沒有問題。

## 給 Fi 的摘要

既有 128 個測試與新增 36 個測試全過。指定回歸測試對修正前版本確實失敗，並非只驗證 import。Chrome／Firefox build、10 個 artifacts 檢查和假播放器三連跑皆通過。真直播驗收尚待完成，因此本階段不能交付。

VERDICT: FAIL
