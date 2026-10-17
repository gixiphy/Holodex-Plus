# Twitch audio lock 修正計畫 fix-3：頁面腳本注入失敗

> **For agentic workers:** 執行者是 Cursor，驗收者是 Codex。逐任務實作，步驟用 checkbox（`- [ ]`）追蹤。實作偏離本計畫時寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-4.md` 的「偏離」段落，不回頭改本計畫、主計畫或既有報告。

**Goal：** 讓 `holodex-inject` 頁面腳本在 Chrome 與 Firefox build 都能以傳統 `<script>` 在 holodex.net 真的執行，恢復音訊鎖與 `HOLODEX_PLUS_INSTALLED*`／`ARCHIVE_CHAT_OVERRIDE` 旗標，並加上產物測試和真瀏覽器 e2e 防止回歸。

**Architecture：** 不改注入方式（`src/utils/misc.ts` 的 `inject()` 仍插 `type="text/javascript"`）。在 Vite 建置加一個小 plugin：crxjs 照常輸出 `holodex-inject.ts-*.js` 之後，用 Vite 自己的 `build()` 把同一個入口另外打包成**單一 IIFE、沒有任何 import／export** 的程式碼，覆蓋那個 chunk 的內容。檔名、`web_accessible_resources`、content script 端的引用都不變。

**Tech Stack：** Vite 7.1.11、@crxjs/vite-plugin 2.4.0（皆既有）、Node 內建 `node:test`／`node:vm`、既有 devDependency `jsdom` 26.1.0、Google Chrome（CDP over pipe）。不新增任何 dependency。

**依據：** 主計畫 `docs/plans/twitch-audio-lock.md`（含文末「決定紀錄」）、`docs/plans/twitch-audio-lock-fix-2.md`、驗收 `docs/plans/reviews/twitch-audio-lock-impl-review-3.md`（PASS）、根因證據 `docs/plans/evidence/twitch-audio-lock-fix-3/`（`ROOTCAUSE.md`、`harness/`、`results/`）。

日期：2026-10-17。分支 `gixiphy/twitch-audio-lock`，基準 head 為本計畫的 docs commit（父 commit `3893149`）。

## 問題摘要（給實作者）

1. `src/pages/content/holodex/contentScript.ts:3` 以 `import injectPath from "./holodex-inject?script&module"` 取得頁面腳本檔名，再用 `src/utils/misc.ts:8-15` 的 `inject()` 以**傳統 script**（`el.type = "text/javascript"`）插入頁面。
2. crxjs 的 `?script&module` 產物是 **ESM**。`holodex-inject.ts` 和 content script 端的 `audio-lock-settings.ts` 都 import `./audio-lock/contracts`，Rollup 因此把 contracts 拆成共用 chunk，`dist_*/assets/holodex-inject.ts-*.js` 第一行變成 `import{…}from"./contracts-*.js"`。
3. 瀏覽器以傳統 script 解析 → `SyntaxError: Cannot use import statement outside a module` → 整支頁面腳本沒跑：音訊鎖沒裝、`HOLODEX_PLUS_INSTALLED`／`HOLODEX_PLUS_INSTALLED_V3`／`ARCHIVE_CHAT_OVERRIDE` 都沒設。行為等同沒裝擴充（`results/new.json` 與 `results/none.json` 數字相同）。
4. 協調者只把 contracts 內嵌進頁面腳本的診斷版（`results/newfix.json`）在同一套情境下和 MVP（`results/mvp.json`）結果一致。所以本輪**只修注入產物**，不改音訊鎖邏輯。

## 修法選擇與理由

| 方案 | 做法 | 結論 |
| --- | --- | --- |
| A. 改 module 注入 | `inject()` 改 `el.type = "module"`，靠 `web_accessible_resources` 讓頁面載入 `contracts-*.js` | **不採用** |
| B. 頁面腳本建成獨立 IIFE | 建置時把 `holodex-inject.ts` 另外打包成無 import 的 IIFE，覆蓋 crxjs 的 chunk 內容 | **採用** |
| C. crxjs `?script&iife` | 改 import 後綴 | 不可行：crxjs 2.4.0 `node_modules/@crxjs/vite-plugin/dist/index.mjs:808` 對 iife 直接 `throw new Error("IIFE content scripts are not implemented")` |
| D. 拆開 contracts 讓兩邊不共用 | 複製一份 contracts 或用 query 讓 Rollup 視為不同模組 | 不採用：重複原始碼或依賴 Rollup 行為細節，下次有人在兩邊共用新模組又會壞，而且沒有機制擋 |

採用 B 的理由：

- **跟已驗證的路徑一致**：MVP 和上游 `dev` 分支都是「傳統 script＋單一檔案」，Chrome 與 Firefox 正式版都這樣跑過。B 只讓產物回到這個形狀，`inject()`、manifest、content script 都不用動。
- **Firefox 風險最低**：A 需要 Firefox 允許頁面以 module script 從 `moz-extension://` 再 import 其他 extension 資源（module 走 CORS 模式），這條路在本 repo 沒有人驗證過；B 沒有這個問題。
- **不影響其他功能**：A 會改到共用的 `inject()`，YouTube 聊天室的 `yt-chat/inject.ts` 也會變成 module（延後執行、嚴格模式），這屬於「順手改其他功能」。B 只動 `holodex-inject` 這一個入口。
- **擋得住下次**：A 只要頁面腳本哪天間接 import 到 `misc`／`options` chunk，就會把 `webextension-polyfill` 帶進頁面（在一般網頁裡會直接丟錯）。B 的 IIFE 只含頁面腳本自己的模組圖，加上任務 1 的產物測試，任何 import 都會讓測試失敗。
- **重複 contracts 沒有實際成本**：content script（isolated world）和頁面腳本（main world）本來就各自執行一份程式，共用 chunk 在執行期不會共用模組實體。重複的只是幾 KB 的常數與 parser。

取捨：建置多一次小型 Vite build（每個 target 約 1 秒內）；頁面腳本在建置後不再有 sourcemap（現在 production 也沒有，`__DEV__` 開發模式下這支檔案會沒有 sourcemap，可接受，寫進實作報告）。

## Global Constraints

- 禁止 push、開 PR、merge（不合併任何分支、不碰 remote）、公證（notarize）、sudo；不建立或切換分支。
- 所有寫入限於本 worktree；commit 寫入主 repo 的 Git metadata 屬允許範圍。禁止刪除 worktree 以外的任何東西（Chrome 暫存 profile 也必須建在 worktree `.cache/` 下，見任務 2）。
- 快取：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`；yarn 一律 `npx --yes yarn@1.22.22`，安裝用 `--frozen-lockfile`。
- **不新增 dependency**，`yarn.lock` 不得變動。`package.json` 只允許新增任務 1、2 指定的兩個 `scripts`。
- 產品 commit 訊息只用英文（主計畫決定紀錄的例外），Conventional Commits。
- 不改音訊鎖行為：`src/pages/content/holodex/audio-lock/**`、`twitch-audio-lock.ts`、`holodex-inject.ts`、`audio-lock-settings.ts`、`contentScript.ts`、`src/utils/**` 一律不動。Fi 決定紀錄（2500ms 意圖窗、一次 console.warn、降級政策等）全部維持。
- `docs/plans/evidence/twitch-audio-lock-fix-3/` 是證據，唯讀，不修改。`.ref/` 唯讀。

## 回合與額度上限

- **實作最多 3 輪**（Cursor 實作 → Codex 驗收算 1 輪）。驗收 FAIL 累計 3 次就停止，不開第 4 輪，由協調者把狀況回報 Fi。
- **每輪額度**：Cursor 單輪工作時間上限 90 分鐘；e2e harness 每輪最多執行 8 次（每次本身有 240 秒全域逾時）；`yarn build` 每輪最多 6 次。Codex 單輪驗收上限 60 分鐘、e2e 最多 6 次。超過上限就停在目前狀態寫報告，不硬做。
- 任一輪發現本計畫的修法（方案 B）在 Chrome 或 Firefox 根本不可行，**停下來回報**，不要自行改成方案 A 或其他做法。

## Review Focus

1. **crxjs 之後又改寫 chunk**：plugin 覆蓋內容後，若 crxjs 或其他 plugin 再改動或重新加 import，產物仍會壞 → 任務 1 的產物測試直接檢查最終 `dist_*` 檔案，不檢查中間狀態。
2. **找不到頁面腳本卻「全部通過」**：偵測規則如果失效、掃到 0 個檔案，測試會空轉 → 測試斷言必須找到 `holodex-inject.ts-*.js`（兩個 dist）和 `inject.ts-*.js`（yt-chat）。
3. **IIFE 能解析但執行就丟錯**（例如殘留 `process.env`、`import.meta`、動態 `import(`）→ 測試在 jsdom 真的執行 holodex 頁面腳本，檢查旗標與 handle。
4. **web_accessible_resources 遺漏**：plugin 改寫後 crxjs 少列了某個資源 → 測試檢查 manifest 列出的資源都存在，而且頁面腳本與它被注入的 content script chunk 都在 holodex.net 的 WAR 裡。
5. **真 holodex.net 上的契約檢查或降級意外觸發**（ROOTCAUSE「其他差異」2、4）→ e2e 斷言整段情境中沒有任何 `[Holodex+ AudioLock]` 警告。

---

## 檔案

| 檔案 | 動作 | 用途 |
| --- | --- | --- |
| `custom-vite-plugins.ts` | 修改（新增 export） | 新增 `classicPageScripts()` plugin |
| `vite.config.base.ts` | 修改 | 在 `plugins` 註冊 `classicPageScripts`，只列 `holodex-inject.ts` |
| `tests/build-artifacts/page-scripts.test.mjs` | 新增 | 產物測試（`node:test`），檢查兩個 dist |
| `tests/e2e-browser/audio-lock/run.mjs` | 新增 | 由證據 `harness/run.mjs` 複製後修改（profile 路徑、清理、絕對路徑） |
| `tests/e2e-browser/audio-lock/fakes.js` | 新增 | 由證據 `harness/fakes.js` **原樣**複製 |
| `tests/e2e-browser/audio-lock/compare.mjs` | 新增 | 判定通過條件、輸出和 MVP 並列的表格 |
| `tests/e2e-browser/README.md` | 新增 | 怎麼對 `dist_chrome` 跑、需求、輸出位置 |
| `package.json` | 修改 | 只新增 `scripts.test:artifacts`、`scripts.e2e:audio-lock` 兩行 |
| `docs/plans/reports/twitch-audio-lock-impl-4.md` | 新增 | 實作報告（含 e2e 並列結果） |

**不准改**：上面「Global Constraints」列出的所有 `src/**` 檔案、`manifest.json.ts`、`vite.config.chrome.ts`、`vite.config.firefox.ts`、`vitest.audio-lock.config.ts`、`tsconfig*.json`、`yarn.lock`、`.gitignore`、`tests/audio-lock/**`、`docs/plans/` 下既有檔案、證據資料夾、`.ref/`。

## 步驟

### 任務 1：頁面腳本建成獨立 IIFE＋產物測試

**Interfaces：**
- Produces：`export function classicPageScripts(entries: string[]): Plugin`（`custom-vite-plugins.ts`，`Plugin` 從 `vite` import type）。`entries` 是頁面腳本入口的**絕對路徑**。
- Produces：`yarn test:artifacts` → `node --test --test-timeout=60000 tests/build-artifacts/`。

- [ ] **Step 1：寫產物測試 `tests/build-artifacts/page-scripts.test.mjs`**

  只用 `node:test`、`node:assert/strict`、`node:fs`、`node:path`、`node:vm`、`jsdom`。對 `["dist_chrome", "dist_firefox"]` 各跑一組 `describe`，每個 `test` 帶 `{ timeout: 20000 }`：

  1. `dist_has_manifest`：`<dist>/manifest.json` 存在且可 `JSON.parse`；不存在時 assert 訊息寫「先執行 yarn build」。
  2. `finds_injected_page_scripts`：掃 `<dist>/assets/*.js` 中**非** `-loader` 檔的字串字面值 `/"\/assets\/([^"]+\.js)"/g`（crxjs 對 `?script&module` 輸出的就是這種常數，例如 `const _="/assets/holodex-inject.ts-BjDs9NrB.js"`），收集成「會被注入頁面的腳本」集合。斷言集合裡**恰有一個** `holodex-inject.ts-` 開頭、**恰有一個** `inject.ts-` 開頭的檔案，且每個都存在於磁碟。
  3. `page_scripts_parse_as_classic_script`：對集合中每個檔案 `new vm.Script(code, { filename })` 不丟錯；並斷言原始碼不符合 `/\bimport\s*\(/`、`/\bimport\.meta\b/`、`/^\s*(import|export)[\s{*]/m`。
  4. `page_scripts_are_web_accessible_on_their_site`：manifest `web_accessible_resources` 裡 matches 含 `*://*.holodex.net/*` 的那組 resources 必須包含 holodex-inject 檔；matches 含 `*://*.youtube.com/*` 的那組必須包含 yt-chat `inject.ts-` 檔；所有 WAR 列出的路徑都存在於磁碟。
  5. `holodex_page_script_runs_and_sets_flags`：`new JSDOM("<!doctype html><head></head><body></body>", { url: "https://holodex.net/multiview", runScripts: "outside-only" })`，`dom.window.eval(code)` 執行 holodex-inject 檔，斷言：
     ```js
     assert.equal(w.HOLODEX_PLUS_INSTALLED, true);
     assert.equal(w.HOLODEX_PLUS_INSTALLED_V3, true);
     assert.equal(w.ARCHIVE_CHAT_OVERRIDE, true);
     assert.equal(typeof w.__HDX_AUDIO_LOCK_HANDLE__?.dispose, "function");
     ```
     `finally` 裡呼叫 `w.__HDX_AUDIO_LOCK_HANDLE__?.dispose()` 再 `w.close()`，避免計時器讓 node 不結束。

- [ ] **Step 2：新增 `package.json` script 並確認測試在目前產物上 FAIL**

  `"test:artifacts": "node --test --test-timeout=60000 tests/build-artifacts/"`。

  ```bash
  npx --yes yarn@1.22.22 install --frozen-lockfile
  npx --yes yarn@1.22.22 build
  npx --yes yarn@1.22.22 test:artifacts
  ```
  預期：`page_scripts_parse_as_classic_script` 與 `holodex_page_script_runs_and_sets_flags` 在兩個 dist 都 FAIL（`SyntaxError: Cannot use import statement outside a module`），其餘通過。把失敗摘要貼進實作報告。

- [ ] **Step 3：實作 `classicPageScripts(entries)`（`custom-vite-plugins.ts`）**

  規格：
  - `name: "classic-page-scripts"`、`apply: "build"`、`enforce: "post"`。
  - `configResolved(config)` 保存 `config.root`、`config.mode`、`config.build.minify`、`config.define`。
  - `async generateBundle(_options, bundle)`：對 `bundle` 裡 `type === "chunk"` 且 `facadeModuleId`（去掉 `?` 之後的部分）等於 `entries` 其中一個的 chunk，執行：
    ```ts
    const { build } = await import("vite");
    const result = await build({
      configFile: false, root, mode, define, logLevel: "warn",
      plugins: [tsconfigPaths()],
      build: {
        write: false, emptyOutDir: false, copyPublicDir: false,
        modulePreload: false, sourcemap: false, minify,
        rollupOptions: { input: entry, output: { format: "iife", inlineDynamicImports: true } },
      },
    });
    ```
    從結果取唯一的 chunk 輸出，把 `chunk.code` 換成它的 `code`，並設 `chunk.imports = []`、`chunk.dynamicImports = []`、`chunk.map = null`。
  - `entries` 裡任何一個入口在 bundle 中**找不到**對應 chunk，或內層 build 產生的 chunk 不是恰好 1 個，就 `this.error(...)` 讓建置失敗（不能默默略過）。
  - 只改 `chunk.code`，不改 `fileName`，所以 content script 裡的 `"/assets/holodex-inject.ts-*.js"` 與 WAR 不用動。

- [ ] **Step 4：在 `vite.config.base.ts` 註冊**

  `plugins` 陣列在 `stripDevIcons(isDev)` 後加 `classicPageScripts([resolve(__dirname, "src/pages/content/holodex/holodex-inject.ts")])`。**不列** `yt-chat/inject.ts`：它目前沒有 import，轉成 IIFE 會多出 `"use strict"` 包裝，屬於改動其他功能；產物測試已會擋它將來長出 import。

- [ ] **Step 5：重建並跑產物測試、既有測試**

  ```bash
  npx --yes yarn@1.22.22 build
  npx --yes yarn@1.22.22 test:artifacts
  npx --yes yarn@1.22.22 test:audio-lock
  npx --yes yarn@1.22.22 typecheck:audio-lock
  ```
  預期：`test:artifacts` 兩個 dist 全部 PASS；`test:audio-lock` 仍是 117 passed；typecheck 無錯誤。另外確認 `head -c 120 dist_chrome/assets/holodex-inject.ts-*.js` 開頭是 `(function` 或 `(()=>`，不是 `import`。

- [ ] **Step 6：Commit**

  ```bash
  git add custom-vite-plugins.ts vite.config.base.ts package.json tests/build-artifacts/page-scripts.test.mjs
  git commit -m "fix(build): emit holodex page script as a standalone classic script"
  ```

### 任務 2：真瀏覽器 e2e harness 納入 repo

**Interfaces：**
- Consumes：任務 1 產出的 `dist_chrome`。
- Produces：`node tests/e2e-browser/audio-lock/run.mjs <label> <extensionDir|none> <out.json>`（結束碼：0 跑完、2 例外、3 全域逾時）；`node tests/e2e-browser/audio-lock/compare.mjs <candidate.json> <baseline.json> [<more.json>...]`（候選通過所有條件結束碼 0，否則 1）。

- [ ] **Step 1：複製 harness**

  `fakes.js` 從 `docs/plans/evidence/twitch-audio-lock-fix-3/harness/fakes.js` 原樣複製。`run.mjs` 複製後只改下列幾處（情境、時間、取樣、Fetch 攔截全部不動）：
  1. profile 目錄：`const base = process.env.HPLUS_E2E_TMP ?? path.join(REPO_ROOT, ".cache", "e2e-browser");` `fs.mkdirSync(base, { recursive: true });` `const prof = fs.mkdtempSync(path.join(base, "prof-"));`。`REPO_ROOT` 由 `import.meta.url` 往上三層算出，不用 `process.cwd()`。不得再出現 `/tmp/hplus-repro`。
  2. `done()` 在 kill Chrome 之後 `fs.rmSync(prof, { recursive: true, force: true })`（只刪自己建立的 profile）。
  3. `extDir !== "none"` 時先 `path.resolve(extDir)` 並確認 `manifest.json` 存在，否則寫入 `result.errors` 並以 2 結束。
  4. `CHROME` 預設值維持 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（M5 可直接跑），可用環境變數 `CHROME` 覆蓋。
  5. 輸出檔的父目錄不存在時自動建立。

- [ ] **Step 2：寫 `compare.mjs`**

  讀入多個 result JSON，對**第一個（候選）**檢查以下條件，全部成立才結束碼 0：
  ```js
  c.flags.v3 === true && c.flags.newHandle === true
  c.afterBothPlay.audible === "YT"
  c.afterSelfUnmute1.audible === "YT"
  c.afterLaggedRepeats.audible === "YT"
  c.everStolenDuringLag === 0
  c.ytMutedSamples === 0 && c.samples >= 150
  c.afterUserUnmuteTwitch.audible === "TW"
  result.errors.length === 0
  !result.console.some(([, type, text]) => /SyntaxError|Cannot use import statement/.test(text))
  !result.console.some(([, type, text]) => type === "warning" && text.includes("[Holodex+ AudioLock]"))
  ```
  （`c = result.checks`。）並在 stdout 印一張 Markdown 表，欄為各檔的 `label`，列為：頁面腳本有跑（`flags.v3`）、Twitch 晚播後、自己取消靜音後、延遲＋重複 6 次後、延遲期間被搶次數、YouTube 被靜音取樣／總取樣、使用者點 Twitch 後、AudioLock 警告數、判定。

- [ ] **Step 3：寫 `tests/e2e-browser/README.md`**

  內容要有：需求（Google Chrome 安裝在 `/Applications`、可連 holodex.net、Node 20+）；它會開 headless Chrome、以 CDP `Extensions.loadUnpacked` 載入 unpacked 擴充、打開真 holodex.net/multiview、把 Twitch embed 與 YouTube iframe API 換成 `fakes.js`；情境說明（下方「測試」段的五個階段）；不屬於 `test:audio-lock`、不會被 Vitest 收進來；profile 放在 `.cache/e2e-browser/`（已被 `.gitignore` 的 `.cache` 忽略）且結束會刪除；不碰使用者的 Chrome／Vivaldi profile。附上「測試」段的指令。

- [ ] **Step 4：新增 `package.json` script**

  `"e2e:audio-lock": "node tests/e2e-browser/audio-lock/run.mjs fix dist_chrome .cache/e2e-browser/fix.json && node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix.json docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json"`

- [ ] **Step 5：跑 e2e（見「測試」段），把 compare 表貼進實作報告**

- [ ] **Step 6：Commit**

  ```bash
  git add tests/e2e-browser package.json
  git commit -m "test(e2e): add headless Chrome audio lock harness for holodex.net"
  ```

### 任務 3：實作報告

- [ ] 寫 `docs/plans/reports/twitch-audio-lock-impl-4.md`：修法摘要、任務 1 Step 2 的 FAIL 摘要與 Step 5 的 PASS 摘要、e2e 並列表（fix／MVP 現場重跑／MVP 證據檔／none）、偏離（若有）、未完成的人工項目。
- [ ] Commit：`git add docs/plans/reports/twitch-audio-lock-impl-4.md && git commit -m "docs: add twitch-audio-lock implementation report 4"`

## ROOTCAUSE「其他差異」四點的處置

結論：**四點這次都不做**。「不會被搶走」的必要條件是頁面腳本真的有跑；診斷版只修注入就已在同一套情境與 MVP 結果相同（`results/newfix.json`：YouTube 被靜音取樣 0/168、延遲期間被搶 0 次、使用者點擊後切到 Twitch）。這四點要麼和 Fi 的決定紀錄衝突，要麼沒有證據顯示會造成失敗。為了讓它們如果在真站觸發時看得見，e2e 加了「整段情境不得出現 `[Holodex+ AudioLock]` 警告」的條件（降級、契約失配都會發這個警告）。

| # | 差異 | 處置 | 理由 |
| --- | --- | --- | --- |
| 1 | MVP 包住 `window.Twitch.Player`，建構時預設 `muted:true` | 不做 | 主計畫第 140 行明定「不攔截建構、不改 `window.Twitch`／`Twitch.Player`」，驗收回應第 2 版第 4 項也已刪除 constructor Proxy。建構預設靜音還會改變只有一格 Twitch 時的原生行為。診斷版沒有它也通過。殘留風險：READY 前的極短時間 Twitch 可能出聲，若 Fi 實測在意再另開計畫。 |
| 2 | degraded 放棄機制（連續 3 次 mute 未生效等就退回原生） | 不改，加 e2e 監測 | 這是主計畫第 101、211 行的安全閥設計，Fi 題 6 已決定只 warn 一次。診斷版在「2.5 秒延遲＋每 4 秒自取消靜音 6 次」下沒有降級。e2e 以「無 AudioLock 警告」把它變成可觀察條件；若 Fi 真站使用出現 `player-mute-did-not-settle` 等代碼，另開修正計畫調整門檻，不在本輪動。 |
| 3 | 意圖窗 2.5 秒（MVP 10 秒） | 不做 | Fi 決定紀錄第 4 題 A 明定 2500ms。e2e 的「使用者點 Twitch 並取消靜音」階段在 2500ms 內完成，診斷版已正確切換。 |
| 4 | 嚴格契約檢查（cellContent、twPlayer/ytPlayer、iframe host 等） | 不改，加 e2e 監測 | 診斷版在真 holodex.net 的 VideoCell 結構上 `newHandle` 為 true、沒有契約失配警告。契約檢查是主計畫「不留半套 patch」的安全前提。e2e 的警告條件會抓到真站結構失配。 |

## 測試

### 自動（每輪實作與驗收都要跑）

```bash
export npm_config_cache=$PWD/.cache/npm YARN_CACHE_FOLDER=$PWD/.cache/yarn TMPDIR=$PWD/.cache/tmp
mkdir -p "$TMPDIR"
npx --yes yarn@1.22.22 install --frozen-lockfile
npx --yes yarn@1.22.22 build                 # 產生 dist_chrome 與 dist_firefox
npx --yes yarn@1.22.22 test:artifacts        # 任務 1，node:test，每個 test 20 秒、整體 60 秒逾時
npx --yes yarn@1.22.22 test:audio-lock       # 既有 117 tests，不得減少或變紅
npx --yes yarn@1.22.22 typecheck:audio-lock
```

### 真瀏覽器 e2e（M5，需要網路連到 holodex.net）

情境和 MVP 證據完全相同，由 `run.mjs` 執行：
1. 真 holodex.net/multiview，一格 YouTube（`ytFAKE00001`）＋一格 Twitch（`fakechannel`），Mute Others 開。
2. YouTube 先播，Twitch 晚 3 秒播。
3. Twitch 自己取消靜音 1 次（沒有使用者輸入）。
4. Twitch 靜音延遲 2.5 秒，並每 4 秒自己取消靜音，共 6 次，再觀察 5 秒。
5. 以 CDP 滑鼠真的點進 Twitch 播放器，接著 Twitch 取消靜音（應切換到 Twitch）。

```bash
mkdir -p .cache/e2e-browser
node tests/e2e-browser/audio-lock/run.mjs fix  dist_chrome .cache/e2e-browser/fix.json
node tests/e2e-browser/audio-lock/run.mjs mvp  /Applications/Extensions/holodex-plus-audiolock-chrome .cache/e2e-browser/mvp.json
node tests/e2e-browser/audio-lock/run.mjs none none .cache/e2e-browser/none.json
node tests/e2e-browser/audio-lock/compare.mjs .cache/e2e-browser/fix.json .cache/e2e-browser/mvp.json \
  docs/plans/evidence/twitch-audio-lock-fix-3/results/mvp.json .cache/e2e-browser/none.json
```

- `compare.mjs` 結束碼 0 才算 fix 通過；`none` 欄位應呈現 Twitch 搶走（作為 harness 本身有效的對照組）。
- MVP 目錄不存在時，跳過現場 MVP 那一行，改以證據檔 `results/mvp.json` 並列，並在報告註明。
- 同一 build 連跑時偶發的 holodex.net 自身錯誤（GA 連線失敗、vue-i18n 警告）不算失敗；`run.mjs` 結束碼 2／3 才是 harness 失敗，可重跑，計入每輪 e2e 次數上限。

### Firefox

- 自動：`test:artifacts` 對 `dist_firefox` 跑同樣的解析與 jsdom 執行測試（兩份 build 的頁面腳本產物必須都通過）。
- 人工（Fi，不阻擋 Codex 驗收）：Firefox `about:debugging` → 載入 `dist_firefox/manifest.json` → 開 holodex.net/multiview，DevTools console 執行 `window.HOLODEX_PLUS_INSTALLED_V3`，應為 `true`，console 不得有 `Cannot use import statement`。

## 驗收

Codex 驗收時全部條件都要成立才 PASS：

1. **範圍**：`git diff --stat 3893149..HEAD` 只出現「檔案」表中的檔案（加本計畫 docs commit 與證據資料夾）；`src/**`、`yarn.lock`、manifest、`vite.config.chrome.ts`／`vite.config.firefox.ts`、`tests/audio-lock/**`、證據資料夾內容無變動；`package.json` 的 diff 只有兩行 scripts。沒有新增 dependency。
2. **產物**：乾淨 `yarn build` 後，`dist_chrome` 與 `dist_firefox` 的 `holodex-inject.ts-*.js` 都不以 `import` 開頭、可被 `vm.Script` 解析；`yarn test:artifacts` 全部 PASS。驗收者另外在 `.cache` 用一份把 plugin 註冊拿掉的暫時設定重建，確認 `test:artifacts` 會 FAIL（證明測試有抓力），之後還原，不提交。
3. **Holodex+ 既有頁面功能恢復**：jsdom 測試與 e2e 的 `flags.v3` 都證明 `HOLODEX_PLUS_INSTALLED`、`HOLODEX_PLUS_INSTALLED_V3`、`ARCHIVE_CHAT_OVERRIDE` 已設、`__HDX_AUDIO_LOCK_HANDLE__` 存在；`console` 有 `[Holodex+] Activated`。
4. **鎖得住（和 MVP 相同情境）**：`fix.json` 經 `compare.mjs` 結束碼 0，即：
   - Twitch 晚播後、Twitch 自己取消靜音 1 次後、靜音延遲 2.5 秒並每 4 秒自己取消靜音共 6 次後，**YouTube 一直保有聲音、Twitch 被壓回靜音**（三個檢查點 `audible === "YT"`）；
   - **YouTube 被靜音的取樣為 0**（`ytMutedSamples === 0`，總取樣 ≥ 150），延遲期間被搶次數 0；
   - **使用者真的點進 Twitch 並取消靜音時切換到 Twitch**（`afterUserUnmuteTwitch.audible === "TW"`）；
   - 整段沒有 `SyntaxError` 與任何 `[Holodex+ AudioLock]` 警告。
5. **和 MVP 並列**：驗收報告附上 `compare.mjs` 輸出的表格，至少含 fix、MVP（現場重跑；若 M5 沒有 MVP 目錄則註明並用證據檔）、MVP 證據檔、none 四欄，fix 各列與 MVP 相同。
6. **既有測試**：`test:audio-lock` 117 passed、`typecheck:audio-lock` 無錯誤。
7. **硬性規則**：沒有 push、PR、merge、公證、sudo；`.cache/e2e-browser/` 下沒有殘留 `prof-*` 目錄；worktree 外沒有新檔案。

驗收報告寫到 `docs/plans/reviews/twitch-audio-lock-impl-review-4.md`，結尾 `VERDICT: PASS` 或 `VERDICT: FAIL`。Firefox 真機與 Fi 在 M1 Vivaldi 的人工確認列為交付後人工項，不由 Codex 宣稱完成。
