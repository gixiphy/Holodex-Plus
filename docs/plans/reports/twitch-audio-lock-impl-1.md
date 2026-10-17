# Twitch audio lock 實作報告（impl-1）

日期：2026-10-17。工作分支：`gixiphy/twitch-audio-lock`。計畫：`docs/plans/twitch-audio-lock.md`（Fi 核准，題 1–8 全採建議預設 A）。Dispatch：`DISPATCH-2610171550156325`。

## 結論

已依計畫完成第一個 PR 範圍的產品實作、feature 測試、scoped lint、typecheck、Chrome／Firefox build。自動驗證通過；**真實瀏覽器人工清單尚未執行**，因此定位為「可交付實測」候選，不可宣稱已驗證真實 Twitch。

## 對照計畫步驟

| 任務／波次 | 狀態 | 說明 |
| --- | --- | --- |
| 任務 0：鎖定 PR／commit 邊界 | 完成 | 分支維持 `gixiphy/twitch-audio-lock`；基準 `upstream/dev@709e963` 本機確認；Fi 預設 A；未建／切分支、未 push／PR／merge。 |
| 波次一／任務 1：狀態機＋Vitest | 完成 | `contracts.ts`／`state.ts`、`vitest.audio-lock.config.ts`、`tsconfig.audio-lock.tests.json`、Vitest 3.2.6＋jsdom 26.1.0。 |
| 波次二／任務 2：adapter＋PlayerPort | 完成 | `holodex-adapter.ts`、`players.ts`、fixtures；late-bind、不碰 Twitch global。 |
| 波次二／任務 3：controller＋入口重寫 | 完成 | `controller.ts`（含 panel／iframe 意圖）；重寫 `twitch-audio-lock.ts` 取代 eda5b52 原型（無 mixin／constructor trap／localStorage）。 |
| 波次三／任務 4：options＋bridge | 完成 | `twitchAudioLock` schema；`audio-lock-settings.ts`；`contentScript.ts` 先 bridge 再 inject。 |
| 波次三／任務 5：驗證 | 自動項完成 | 見下方指令結果；人工清單待 Fi／授權者。 |

## 產品 commit（英文訊息）

| SHA | 訊息 |
| --- | --- |
| `b3728bb` | feat(audio-lock): add pure state machine and vitest harness |
| `228c31d` | feat(audio-lock): add Holodex adapter and late-bound player ports |
| `39761cc` | feat(audio-lock): wire controller intent gates and entry rewrite |
| `51f343b` | feat(audio-lock): add options schema and content-script settings bridge |
| `0afae5a` | fix(audio-lock): clear typecheck and scoped lint diagnostics |

（本報告另以獨立 docs commit 提交。）

## 自動驗證結果

環境：Node `v26.12.0`；`npx yarn@1.22.22`；快取僅 worktree `.cache/`。逾時 wrapper：`.cache/run-with-timeout.py`。

| 指令 | 逾時 | 結束碼 | 摘要 |
| --- | --- | --- | --- |
| `yarn typecheck:audio-lock` | 120s | **0** | `tsc --noEmit` 與 `tsc -p tsconfig.audio-lock.tests.json` 皆通過 |
| `node .cache/audio-lock-lint/run.cjs`（scoped） | 120s | **0** | 功能檔案零 error／warning（React version 設定提示為 plugin 警告，非檔案診斷） |
| 既有整合檔 baseline lint（709e963 暫存） | 120s | 1（baseline 與 current 相同） | `holodex-inject.ts` 既有 3× `@typescript-eslint/ban-ts-comment`（`@ts-ignore`）；`options.ts`／`contentScript.ts` 0。**新 hunk 未新增診斷** |
| 既有整合檔 current lint | 120s | 1（同 baseline） | 同上 3 則 ban-ts-comment；無新增 rule |
| `yarn test:audio-lock` | 120s | **0** | **5 files / 49 tests passed** |
| `yarn build:chrome` | 180s | **0** | 產物目錄絕對路徑：`/Users/wuxianyou/orca/workspaces/Holodex-Plus/twitch-audio-lock/dist_chrome` |
| `yarn build:firefox` | 180s | **0** | 產物目錄絕對路徑：`/Users/wuxianyou/orca/workspaces/Holodex-Plus/twitch-audio-lock/dist_firefox` |

Build 抽查：兩端皆有 `manifest.json`、`src/pages/options/index.html`、hashed page inject（`holodex-inject.ts-*.js`）；page inject bundle 無 `webextension-polyfill`／`storage.local`。權限集合與基準一致（未新增 permissions／host）。

Lint 工具僅裝在 `.cache/audio-lock-lint/`（ESLint 8.57.0、parser/plugin 8.18.0 等），**未**加回產品 `package.json`／`yarn.lock`。

## 偏離計畫之處與理由（保守）

1. **Controller 測試覆蓋密度**：計畫列出大量競態／preset／BFCache 案例；本輪以核心路徑為主（poll 搶聲、first-play 阻擋、bootstrap 零 mute、panel microtask gate、grant restore、dispose），其餘列為人工／後續補強，未擴大產品範圍。
2. **Adapter 發現／路由訂閱**：實作契約探測、MutationObserver 合併與 pathname 門檻；Vue Router `afterEach` 以 pageshow／discovery loop 近似，未深入綁定站方 router 私有 API（避免擴大不相容面）。
3. **測試／型別輔助**：controller 暴露 `__*` 測試 hook，僅供 Vitest；不進 extension 行為契約。
4. **無偏離白名單**：未改 `.ref/`、`docs/plans/reviews/`、`docs/plans/prompts/`、CI、`.nvmrc`、manifest 權限；未引入 auto-multiview-layout 程式。

## 尚未完成／需人工測試

計畫「人工測試清單」全部項目（Chrome／Vivaldi／Firefox unpacked）：URL 四 U 初始化、面板第一擊、iframe 焦點、廣告、重連、preset、options×Mute Others、BFCache、不相容降級、SecurityError 對照等。**廣告／重連未覆蓋不得填 PASS。**

上游乾淨 `fi/twitch-audio-lock` 打包（從 709e963 取白名單）依計畫屬未來授權步驟；本輪禁止執行。

## 檔案清單（產品白名單內）

- `src/pages/content/holodex/twitch-audio-lock.ts`（重寫）
- `src/pages/content/holodex/audio-lock/{contracts,state,holodex-adapter,players,controller}.ts`
- `src/pages/content/holodex/audio-lock-settings.ts`
- `src/pages/content/holodex/contentScript.ts`、`holodex-inject.ts`（既有 install 入口保留）
- `src/utils/options.ts`（僅新增 `twitchAudioLock`）
- `tests/audio-lock/*`、`vitest.audio-lock.config.ts`、`tsconfig.audio-lock.tests.json`
- `package.json`／`yarn.lock`（僅 Vitest／jsdom 與 audio-lock scripts）
