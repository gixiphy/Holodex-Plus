VERDICT: REVISE

# twitch-audio-lock 計畫驗收報告（第 2 輪）

- 受驗計畫：`docs/plans/twitch-audio-lock.md` @ 09b7bf27e2819955e946ccef43db8da3220fdeab（含 `0ab5af5` 與 `09b7bf2` 兩筆修訂，對照第 1 輪報告 commit `6015f17`）。
- 本 repo 引用一律 @ 09b7bf27e2819955e946ccef43db8da3220fdeab；`.ref/holodex/` 引用為 HolodexNet/Holodex @ 8c6d0dacbe93f89cd788963e2a63a095b6d3a715。
- 只讀核對，沒有安裝依賴、沒有執行 lint、測試或 build，也沒有 fetch remote。

## 第 1 輪發現逐條狀態

| # | 第 1 輪發現 | 狀態 | 計畫新行號與證據 |
| --- | --- | --- | --- |
| 1 | high：`muted` 缺值 | **已解決**，但衍生新發現 N1 | `docs/plans/twitch-audio-lock.md:35`、`:91`、`:150-162`、`:169`、`:176-177`、`:317`、`:399`、`:406-407`。三態契約、bootstrap／silence 分離、新增格與 preset 規則、`setMuted` 提前返回補呼叫（`:200`），都對得上原始碼：`.ref/holodex/src/components/multiview/VideoCell.vue:92-96`、`:173-178`；`.ref/holodex/src/store/multiview.module.ts:120-129`（`setLayout`／`setLayoutContentById`／`setLayoutContent` 確實存在）、`:168-170`。 |
| 2 | high：microtask 清除授權過早 | **已解決** | `:184-186`、`:318`、`:401`、`:517`。設計改成 window capture 開啟、同一 Event 在 window bubble 關閉、檢查 `eventPhase`、加 0ms 保底，並明令禁止用 microtask 清除。測試要求手動 flush microtask，人工清單要求第一擊就成功。面板 handler 是同步的：`.ref/holodex/src/components/multiview/MediaControls.vue:90-94`、`:192-209`。 |
| 3 | medium：YouTube 新首播政策 | **已解決** | Fi 第 1 題 A／B／C（`:551-554`）；設計（`:175`）、風險（`:537`）、驗收（`:516`）都明寫這是行為改變。 |
| 4 | medium：SDK 全域攔截無實益 | **已解決** | `:128-132`、`:257`、`:306`、`:521`：只做 late-bind，並改成斷言 global／constructor／descriptor 全程沒被改動。和 `.ref/holodex/src/components/player/TwitchPlayer.vue:86`、`:116-122` 一致。 |
| 5 | medium：options aliases 缺失 | **已解決** | `:293-294`（五個 alias、`css: false`）、`:331`（動態 import 真正的 options entry，只 mock polyfill）。alias 對應 `tsconfig.json:19-25` @ 09b7bf27e2819955e946ccef43db8da3220fdeab。 |
| 6 | low：tests 沒有 typecheck | 已解決 | `:290`、`:292`、`:385`。 |
| 7 | low：設定橋接過重 | 部分接受，**反駁成立** | `:233-235` 拿掉了 ready 重試和 revision。保留「讀取期間變更」保護有道理：`Options.get` 是非同步 `storage.local.get`（`src/utils/options.ts:48-51` @ 09b7bf27e2819955e946ccef43db8da3220fdeab）。 |
| 8 | low：重複的 ignore 規則 | 已解決 | `:272`；`.gitignore` 已有 `.cache` 規則。 |

## 上游 PR 要求核對

- **基準與分支事實：** `upstream/dev` = `709e96319bc93965509f83e5f2a897b5d2dc37c7`，本機 `fi/twitch-audio-lock` = `eda5b52c02744978564b927263230a3545c40d86`，origin／upstream remote 也正確（`git rev-parse`、`git remote -v` 確認），與 `:420-424` 相符。
- **風格基準：** `.eslintrc` 的 extends、parser、`no-explicit-any: warn`、沒有 `parserOptions.project`，與 `:68` 相符。`.vscode/settings.json` 是 tabSize 2、Prettier formatter，與 `:69` 相符。repo 沒有 `.prettierrc*`（`:70` 正確）。`.nvmrc` 是 18.17.1，`ci.yml` 是 workflow_dispatch、Node 18、只 build Chrome，與 `:75` 相符。lint script 沒有 type-aware 設定，所以把 tests 與 config 一起 lint 不會出現「不在 project 內」的錯誤。
- **獨立性：** 另一任務的計畫在 `gixiphy/auto-multiview-layout:docs/plans/auto-multiview-layout.md`（`00c261a`）。它的第一個 PR 只改 `contentScript.ts` 和 `options.ts`，不改 `package.json`、`holodex-inject.ts`，測試用 `node:test`、零新依賴（該檔 `:265-270`、`:295`）。本計畫衝突表（`:445-453`）涵蓋的重疊檔正確，scripts 也用 `:audio-lock` 命名空間，沒有產品依賴。
- **打包排除：** `:441` 明確排除 `docs/plans/`（含 reviews、prompts）、`.ref/`、cache 與產物；`:465` 有 `git diff ... -- docs/plans .ref` 必須為空的檢查。
- **PR 描述草稿：** 內容合理，限制寫得誠實，驗證項目沒有預先勾選（`:490-510`）。
- **四段完整度：** 檔案、步驟、測試、驗收條件都在，Fi 決策改成可以直接回答 1A、2A 的格式（`:549-575`）。

## 新發現（依嚴重度排序）

### N1. [medium] bootstrap 期間 U 格的 desired 狀態沒有定義；照通則實作會把收斂後被選的那格也靜音

**位置：** `docs/plans/twitch-audio-lock.md:159-160`、`:169`、`:172`、`:210`。

**問題：** bootstrap（例如四格全 U、active=null）期間，每 1000ms 的 poll 會讀到各格 false。計畫只定義「非 active B 自行回報 false、沒有 token → MUTE_PLAYER」（`:172`），以及「MUTE_PLAYER 只對 desired-muted 的格」（`:210`），但沒說 bootstrap 中 U 格算不算 desired-muted。active=null 時每一格都是「非 active」，照字面會把四格全部用 PlayerPort 壓成靜音。

**後果：** 接下來原生首播的 `muteOthers(self)` 只把被選格從 U 寫成 false（`.ref/holodex/src/store/multiview.module.ts:224-235`）。player 的 `mute` prop 是 `Boolean`、default `false`（`.ref/holodex/src/components/player/PlayerMixin.ts:13-16`），所以 prop 值從 false 到 false 沒有變化，`TwitchPlayer.vue:57-59` 的 watcher 與 `YoutubePlayer.vue:45` 的 `mute: "setMute"` 都不會觸發。被我們壓靜音的被選格不會恢復有聲，下一次 poll 會讀到「active 回報 true」，照 `:173` 進入 silence，結果整頁全靜音。1000ms fallback（`:160`）和面板選取 U 格（`:200` 的補呼叫）也有同樣的「U→false 不觸發 watcher」盲點。

**要求修改：**
1. 明文規定 bootstrap 中的 U／false 格不是 desired-muted，不發 MUTE_PLAYER。
2. 任何讓 U 格成為 active 的路徑（bootstrap 首播、fallback、明確選取），若該 player 已知被我們壓過或讀到 true，要定義怎麼回復有聲。例如允許經由站方路徑先寫 true 再寫 false 觸發 watcher，或明列「被選格若為 muted 則交還 Holodex 原生 setMute」。
3. controller 測試加「bootstrap 期間 poll 不壓 U 格」與「U→false 選取後 player 實際有聲」兩個斷言。fixture 要模擬 Boolean prop default 造成的 watcher 不觸發。

### N2. [medium] 第 8 題預設在 `package.json` 補 `@typescript-eslint`，但沒交代上游曾刻意移除它，也和另一個 PR 的工具選擇不一致

**位置：** `:53`、`:77`、`:290`、`:439`、`:574`。

**事實：** 上游 commit `a5ff269`（"latest"，2024-12-29）把 `@typescript-eslint/eslint-plugin`、`@typescript-eslint/parser` `^7.8.0` 從 `package.json` 刪掉（`git show a5ff269 -- package.json`）。upstream 上還留著未合併的 dependabot 7.18.0 分支。計畫把它說成單純的「依賴缺口」，並在功能 PR 預設補上 `^8.0.0`，再加上 Vitest／jsdom，總共四個 devDependency 和三個 feature 專用 script，外加 lockfile 變動。另一任務的 PR 則是零新依賴、用 `node:test`。上游會在同一段時間收到兩個 PR、兩套不同的測試方式，其中一個還把維護者刪掉的套件加回來，被要求拆掉或退回的風險偏高，正好違背「PR 大小、遵循上游風格」的要求。

**要求修改：**
1. 在背景與第 8 題寫明 `a5ff269` 的移除歷史。
2. lint 套件建議改成預設不進 `package.json`，只在 worktree 的 `.cache` 用臨時安裝驗證 scoped lint（`:77` 已列為備案）。
3. 第 8 題要讓 Fi 看到兩個 PR 的工具選擇差異，讓 Fi 決定要統一（兩個都用 node:test，或兩個都用 Vitest）還是接受不同。

### N3. [low] 打包第 3 步「cherry-pick eda5b52 加產品 SHA 再 squash」繞了遠路，可以改成從已驗證的 tree 直接取白名單檔案

### N4. [low] 單一功能拆成 8 個新模組、約 22 個檔案、1000–1600 行，以這個上游 repo 的規模偏大；可以考慮把 intent 併入 controller、protocol 併入 settings 來縮小 review 面

## 給 Fi 的摘要

第 1 輪的兩個 high（`muted` 缺值、面板授權被 microtask 提早清掉）和三個 medium 都已確實修好，修法對得上 Holodex 原始碼。上游 PR 的基準、白名單、排除 `docs/plans`、和 auto-multiview-layout 的獨立性也都查證無誤。還剩兩個 medium 要修：第一，新的 bootstrap 流程沒說清楚啟動階段要不要壓靜音 U 格，照字面做可能讓整頁啟動後全靜音；第二，計畫預設把上游維護者曾刪掉的 lint 套件加回來，又和另一個 PR 採用不同的測試工具，可能讓上游不好收。這兩點修好後，應該就能交給 Cursor。
