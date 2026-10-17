# Twitch audio lock 修正計畫 fix-2

> 執行者：Cursor。依據：主計畫 `docs/plans/twitch-audio-lock.md`（含文末「決定紀錄」）、上一份修正計畫 `docs/plans/twitch-audio-lock-fix-1.md`，以及第 2 輪驗收報告 `docs/plans/reviews/twitch-audio-lock-impl-review-2.md`（受驗 head `445f43f7bc2b8c6d78657043cd27ab31a10d2a7e`，VERDICT: FAIL，2 high、3 medium）。這份計畫只修正這五項。主計畫和 fix-1 的規格繼續有效；這裡只寫「怎麼改才符合它們」，不重新定義產品行為。

日期：2026-10-17。工作分支 `gixiphy/twitch-audio-lock`，基準 head `c2625b4`。

**Goal：** 讓 PlayerPort 用 Holodex 真實存在的 READY 結構綁定，設定重送保持冪等，路由監聽在音訊 session 降級後仍存活，Mute Others 關閉不再觸發 discovery timeout，已 ready 但 SDK 缺 method 時依契約降級。

**Architecture：** readiness 判定從「讀 player component 的 `ready` 欄位」改成「player component 的 Vue `ready` 事件（可撤銷）＋父 VideoCell 的 `twPlayer`／`ytPlayer` late-bind 檢查」，全部收在 `players.ts`。controller 把路由 timer 從 `Session` 移到 controller 層級，`setEnabled` 同值直接返回，找到合法 store 後不論 Mute Others 開關都建立 session（wrapper 在關閉時已經會委派原方法）。

**Tech Stack：** TypeScript、Vitest 3.2.6 + jsdom 26.1.0、Vite（既有）。

## 硬性規則與範圍

- 禁止 push、開 PR、merge、公證（notarize）、sudo；不建立或切換分支；不刪除 worktree 以外的任何東西。所有寫入限於本 worktree；commit 寫入主 repo 的 `.git`（iCloud 路徑）屬允許範圍。
- `.ref/` 唯讀，不修改、不 stage、不 commit。fixture 只能**對照** `.ref` 的結構寫，不複製 `.ref` 原始碼（主計畫 fixtures 列的規則）；在註解中引用 `檔案:行號` 是允許的。
- 快取放在 worktree：`npm_config_cache=$PWD/.cache/npm`、`YARN_CACHE_FOLDER=$PWD/.cache/yarn`、`TMPDIR=$PWD/.cache/tmp`。yarn 一律 `npx --yes yarn@1.22.22`。`.cache/` 內的 probe 只能參考，正式回歸測試寫進 `tests/audio-lock/`。
- 實作中如果必須偏離本計畫，寫進實作報告 `docs/plans/reports/twitch-audio-lock-impl-3.md` 的「偏離」段落，不要回頭改計畫、主計畫或既有報告。

### 檔案白名單（只能改這些）

| 檔案 | 用途 |
| --- | --- |
| `src/pages/content/holodex/audio-lock/players.ts` | 問題 1、5：readiness 判定、mismatch 回報 |
| `src/pages/content/holodex/audio-lock/controller.ts` | 問題 1、2、3、4、5：`ensurePort` 傳 cell、`setEnabled` 冪等、路由 timer、`tryDiscover` |
| `src/pages/content/holodex/audio-lock/state.ts` | 問題 2：`ENABLE` 冪等 |
| `src/pages/content/holodex/audio-lock/contracts.ts` | 只有在型別必須調整時才改（預期不用） |
| `src/pages/content/holodex/audio-lock/holodex-adapter.ts` | 只有在 `CellBinding` 型別必須調整時才改（預期不用；`binding.cell` 已存在） |
| `tests/audio-lock/fixtures.ts` | 改成上游形狀 |
| `tests/audio-lock/players.test.ts`、`controller.test.ts`、`state.test.ts`、`adapter.test.ts` | 回歸測試與既有測試配合新 fixture 的修改 |

### 不准改的檔案

`package.json`、`yarn.lock`、`vitest.audio-lock.config.ts`、`tsconfig*.json`、manifest、`vite.config.*`、`src/utils/options.ts`、`src/pages/content/holodex/contentScript.ts`、`src/pages/content/holodex/holodex-inject.ts`、`src/pages/content/holodex/twitch-audio-lock.ts`、`src/pages/content/holodex/audio-lock-settings.ts`、`tests/audio-lock/settings.test.ts`、`docs/plans/` 下既有的所有檔案、`.ref/` 全部。不新增產品模組、測試檔、依賴或權限。

## 上游真實結構（READY 與 SDK 參考）

以下行號全部來自 `.ref/holodex`（commit `8c6d0da`）。實作與 fixture 都以這張表為準。

| 事實 | 出處 |
| --- | --- |
| PlayerMixin 的 `data()` 只有 `player: {}`、`retryForMengen`、`updateTimer`，**沒有任何 `ready` 布林欄位** | `src/components/player/PlayerMixin.ts:27-35` |
| READY 事件的唯一來源：`playerReady(player)` 套用 mute prop、`initListeners()`，然後 `this.$emit("ready", player)` | `PlayerMixin.ts:43-48`（emit 在 `:46`） |
| Twitch：component 的 `player` 初值是 `{}`；script 載入後才 `this.player = new window.Twitch.Player(...)`，也就是 **SDK instance 早於 READY 存在** | `src/components/player/TwitchPlayer.vue:40-43`、`:86` |
| Twitch：SDK 的 `"ready"` 事件呼叫 `this.playerReady(this.player)`，所以 READY 帶的參數就是 component 的 `player` 本身 | `TwitchPlayer.vue:92-95` |
| Twitch 公開 method：`isMuted()` → `player.getMuted()`，`setMute(v)` → `player.setMuted(v)` | `TwitchPlayer.vue:116-122` |
| YouTube：`mounted()` 裡 `this.player = player(this.elementId, …)`（youtube-player wrapper，method 回傳 Promise），**同樣早於 READY 存在** | `src/components/player/YoutubePlayer.vue:53-67` |
| YouTube：wrapper 的 `"ready"` 呼叫 `this.playerReady(e.target)`，READY 帶的是**原始 YT.Player（`e.target`），不是** component 的 `player` | `YoutubePlayer.vue:69` |
| YouTube 公開 method：`setMute` → `mute()`／`unMute()`，`isMuted()` → `player.isMuted()` | `YoutubePlayer.vue:104-107`、`:117-119` |
| YouTube template 是 `<div><div :id="elementId" /></div>`，iframe 生成在 component `$el` 之內；Twitch template 是 `<div :id="elementId" />`，embed iframe 也在 `$el` 之內 | `YoutubePlayer.vue:1-3`、`TwitchPlayer.vue:1-3` |
| VideoCell 以 `ref="player"` 掛 player component，並以 `@ready="onReady"` 監聽 READY；Twitch 沒有 `:key`，YouTube 有 `:key="cellContent.id"`（換影片會重建 component） | `src/components/multiview/VideoCell.vue:11-25`（`@ready` 在 `:18`）、`:27-49`（`:key` 在 `:30`、`@ready` 在 `:39`） |
| **SDK 參考掛在父 VideoCell，不在 player component**：`data()` 有 `ytPlayer: null`、`twPlayer: null` | `VideoCell.vue:79-80` |
| `onReady(player)`：Twitch 時 `this.twPlayer = player`，否則 `this.ytPlayer = player` | `VideoCell.vue:210-216` |
| `cellContent` 變更時只把**另一個 provider** 的參考設成 null；同 provider 換片（YouTube `:key` 重建）時舊 `ytPlayer` 會殘留到新 READY 為止 | `VideoCell.vue:134-139` |
| `manualCheckMuted()` 透過 `$refs.player.isMuted()` 再呼叫 `setMuted` | `VideoCell.vue:223-227` |
| TwitchPlayer 是 async component，`$refs.player` 在載入前可能不存在（正常 pending） | `VideoCell.vue:72` |

由此得出 readiness 規則（取代現有 `isReady: () => comp.ready === true`）：

1. **事件路徑**：在 player component 上 `$on("ready", listener)`；listener 被呼叫就代表 PlayerMixin.ts:46 已經 emit，記 `readySignal = true`。dispose 時 `$off("ready", listener)`。listener 不依賴 VideoCell 的 `onReady` 是否先跑（Vue 2 依註冊順序呼叫，VideoCell 的 template listener 通常較早，但不能依賴）。
2. **late-bind 路徑**（READY 早於我們安裝）：
   - Twitch：`cell.twPlayer` 是 object，而且 `cell.twPlayer === playerComponent.player`（TwitchPlayer.vue:94 + VideoCell.vue:213；Vue 2 就地 observe，同一物件，主計畫第 141 行）。
   - YouTube：`cell.ytPlayer` 是 object，`typeof cell.ytPlayer.getIframe === "function"`，而且 `playerComponent.$el.contains(cell.ytPlayer.getIframe())`。iframe 不在目前 component 的 `$el` 內，就代表是 `:key` 重建前殘留的舊 `ytPlayer`（VideoCell.vue:30、:134-139），判定為**尚未 ready**，等待新 component 的 READY 事件。整段包在 try/catch 裡，例外視為尚未 ready。`getIframe` 是 YT IFrame API 的公開 method；不讀 `contentWindow`、不讀私有欄位。
3. **綁定對象**不變（主計畫第 138-146 行）：Twitch 綁 `playerComponent.player` 的 `getMuted`／`setMuted`；YouTube 綁 `playerComponent.player`（wrapper）的 `isMuted`／`mute`／`unMute`。`cell.ytPlayer`（原始 YT.Player）只用來判定 late-bind，不呼叫它的 mute 類 method。
4. **不存在的東西不能用**：不讀 `playerComponent.ready`、`playerComponent.twPlayer`、`playerComponent.ytPlayer`（這三個欄位上游都沒有），也不讀 SDK 私有 ready 欄位。

## 發現與修正對照

| 報告項目 | 任務 | 回歸測試（拿掉修正就會失敗） |
| --- | --- | --- |
| [high] 1 READY 判定依賴不存在的 `player.ready` | 任務 1、2 | `fixture_matches_upstream_player_shape`、`binds_on_vue_ready_event_without_ready_field`、`late_bind_twitch_requires_cell_twPlayer_identity`、`late_bind_youtube_rejects_stale_cell_ytPlayer`、`upstream_shape_ready_event_binds_and_guards`、`upstream_shape_late_bind_guards` |
| [high] 2 重送 `enabled=true` 讓 session 卡在 discovering | 任務 4 | `enable_is_idempotent_when_already_enabled`、`duplicate_enable_keeps_guard_active` |
| [medium] 3 degraded 卸載連路由監聽一起取消 | 任務 5 | `degraded_route_reentry_recovers`、`route_watch_released_on_disable_and_dispose`、`non_multiview_start_waits_for_route` |
| [medium] 4 啟動時 Mute Others 關閉被當成 root 沒找到 | 任務 6 | `initial_mute_others_off_has_no_discovery_timeout` |
| [medium] 5 已 ready、SDK 存在但缺必要 methods 不降級 | 任務 3 | `ready_instance_missing_methods_reports_mismatch`、`ready_sdk_missing_methods_degrades` |

## Review Focus

這些情況規格隱含、最容易在真機出錯，各自的測試已放進負責的任務：

1. YouTube 同 provider 換片（`:key` 重建）時殘留舊 `cell.ytPlayer`：新 port 不能把舊參考當成 ready → 任務 1 `late_bind_youtube_rejects_stale_cell_ytPlayer`。
2. 我們的 `$on("ready")` 比 VideoCell 的 `@ready` 先註冊（`cell.twPlayer` 還是 null）：仍要綁定 → 任務 1 `ready_event_binds_even_before_cell_onReady`。
3. Twitch script 尚未載入（component `player` 是 `{}`、沒 READY）：只能是 not-ready，不能誤判為缺 method → 任務 3 `ready_instance_missing_methods_reports_mismatch` 的負向斷言。
4. 已 degraded 時再收到 `setEnabled(true)`：維持 latch，不偷偷恢復 → 任務 4 `duplicate_enable_keeps_degraded_latch`。
5. 從非 multiview 頁面開始、之後 SPA 進入 `/multiview`：不能先跑完 120 秒 root-timeout 再永久降級 → 任務 5 `non_multiview_start_waits_for_route`。

---

## 任務

每個任務先寫測試、跑過確認 FAIL，再實作到 PASS（TDD）。單檔測試指令（120 秒逾時）：

```sh
python3 .cache/run-with-timeout.py 120 npx --yes yarn@1.22.22 test:audio-lock tests/audio-lock/<file>.test.ts
```

時間一律用 `vi.advanceTimersByTimeAsync(明確毫秒數)` 推進，禁止 `runAllTimers()`／`runOnlyPendingTimers()` 迴圈。每個案例 `afterEach` 都要 `handle.dispose()`、`vi.useRealTimers()`、清 DOM（沿用既有慣例）。

### 任務 0：準備

- [ ] 確認分支是 `gixiphy/twitch-audio-lock`、工作樹乾淨（`.cache/` 未追蹤可忽略）。
- [ ] 確認 `.cache/run-with-timeout.py`、`.cache/audio-lock-lint/run.cjs` 存在（不提交）。
- [ ] 跑一次 `test:audio-lock` 當 baseline：預期 5 files、101 tests 全 PASS。

### 任務 1：fixture 改成上游形狀＋READY 判定（問題 1）

**Files:**
- Modify: `tests/audio-lock/fixtures.ts`（`FakePlayerComponent`、`createFakePlayerComponent`、`fireReady`、`FakeVideoCell`、`createFakeVideoCell`、`addFakeCell`、`replacePlayer`、`replaceCellContent`、`createYoutubeSdk`）
- Modify: `src/pages/content/holodex/audio-lock/players.ts`（`PlayerBinding`、`createPlayerPort`、`tryBind`）
- Modify: `src/pages/content/holodex/audio-lock/controller.ts:475-520`（`ensurePort` 的 `playerBinding`）
- Test: `tests/audio-lock/players.test.ts`、`controller.test.ts`、`adapter.test.ts`

**Interfaces:**
- Produces（`players.ts`）：

  ```ts
  export type PlayerBinding = {
    identity: CellIdentity;
    /** Parent VideoCell: holds twPlayer/ytPlayer (VideoCell.vue:79-80, :210-216). */
    cell: { twPlayer?: unknown; ytPlayer?: unknown };
    /** $refs.player: TwitchPlayer/YoutubePlayer (PlayerMixin). */
    playerComponent: {
      player?: unknown;
      $el?: Element;
      $on?: (event: string, cb: (...args: unknown[]) => void) => void;
      $off?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
    provider: "youtube" | "twitch";
    onReady?: () => void;
    onContractMismatch?: () => void; // 任務 3 使用
  };
  ```

  移除 `isReady`，也移除 `playerComponent.twPlayer`／`playerComponent.ytPlayer` 型別欄位。`BoundPlayerPort` 不變。
- Produces（`fixtures.ts`）：
  - `createFakePlayerComponent(provider, sdk, opts?: { sdkLoaded?: boolean }): FakePlayerComponent`。
  - `fireReady(comp: FakePlayerComponent): void`。
  - `createFakeVideoCell({ …, readyBeforeInstall?: boolean })`，預設 `true`。
  - `addFakeCell(env, { …, readyBeforeInstall?: boolean })`，取代原本的 `ready?: boolean`。
  - `youtubeRawFor(comp: FakePlayerComponent): FakeYtRaw | null`（test-only 存取器，資料放在模組內 `WeakMap`，不掛在 component 上）。

- [ ] **Step 1：改 fixture 形狀**

  fixtures.ts 檔頭加一段註解區塊 `// Upstream shape (.ref/holodex @ 8c6d0da) — keep in sync:`，逐行列出上面「上游真實結構」表格中的 `檔案:行號`，並寫明「本檔的 player component 不得有 `ready`、`twPlayer`、`ytPlayer` 欄位；SDK 參考只在 VideoCell 上」。

  形狀規則：
  - `FakePlayerComponent`：刪除 `ready`、`twPlayer`、`ytPlayer`。新增 `$el: HTMLElement`（一個 div，裡面放一個 iframe：Twitch `src = "https://player.twitch.tv/?channel=<id>&parent=localhost"`，YouTube `src = "https://www.youtube.com/embed/<id>"`），並由 `createFakeVideoCell` append 到 cell `$el` 裡（adapter 的 iframe hostname 檢查仍會通過）。`$on`／`$off` 的 callback 型別改成 `(...args: unknown[]) => void`。
  - `player` 欄位：Twitch `sdkLoaded === false` 時是 `{}`（PlayerMixin.ts:31／TwitchPlayer.vue:41），否則是 fake Twitch SDK（TwitchPlayer.vue:86，早於 READY）。YouTube 一律是 fake wrapper SDK（YoutubePlayer.vue:60）。
  - YouTube 另外建立 `FakeYtRaw = { getIframe(): HTMLIFrameElement }`，回傳上述 iframe；用 `WeakMap<FakePlayerComponent, FakeYtRaw>` 保存，透過 `youtubeRawFor` 取得。
  - `fireReady(comp)`：依 PlayerMixin.ts:46 呼叫 `comp.listeners.ready` 中每個 callback，參數 Twitch 是 `comp.player`（TwitchPlayer.vue:94），YouTube 是 `youtubeRawFor(comp)`（YoutubePlayer.vue:69）。不設定任何欄位。
  - `FakeVideoCell`：新增 `twPlayer: unknown | null`、`ytPlayer: unknown | null`（初值 null，VideoCell.vue:79-80）與 `onReady(player: unknown): void`（照 VideoCell.vue:210-216）。`createFakeVideoCell` 在建立 cell 時立刻 `player.$on("ready", cell.onReady)`（模擬 template `@ready`，VideoCell.vue:18/:39，先於 controller 註冊）。`readyBeforeInstall !== false` 時在接線完成後呼叫 `fireReady(player)`。
  - `replaceCellContent`：同 provider 的 YouTube 換片要建立**新的** player component（模擬 `:key`），且**不清** `cell.ytPlayer`；換成另一個 provider 時，照 VideoCell.vue:138-139 把另一邊的參考設成 null。`replacePlayer` 建立新 component，不改 cell 的參考。
  - 既有測試裡的 `createFakePlayerComponent(p, sdk, true|false)`、`addFakeCell({ ready })`、`c0.$refs.player!.ready = true`（controller.test.ts:694）、`isReady: () => comp.ready`（players.test.ts 多處）全部改成新 API：not-ready 用 `readyBeforeInstall: false`，ready 用 `fireReady(...)`。players.test 直接呼叫 `createPlayerPort` 時，用一個 `{ twPlayer: null, ytPlayer: null, onReady }` 形狀的 cell（可抽成測試檔內的 `fakeCellFor(comp)` helper，同樣先註冊 `$on("ready")`）。

- [ ] **Step 2：寫失敗的測試**

  `players.test.ts`：

  | 測試名稱 | 斷言 |
  | --- | --- |
  | `fixture_matches_upstream_player_shape` | Twitch 與 YouTube 各一次：`Object.prototype.hasOwnProperty.call(comp, k)` 對 `"ready"`、`"twPlayer"`、`"ytPlayer"` 都是 false；cell 有 `twPlayer`、`ytPlayer` 且 READY 前都是 null；`fireReady` 後 Twitch `cell.twPlayer === comp.player`，YouTube `cell.ytPlayer === youtubeRawFor(comp)` 且 `!== comp.player`，`comp.$el.contains(cell.ytPlayer.getIframe())`。測試上方註解引用 `PlayerMixin.ts:27-35,46`、`VideoCell.vue:79-80,210-216`、`YoutubePlayer.vue:69`。 |
  | `binds_on_vue_ready_event_without_ready_field` | 兩個 provider：`readyBeforeInstall: false` 建立 port → `readMuted()` 是 `not-ready`，SDK 讀寫計數 0；`fireReady(comp)` → `readMuted()` 是 `known`，`isBound() === true`；`dispose()` 後 `comp.listeners.ready` 不再包含 port 的 listener。 |
  | `late_bind_twitch_requires_cell_twPlayer_identity` | READY 早於建立 port（`readyBeforeInstall: true`）→ 立即 bound。另一案例把 `cell.twPlayer` 設成另一個物件 → `not-ready`；再設成 `null` → `not-ready`。 |
  | `late_bind_youtube_rejects_stale_cell_ytPlayer` | YouTube READY 後用 `replaceCellContent` 同 provider 換片（新 component，`cell.ytPlayer` 仍是舊 raw）→ 新 port `not-ready`、新 SDK 讀寫計數 0；對新 component `fireReady` → bound。另一案例 `getIframe` 丟例外 → `not-ready`，沒有未捕捉例外。 |
  | `ready_event_binds_even_before_cell_onReady` | 先建立 port、再讓 cell 註冊 `$on("ready")`（反轉註冊順序），`fireReady` 時 port listener 先執行、`cell.twPlayer` 還是 null → 仍然 bound。 |

  `controller.test.ts`：

  | 測試名稱 | 斷言 |
  | --- | --- |
  | `upstream_shape_ready_event_binds_and_guards` | 重現 probe 6：A Twitch `muted: false`、B Twitch `muted: true`，全部 `readyBeforeInstall: false`；`setEnabled(true)` 後對每個 component `fireReady`，推進 0ms；`__ports` 每個 `isBound() === true`；B 的 `rawMuted = false` 再 `await cell.manualCheckMuted()` → B 的 `rawMuted === true`、active 仍是 A。YouTube 版本再跑一次。 |
  | `upstream_shape_late_bind_guards` | 同上但 `readyBeforeInstall: true`（READY 早於 controller 安裝）：不再呼叫 `fireReady`，結果相同。 |

- [ ] **Step 3：確認 FAIL**

  跑 `players.test.ts`、`controller.test.ts`。預期：上表新案例 FAIL（`not-ready`／`isBound false`／`rawMuted false`），原因是 `isReady` 仍讀 `comp.ready`。**把任務 1 的產品修正拿掉時，這些測試必須失敗**；實作報告要寫出實際失敗訊息摘要。

- [ ] **Step 4：實作 `players.ts`**

  - 刪除 `binding.isReady` 的所有使用。新增模組內函式 `lateBindReady(binding: PlayerBinding): boolean`，依「上游真實結構」的規則 2 實作（Twitch identity 比較；YouTube `getIframe` 包含檢查，try/catch）。
  - `createPlayerPort` 內新增 `let readySignal = false`。`tryBind()`：`disposed` → false；已綁 → true；`!(readySignal || lateBindReady(binding))` → false；取 `instance = playerComponent.player`，不是 object → false；依 provider 呼叫既有 `bindTwitch`／`bindYoutube`。刪除舊的 `tw !== instance`／`yt === undefined` 判斷。
  - 建立 port 時：`tryBind()` 沒成功且有 `$on`，就註冊 `readyListener = () => { readySignal = true; tryBind(); }`。dispose 一律 `$off`。`onReady` 仍由 `fireOnReadyOnce` 在第一次 bind 成功時 microtask 呼叫一次。
  - `portsByCell` 的 key 維持 player component。

- [ ] **Step 5：實作 `controller.ts` 的 `ensurePort`**

  `playerBinding` 改成 `{ identity, cell: binding.cell as PlayerBinding["cell"], playerComponent: …, provider, onReady }`，刪除 `isReady` 匿名函式（controller.ts:490-493）。`grep -n "\.ready\b" src/pages/content/holodex/audio-lock/` 必須沒有結果。

- [ ] **Step 6：確認 PASS**

  跑 `players.test.ts`、`controller.test.ts`、`adapter.test.ts`：全部 PASS（包含配合新 fixture 改寫的既有案例）。

- [ ] **Step 7：Commit**

  ```bash
  git add tests/audio-lock/fixtures.ts tests/audio-lock/players.test.ts tests/audio-lock/controller.test.ts tests/audio-lock/adapter.test.ts src/pages/content/holodex/audio-lock/players.ts src/pages/content/holodex/audio-lock/controller.ts
  git commit -m "fix(audio-lock): detect player readiness from upstream ready event and cell refs"
  ```

### 任務 2：fixture 形狀守門檢查（問題 1 的長期防線）

這是 Fi 的硬性要求：fixture 的形狀必須對照 `.ref`，不能再出現上游沒有的欄位。放在任務 1 的 commit 之後單獨驗證，不需要額外 commit（測試已在任務 1 加入）。

- [ ] 跑下列 grep，**輸出必須為空**：

  ```sh
  grep -rnE "\bready\??:\s*boolean|\.ready\s*(===|!==|=[^=])|comp\.ready|\.twPlayer\s*=|\.ytPlayer\s*=" \
    src/pages/content/holodex/audio-lock tests/audio-lock \
    | grep -v "cell\.twPlayer\s*=\|cell\.ytPlayer\s*=\|this\.twPlayer\|this\.ytPlayer"
  ```

  例外只允許 fixture 裡 VideoCell `onReady` 對 **cell** 的 `twPlayer`／`ytPlayer` 賦值，以及測試對 cell 參考的刻意改寫（例如 stale 案例）。若有命中，修到 grep 為空，或在實作報告逐條說明它是 cell 上的欄位。
- [ ] 確認 `fixture_matches_upstream_player_shape` 在 PASS 清單中。

### 任務 3：已 ready、SDK 缺必要 method 時降級（問題 5）

**根因：** `players.ts:183-185` 在 `tryBind()` 失敗時一律回 `not-ready`；`bindTwitch`／`bindYoutube` 回 null（SDK 存在但缺 method）跟「還沒 ready」被當成同一件事，所以永遠等待，不會走主計畫第 97、142 行「實例存在卻無法取得必要公開 method 則整組降級」。

**Files:**
- Modify: `src/pages/content/holodex/audio-lock/players.ts`
- Modify: `src/pages/content/holodex/audio-lock/controller.ts`（`ensurePort`）
- Test: `tests/audio-lock/players.test.ts`、`controller.test.ts`

**Interfaces:**
- Consumes：任務 1 的 `PlayerBinding.onContractMismatch?: () => void`。
- Produces：port 進入 mismatch 狀態後，`readMuted()` 回 `{ kind: "unavailable", reason: "access-error" }`，`mute()`／`restoreSelectedAudio()` 回 false，`isBound()` 是 false。

- [ ] **Step 1：寫失敗的測試**

  | 測試名稱 | 檔案 | 斷言 |
  | --- | --- | --- |
  | `ready_instance_missing_methods_reports_mismatch` | players.test | Twitch：`sdkLoaded: true` 但刪掉 `getMuted`，`fireReady` → microtask 後 `onContractMismatch` 呼叫恰好 1 次，`readMuted()` 是 `access-error`；再 `fireReady`／`readMuted()` 不再呼叫第二次。YouTube：wrapper 刪掉 `unMute`，同樣結果。**負向**：Twitch `sdkLoaded: false`（`player` 是 `{}`）且沒有 READY → `readMuted()` 是 `not-ready`，`onContractMismatch` 0 次。取代既有的 `missing public methods returns null port` 案例（刪除它）。 |
  | `ready_sdk_missing_methods_degrades` | controller.test | 重現 probe 5：B Twitch 已 READY，但把 `comp.player` 換成 `{}` 並讓 `cell.twPlayer = comp.player`；`setEnabled(true)`，推進 0ms → `mode === "degraded"`，`console.warn` 恰好一次且 code 是 `cell-contract-changed`，A、B 的 wrapper 都已還原（方法等於原始函式）。 |

- [ ] **Step 2：確認 FAIL**（目前停在 `not-ready`／`locked`）。**把任務 3 的修正拿掉時這兩個測試必須失敗。**

- [ ] **Step 3：實作**

  - `players.ts`：新增 `let mismatched = false`。`tryBind()` 在 ready 判定成立、`instance` 是 object、但 bind 回 null 時：設 `mismatched = true`，用 `queueMicrotask` 呼叫 `binding.onContractMismatch` 一次（try/catch），回傳 false。之後 `tryBind()` 直接回 false。`readMuted()` 在 `mismatched` 時回 `access-error`（即使 controller 沒接 callback，也會由既有 3 次失敗規則降級）。
  - `controller.ts` 的 `ensurePort`：傳入 `onContractMismatch: () => { const current = lastBindings.get(key); if (current && sameIdentity(current.identity, binding.identity)) failSession("cell-contract-changed"); }`。code 沿用主計畫第 105 行既有的 `cell-contract-changed`，不新增 code。

- [ ] **Step 4：確認 PASS**（players.test、controller.test）。

- [ ] **Step 5：Commit**

  ```bash
  git add src/pages/content/holodex/audio-lock/players.ts src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/players.test.ts tests/audio-lock/controller.test.ts
  git commit -m "fix(audio-lock): degrade when a ready player lacks required methods"
  ```

### 任務 4：設定重送冪等（問題 2）

**根因：** `controller.ts:1186-1190` 的 `setEnabled(true)` 不檢查目前值，每次都 dispatch `ENABLE`；`state.ts:391-409` 的 `ENABLE` 無條件把 mode 改成 `discovering`。`startDiscoveryLoop` 發現 session 已存在就直接返回，不會再送 `DISCOVERED`／`STORE_SNAPSHOT` 把 mode 帶回 `locked`；`pollObservation` 在 `discovering` 時不產生 effect，但 wrapper 仍攔住原生 `manualCheckMuted`，結果非 active 格可以自行取消靜音而沒人壓回。bridge 的 ready 回覆、`pageshow` 重讀、同值 storage change 都會正常重送 true。

**Files:**
- Modify: `src/pages/content/holodex/audio-lock/controller.ts`（`handle.setEnabled`）
- Modify: `src/pages/content/holodex/audio-lock/state.ts`（`case "ENABLE"`）
- Test: `tests/audio-lock/state.test.ts`、`controller.test.ts`

- [ ] **Step 1：寫失敗的測試**

  | 測試名稱 | 檔案 | 斷言 |
  | --- | --- | --- |
  | `enable_is_idempotent_when_already_enabled` | state.test | 對 `extensionEnabled: true` 的 `locked`、`waiting-for-choice`、`degraded` 三種 state 送 `ENABLE`：回傳的 state 與輸入 `toEqual`（mode、active、epoch、selection 都不變），effects 為空。 |
  | `duplicate_enable_keeps_guard_active` | controller.test | 重現 probe 3：A `false`、B `true`，`setEnabled(true)` 後推進到 `mode === "locked"`；記下 `epoch`；再呼叫 `setEnabled(true)` 兩次；B 的 `rawMuted = false`，`await cell.manualCheckMuted()`，推進 0ms → B 的 `rawMuted === true`，`mode === "locked"`，active 仍是 A，epoch 不變。**不能只數 timer**。 |
  | `duplicate_enable_keeps_degraded_latch` | controller.test | 讓 session 進 degraded（B `throwRead`，三次 `__reconcile`）；再 `setEnabled(true)` → 仍是 degraded，B 沒有被重新 patch。 |

  同時修改既有的 `discovered_keeps_degraded_and_locked`（state.test.ts:797）最後一段：「ENABLE 清除 degraded」改成先 `DISABLE` 再 `ENABLE`，預期 `discovering`。這是規格要求的行為（degraded 只在停用後重新啟用時解除），不是放寬測試；實作報告要記錄這個修改。

- [ ] **Step 2：確認 FAIL**（state 案例回 `discovering`；controller 案例 `rawMuted` 仍 false）。**把任務 4 的修正拿掉時這些測試必須失敗。**

- [ ] **Step 3：實作**

  - `controller.ts` 的 `setEnabled(value)`：`if (disposed) return;` 之後加 `if (value === enabled) return;`。
  - `state.ts` 的 `ENABLE`：最前面加「`state.extensionEnabled === true` 就原樣回傳 `{ state, effects: [] }`」。既有從 degraded 重置的分支保留給 `extensionEnabled === false` 的情況。

- [ ] **Step 4：確認 PASS**，並確認既有 `repeated_enable_single_discovery_loop`、`toggle_ten_times_no_leak` 仍 PASS。

- [ ] **Step 5：Commit**

  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts src/pages/content/holodex/audio-lock/state.ts tests/audio-lock/state.test.ts tests/audio-lock/controller.test.ts
  git commit -m "fix(audio-lock): make repeated enable a no-op for live sessions"
  ```

### 任務 5：路由監聽獨立於音訊 session（問題 3）

**根因：** pathname timer 存在 `Session.pathnameTimer`（controller.ts:79、:930），`teardownSession()`（controller.ts:885）會一起取消它，但 `pathnameWatching` 仍是 true，之後 `startPathnameWatch()` 永遠直接返回。`failSession()` 呼叫 `teardownSession()`，所以 degraded 之後路由監聽就死了。另外 `tick` 只有在 `session` 存在時才設 `leftMultiview = true`（controller.ts:917-919），degraded（沒有 session）時離開 multiview 不會被記錄。這違反主計畫第 103 行「入口的最小設定／路由／pageshow bootstrap 保留以便重啟」與 fix-1 步驟 4 第 9、10 點。

**Files:**
- Modify: `src/pages/content/holodex/audio-lock/controller.ts`（`Session` 型別、`teardownSession`、`beginSession`、`startPathnameWatch` → `startRouteWatch`／`stopRouteWatch`、`startDiscoveryLoop`、`setEnabled`、`dispose`）
- Test: `tests/audio-lock/controller.test.ts`

**Interfaces:**
- Produces（controller 內部）：`let routeTimer: ReturnType<typeof setTimeout> | null`；`startRouteWatch(): void`（冪等，已有 `routeTimer` 就返回）；`stopRouteWatch(): void`（冪等）；`isOnMultiview(): boolean`（`/^\/multiview(?:\/|$)/.test(win.location.pathname)`）。

- [ ] **Step 1：寫失敗的測試**

  | 測試名稱 | 斷言 |
  | --- | --- |
  | `degraded_route_reentry_recovers` | 重現 probe 2：B `throwRead`，三次 `__reconcile` → degraded；`pushState("/")`，推進 2000ms；`pushState("/multiview")`，推進 4000ms → `mode !== "degraded"`，A、B 已重新 patch（`__lastBindings.size === 2`，`cell.setMuted !== 原始函式`）。同時改寫既有 `reenable_or_route_reentry_clears_degraded`：拆成兩個案例，route 那個必須真的走 pushState 路徑，不能只切換設定。 |
  | `route_watch_released_on_disable_and_dispose` | 進 degraded 後 `vi.getTimerCount()` 仍至少有 1 個路由 timer；`setEnabled(false)` → timer 數回到啟用前的 baseline；另一案例 `dispose()` 後同樣回到 baseline；之後 pushState 進出 multiview 都不會重新 patch。 |
  | `non_multiview_start_waits_for_route` | `pushState("/")` 後 `setEnabled(true)`，推進 121_000ms → 沒有 `console.warn`（沒有 `root-timeout`），mode 不是 degraded，cell 沒被 patch；`pushState("/multiview")`，推進 2000ms + 0ms → 已 patch 並進 `locked`。 |

- [ ] **Step 2：確認 FAIL**（degraded 不恢復；非 multiview 起始 121 秒後 root-timeout）。**把任務 5 的修正拿掉時這些測試必須失敗。**

- [ ] **Step 3：實作**

  1. `Session` 型別移除 `pathnameTimer`；`teardownSession()`、`beginSession()` 刪除對它的處理。刪除 `pathnameWatching` 變數與 `startPathnameWatch()`，`beginSession()` 不再啟動路由監聽。
  2. `startRouteWatch()`：排 `routeTimer = schedule(tick, TIMING.PATHNAME_CHECK_MS)`。`tick`：先 `routeTimer = null`；`!enabled || disposed` 就返回（不再排）。
     - `!isOnMultiview()`：如果 `leftMultiview` 還是 false，就設成 true、取消 `discoveryTimer`、`teardownSession()`。不論有沒有 session、是不是 degraded 都要記錄離開。
     - `isOnMultiview() && leftMultiview`：`leftMultiview = false`；degraded 時 dispatch `RESET_DEGRADED`；呼叫 `startDiscoveryLoop()`。
     - 最後重新 `routeTimer = schedule(tick, TIMING.PATHNAME_CHECK_MS)`。
  3. `stopRouteWatch()`：取消 `routeTimer` 並設 null。
  4. `setEnabled(true)`（通過任務 4 的同值檢查後）：`startRouteWatch()`，再 `startDiscoveryLoop()`。`setEnabled(false)` 與 `dispose()`：`stopRouteWatch()`。`failSession()`、`teardownSession()`、`onPageHide` **不**呼叫 `stopRouteWatch()`。
  5. `startDiscoveryLoop()`：開頭在取消舊 `discoveryTimer` 之後，`!isOnMultiview()` 就設 `leftMultiview = true` 並返回（交給路由 tick 在進入 multiview 時啟動），符合主計畫第 383 行「非 multiview 不 patch」。
  6. `onPageShow` 不變；它呼叫的 `startDiscoveryLoop()` 也受第 5 點的 multiview 檢查。

- [ ] **Step 4：確認 PASS**，並確認 `session_observers_released_on_teardown`、`toggle_ten_times_no_leak`、`bfcache_pageshow_revalidates` 仍 PASS（toggle 測試的 timer baseline 若因路由 timer 改變，只能在 `setEnabled(false)` 之後比較，不可放寬成 `>=`）。

- [ ] **Step 5：Commit**

  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/controller.test.ts
  git commit -m "fix(audio-lock): keep route watch alive across degraded teardown"
  ```

### 任務 6：Mute Others 關閉是正常等待，不是 discovery timeout（問題 4）

**根因：** `tryDiscover()`（controller.ts:1025-1028）已經找到合法 store，卻在 `!muteOthers` 時 `teardownSession()` 後返回，沒有建立 store watch，也沒有取消 `discoveryTimer`。`startDiscoveryLoop` 的 tick 因為沒有 session 繼續計時，120 秒後 `failSession("root-timeout")`。「root 沒找到」和「root 找到了、使用者只是沒開 Mute Others」被混成同一件事。

**Files:**
- Modify: `src/pages/content/holodex/audio-lock/controller.ts`（`tryDiscover`）
- Test: `tests/audio-lock/controller.test.ts`

- [ ] **Step 1：寫失敗的測試**

  | 測試名稱 | 斷言 |
  | --- | --- |
  | `initial_mute_others_off_has_no_discovery_timeout` | 重現 probe 4：store `muteOthers: false`、A `false`、B `true`；`setEnabled(true)`，推進 122_000ms → mode 不是 degraded，`console.warn` 0 次。這段期間 wrapper 必須完全委派原方法：B 呼叫 `cell.setMuted(false)` 的結果跟沒裝 controller 時一樣（原始 `muteOthers` 被呼叫，store 依原生邏輯變化）。接著還原 store 為 A `false`、B `true`，`store.commit("multiview/setMuteOthers", true)`，推進 4000ms → `mode === "locked"`、active 是 A、`__lastBindings.size === 2`；B 的 `rawMuted = false` 後 `await cell.manualCheckMuted()` → `rawMuted === true`。 |

- [ ] **Step 2：確認 FAIL**（122 秒後 degraded、bindings 0）。**把任務 6 的修正拿掉時這個測試必須失敗。**

- [ ] **Step 3：實作 `tryDiscover()`**

  刪除 `if (!found.store.state.multiview.muteOthers) { teardownSession(); return; }`。找到合法 store 後一律：取消 `discoveryTimer`、`syncBindings(found.bindings)`、`beginSession(found.store, found.observeTarget)`。Mute Others 的開關改由既有 store watch（holodex-adapter.ts:525 的 signature 已包含 `muteOthers`）送 `STORE_SNAPSHOT` 處理（state.ts:463-500）；wrapper 在 `!state.muteOthers` 時已經委派原方法（controller.ts:609、:620、:653），不需要新程式。`root-timeout` 只保留給「120 秒內找不到 root／store」。

- [ ] **Step 4：確認 PASS**，並確認既有 `toggle_ten_times_no_leak` 中「Mute Others 關閉期間 wrapper 完全委派原方法」的斷言仍成立。

- [ ] **Step 5：Commit**

  ```bash
  git add src/pages/content/holodex/audio-lock/controller.ts tests/audio-lock/controller.test.ts
  git commit -m "fix(audio-lock): keep watching the store while Mute Others is off"
  ```

### 任務 7：完整驗證、實作報告

- [ ] 依序執行「驗證指令」，每一條記錄結束碼與數字。
- [ ] 跑任務 2 的 grep，輸出必須為空。
- [ ] 寫 `docs/plans/reports/twitch-audio-lock-impl-3.md`，內容：
  - 五個問題各自的「根因 → commit SHA → 測試名稱」對照。
  - 每個回歸測試「拿掉修正時的失敗訊息」摘要（Step 2 實際看到的輸出）。
  - 指令結果表（指令、逾時、結束碼、測試數量）。測試數量必須比 baseline 的 101 多，數字跟實際輸出一致。
  - fixture 形狀對照：列出 fixture 每個 player／cell 欄位對應的 `.ref` `檔案:行號`。
  - 偏離與理由（包含 `discovered_keeps_degraded_and_locked`、`reenable_or_route_reentry_clears_degraded`、`missing public methods returns null port` 的修改／刪除）。
  - 真瀏覽器人工清單仍未執行；只能稱為「可交付實測」候選。
- [ ] 報告用 docs commit 提交（不夾帶產品檔案）：

  ```bash
  git add docs/plans/reports/twitch-audio-lock-impl-3.md
  git commit -m "docs: add twitch-audio-lock implementation report 3" -- docs/plans/reports/twitch-audio-lock-impl-3.md
  ```
- [ ] 終端最後一行印出 `twitch-audio-lock-fix-2-DONE`。

## Commit 規則

- 產品 commit 只用英文訊息，依任務 1、3、4、5、6 分成 5 個；每個 commit 結束時 typecheck 和 `test:audio-lock` 都要能過。
- 每個 commit 只 `git add` 白名單內、該任務列出的檔案；禁止 `git add -A`／`git add .`。產品 commit 不夾帶任何 `docs/` 檔案；docs commit 不夾帶產品檔案。
- 不 push、不開 PR、不 merge。

## 驗證指令

每個 process 都用 `.cache/run-with-timeout.py` 包住，逾時一律 exit 124，不能當作通過。vitest config 的 `testTimeout`／`hookTimeout`／`teardownTimeout` 維持 5000ms，不准調高。

```sh
export npm_config_cache="$PWD/.cache/npm" YARN_CACHE_FOLDER="$PWD/.cache/yarn" TMPDIR="$PWD/.cache/tmp"
mkdir -p "$TMPDIR"
T=".cache/run-with-timeout.py"
python3 $T 300 npx --yes yarn@1.22.22 install --frozen-lockfile --non-interactive --cache-folder "$YARN_CACHE_FOLDER"
python3 $T 120 npx --yes yarn@1.22.22 test:audio-lock
python3 $T 120 npx --yes yarn@1.22.22 typecheck:audio-lock
python3 $T 120 node .cache/audio-lock-lint/run.cjs
python3 $T 120 node .cache/audio-lock-lint/run.cjs src/utils/options.ts src/pages/content/holodex/contentScript.ts src/pages/content/holodex/holodex-inject.ts --format unix
python3 $T 180 npx --yes yarn@1.22.22 build:chrome
python3 $T 180 npx --yes yarn@1.22.22 build:firefox
grep -rn "muteOthersCalls\|__trusted" src/ || echo "no fixture coupling"
git diff --check c2625b4 HEAD -- src tests
git diff --stat c2625b4 HEAD -- package.json yarn.lock vitest.audio-lock.config.ts tsconfig.json tsconfig.audio-lock.tests.json src/utils src/pages/content/holodex/contentScript.ts src/pages/content/holodex/holodex-inject.ts src/pages/content/holodex/twitch-audio-lock.ts src/pages/content/holodex/audio-lock-settings.ts .ref
```

預期：前七條中，scoped lint（第 4 條）0 error、0 warning；整合檔 lint（第 5 條）與 baseline 相同，也就是 709e963 版本的 3 則 `@typescript-eslint/ban-ts-comment`，沒有新增；其他結束碼都是 0。最後一條 `git diff --stat` 輸出必須為空（禁改檔案沒有 diff）。

## 驗收條件

- [ ] **問題 1**：`players.ts`、`controller.ts` 沒有讀取 `playerComponent.ready`／`playerComponent.twPlayer`／`playerComponent.ytPlayer`。readiness 只來自 player component 的 Vue `ready` 事件（PlayerMixin.ts:46），或父 VideoCell 的 late-bind 參考（VideoCell.vue:79-80、:210-216）：Twitch 用 `cell.twPlayer === playerComponent.player`，YouTube 用 `cell.ytPlayer.getIframe()` 在目前 component `$el` 內。殘留的舊 `ytPlayer` 不算 ready。`upstream_shape_ready_event_binds_and_guards`、`upstream_shape_late_bind_guards` 證明真實形狀下非 active 格會被壓回。
- [ ] **fixture**：`tests/audio-lock/fixtures.ts` 沒有上游不存在的欄位（`ready`、player component 上的 `twPlayer`／`ytPlayer`）；檔頭有 `.ref` 對照註解；`fixture_matches_upstream_player_shape` PASS；任務 2 的 grep 為空。
- [ ] **問題 2**：同值 `setEnabled(true)` 不改變 state（mode、active、epoch），音訊保護持續有效（`duplicate_enable_keeps_guard_active` 斷言 `rawMuted === true`，不是數 timer）；degraded latch 不會被同值重送解除。
- [ ] **問題 3**：路由 timer 獨立於 `Session`，`failSession`／`teardownSession`／`pagehide` 不會取消它；只有 `setEnabled(false)` 與 `dispose()` 會。degraded 後離開再回到 `/multiview` 會 `RESET_DEGRADED` 並重新探測；非 multiview 起始不會 root-timeout。
- [ ] **問題 4**：找到合法 store 後，Mute Others 關閉只是正常等待：不會觸發 root-timeout、不會降級；之後開啟 Mute Others 會在 store watch 下進入保護。關閉期間 wrapper 完全委派原方法。
- [ ] **問題 5**：READY 已發生、SDK instance 存在但缺 `getMuted`／`setMuted`（Twitch）或 `isMuted`／`mute`／`unMute`（YouTube）時，立即以 `cell-contract-changed` 整組降級、warn 一次、還原所有 wrapper；Twitch script 未載入（`player` 是 `{}`）且沒有 READY 時仍只是 not-ready。
- [ ] 每個回歸測試都在 Step 2 實際 FAIL 過，失敗訊息寫進實作報告；測試總數大於 101。
- [ ] 「驗證指令」全部符合預期；兩個 build 成功；禁改檔案沒有 diff；沒有新增依賴、權限、產品模組或測試檔。
- [ ] 5 個產品 commit（英文、只含白名單檔案、不含 docs）＋ 1 個實作報告 docs commit。沒有 push、PR、merge、公證、sudo 或分支操作。
- [ ] 實作完成時終端最後一行印出 done token：`twitch-audio-lock-fix-2-DONE`。
