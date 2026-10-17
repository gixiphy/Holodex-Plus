VERDICT: FAIL

# Twitch audio lock 實作驗收（impl-review-1）

- 受驗範圍：`c879311`（docs: record Fi decisions）之後的 `b3728bb`、`228c31d`、`39761cc`、`51f343b`、`0afae5a`、`26ff3a5`
- Head：`26ff3a5df61f8262ef21adfa082f82b94d8c874b`
- 依據：`docs/plans/twitch-audio-lock.md`（含「決定紀錄」）。repo 沒有 `AGENTS.md`，所以採用 dispatch 附的審查規則。
- 環境：Node v26.12.0，`npx --yes yarn@1.22.22`，`npm_config_cache` 和 `YARN_CACHE_FOLDER` 都放在 worktree `.cache/`。每個指令都用 Python `start_new_session` 包上 wall-clock 逾時（逾時就 killpg 並回 124）。

## 實跑結果

| 指令 | 逾時 | 結束碼 | 數量／摘要 |
| --- | --- | --- | --- |
| `yarn install --frozen-lockfile` | 300s | 0 | Already up-to-date |
| `yarn typecheck:audio-lock` | 120s | 0 | 兩段 tsc 都通過。`--listFilesOnly` 確認涵蓋 6 個產品模組、5 個 tests、fixtures、vitest config |
| `yarn test:audio-lock` | 120s | 0 | **5 files / 49 tests passed**（state 13、adapter 9、players 7、controller 13、settings 7） |
| `node .cache/audio-lock-lint/run.cjs`（scoped） | 120s | 0 | 0 error / 0 warning（只有 React version 的 plugin 設定提示） |
| baseline lint（709e963 三個整合檔，複製到 `.cache/review-baseline/`） | 120s | 1 | 3× `@typescript-eslint/ban-ts-comment`（holodex-inject.ts `@ts-ignore`），屬既有問題 |
| current lint（同樣三檔） | 120s | 1 | 同樣 3 則、同一條 rule。**新 hunk 沒有新增診斷** |
| `yarn build:chrome` | 180s | 0 | `dist_chrome` 產出 |
| `yarn build:firefox` | 180s | 0 | `dist_firefox` 產出 |
| `git diff --check c879311 HEAD` | — | 0 | 無空白問題 |

產物檢查：

- 兩份 manifest 都是 MV3，manifest 內引用的 20 個檔案全部存在。
- permissions 和 host_permissions 跟基準相同，因為 `manifest.json.ts` 沒改。Chrome 用 `service_worker`，Firefox 用 `background.scripts`。
- web_accessible_resources 只多了 `contracts-*.js` 這個 chunk，match 範圍仍是 `*://*.holodex.net/*`。
- page bundle `holodex-inject.ts-*.js` 只 import `contracts` chunk，沒有 `webextension-polyfill` 或 storage 呼叫。
- 兩份產物都能當 unpacked 載入。

Commit 範圍：

- 產品 commit 只碰白名單檔案，訊息都是英文，docs 分開成獨立 commit。
- yarn.lock 只多了 vitest／jsdom 的解析，被刪掉的行都是 key 合併。
- 沒碰 manifest、tsconfig、options UI、CI，也沒有 auto-multiview-layout 的內容。

我另外寫了暫時的 probe 測試（跑完已刪除、未提交），在 fixture 上重現下列 H1、H2、M1、M2、M3、M4。

## 發現（依嚴重度）

### 1. [high] 發現迴圈 120 秒後停止，之後新增的格子完全不受保護，原始搶聲 bug 會重現

`src/pages/content/holodex/audio-lock/controller.ts:632-649 @ 26ff3a5df61f8262ef21adfa082f82b94d8c874b`

```ts
  const startDiscoveryLoop = () => {
    discoveryStarted = now();
    const tick = () => {
      if (!enabled || disposed) return;
      tryDiscover();
      const elapsed = now() - discoveryStarted;
      if (elapsed >= TIMING.DISCOVERY_TOTAL_MS) {
        if (!lastBindings.size) report("root-timeout");
        return;
      }
```

- `installBindings()` 只會從 `tryDiscover()` 呼叫（`:626`），而 `tryDiscover()` 只有這個迴圈和 `pageshow` 會觸發。
- 計畫寫的是：找到 root 之後改用 `MutationObserver`，再加每 2000ms 一次 cell 身分核對（設計 §1「發現時序」）。整個 src 都沒有 `MutationObserver`，`adapter.watchSnapshot` 收到 store 變化也只更新狀態，不會重新安裝 wrapper。
- 重現步驟：啟用並選定 A，等 121 秒，新增 Twitch 格 B（store 指派 muted=true），B 透過原生 poll 呼叫 `setMuted(false)`。
- 結果：`lastBindings.has("b") === false`，store 變成 `a.muted=true`、`b.muted=false`，A 的聲音被 B 搶走。
- 在 multiview 裡隔幾分鐘才加格子是常態，所以這直接違反計畫目標，以及驗收條件「locked 後新增缺值格」。

### 2. [high] 版面生命週期沒有接上：generation 從不更新，port 只用 key 當索引，同格換片或重建 player 後保護會失效

`src/pages/content/holodex/audio-lock/controller.ts:285-288 @ 26ff3a5df61f8262ef21adfa082f82b94d8c874b`

```ts
  const ensurePort = (binding: CellBinding): PlayerPort | null => {
    if (binding.pendingPort || !binding.playerComponent) return null;
    const existing = ports.get(binding.identity.key);
    if (existing) return existing;
```

`src/pages/content/holodex/audio-lock/controller.ts:420-423 @ 26ff3a5df61f8262ef21adfa082f82b94d8c874b`

```ts
    for (const binding of bindings) {
      lastBindings.set(binding.identity.key, binding);
      ensurePort(binding);
      if (unpatches.has(binding.identity.key)) continue;
```

`src/pages/content/holodex/audio-lock/holodex-adapter.ts:261-265 @ 26ff3a5df61f8262ef21adfa082f82b94d8c874b`

```ts
    let gen = generationByKey.get(key);
    if (!gen) {
      gen = generationCounter++;
      generationByKey.set(key, gen);
    }
```

- **generation 固定不變。** 同一個 key 的 generation 永遠不會增加，`bumpGeneration` 從來沒被呼叫。
- **reducer 的版面規則在執行期是死碼。** controller 從不 dispatch `LAYOUT_CHANGED`、`PLAYER_READY`、`CELL_REMOVED`（grep 結果為 0）。所以 state.ts 寫的 preset／merge／remove-active／replace-active 規則和「新 U 格 READY 後 `SET_STORE_MUTED(true)`」在執行期都不會發生。
- **wrapper 用舊 identity。** cell wrapper 閉包住的是第一次的 identity；已 patch 過的 key 不會再處理，新的 VM instance 也不會被 patch。
- **重現（同格換 provider）：** 選定 A 後，把 B 從 Twitch 換成 YouTube（同一個 key、新的 player component，raw 回報 unmuted）。結果 binding 的 generation 還是 1，port 仍綁在舊的 Twitch SDK 上；reconcile 時新 YouTube 的 `muteCalls=0`，所以新 player 自行出聲時不會被壓回。
- 違反計畫 §3（換片／換 provider／重建 player 要讓舊結果失效、重建 port）和決定紀錄題 2（preset 規則），也影響人工清單的「layout 與生命週期」「preset 取代／合併」。

### 3. [medium] panel 以外的 `setMuted(true)` 被當成明確命令，bootstrap 階段可能被打成全靜音

`src/pages/content/holodex/audio-lock/controller.ts:479-487 @ 26ff3a5df61f8262ef21adfa082f82b94d8c874b`

```ts
          }
          const result = transition(state, {
            type: "EXPLICIT_SET_MUTED",
            now: now(),
            identity,
            muted: true,
          });
          state = result.state;
          void applyEffects(result.effects);
        },
```

- 計畫攔截段寫明：trusted panel 事件以外的 `setMuted` 值「只當 observation」。但 `manualRefresh → updateListeners → @mute(true)` 會直接走 `CALL_ORIGINAL_SET_MUTED(true)`。
- **bootstrap 情境：** 四格 U、player 因為 autoplay 政策是靜音、使用者在首播前打開面板。每格 U 都會被改成 true，接著 `STORE_SNAPSHOT` 走 `applySnapshotSelection` 的 allMuted 分支，selection 變成 silence，之後首播 bootstrap 全被擋，沒有任何一格有聲。這違反 desired 表的「bootstrap U／false：不改 store、不因讀到 true 進 silence」。
- **active 格情境：** 對 active 格會直接 `toSilence`，繞過 pending grant 和 settle 的保護。

### 4. [medium] iframe／pointer 焦點 token 不檢查「muted → unmuted」邊緣，單純聚焦就會切換 active

`src/pages/content/holodex/audio-lock/state.ts:476-487 @ 26ff3a5df61f8262ef21adfa082f82b94d8c874b`

```ts
      // player reports unmuted (false)
      if (event.hasValidToken || tokenValid(state, event.identity, event.now)) {
        const next = consumeToken(state);
        const chosen = withActive(next, event.identity, "selected", "explicit");
```

- `reconcileCell`（`controller.ts:393-406`）只要讀到 false 而且 token 有效，就會選這一格。
- 計畫轉移表要求：「焦點本身不切 active，還必須觀察到從 muted → unmuted 的變化」。
- 重現：A 是 active，B（Twitch）正在自行 unmute、每秒被壓回一次；使用者只是點進 B 的 iframe（例如看全螢幕）就產生 token，下一次 poll B 就變成 active（probe 結果：`active === "b"`）。

### 5. [medium] mute 限速與 settle 保護沒實作
`controller.ts:118-147`：MUTE_PLAYER 不看 `settleUntil`。`player-mute-did-not-settle`、500ms `store-did-not-settle` 都沒有實作。`SETTLE_EXPIRED`／`STORE_DID_NOT_SETTLE` 從不 dispatch，選聲後也沒有 1500ms settle。probe：SDK 一直不收斂時，10 次 poll 會寫 10 次 mute，而且永遠不降級。

### 6. [medium] degraded 不會保持
`state.ts:272-280` 的 `DISCOVERED` 不管目前是不是 degraded 都改成 waiting-for-choice，發現迴圈會在 `player-unavailable` 或契約失配之後重新安裝 wrapper（probe：3 次失敗 warn 後 `b re-patched: true`）。違反「永久失配進 degraded，不繼續密集重試」。

### 7. [medium] U／false 提前返回的補呼叫靠 fixture 專用欄位 `muteOthersCalls` 判斷
`controller.ts:185-207`：production 沒有這個欄位，所以原本 muted=true 的格子會呼叫兩次 mapped `muteOthers`（probe 量到 2 次），對應的「恰一次」測試只在 fixture 上成立。

### 8. [medium] bootstrap 1000ms fallback 不檢查 paused／是否在播放，而且用的是排程當下的舊 snapshot
`controller.ts:571-598`：計畫寫「paused／未 ready／明確 true 不參選」，實作卻會選第一個 ready 的格子。

### 9. [medium] 計畫列為必須的 controller／settings 回歸測試大量缺少
`tests/audio-lock/controller.test.ts`、`tests/audio-lock/settings.test.ts`：缺 first-play 和 fallback 兩條 grant 路徑、manualRefresh `@mute`、YouTube 版本、三個初始化測試（四 U／locked 加格／preset）、pending grant 取消、A→B→A、500ms／1500ms／3 次失敗、BFCache／10 次熱切換、storage change 早於 get resolve/reject。實作報告的「偏離 1」自己承認了這點。

### 10. [low] ready handshake 在 storage 讀完前就回傳預設 true
`audio-lock-settings.ts:90-100`：使用者已關閉設定時，頁面會短暫啟用保護。計畫要求的是「storage 尚未讀完則等結果」。

### 11. [low] 測試 hook 隨 production page bundle 出貨
`controller.ts:669-675`、`controller.ts:802-821`：`__setState`／`__applyEffects`／`__trusted` 都在 `window.__HDX_AUDIO_LOCK_HANDLE__` 上；`__trusted` 讓合成的 pointerdown 也能產生 token。

### 12. [low] 重複 `setEnabled(true)` 會開出平行的發現迴圈
`controller.ts:770-776`：沒有先取消既有的 `discoveryTimer`，pageshow 重送 config 時就會疊加。

## 給 Fi 的摘要

安裝、typecheck、49 個測試、scoped lint、兩個 build 我都重跑過，結束碼全是 0。baseline lint 的 3 則 `@ts-ignore` 是既有問題，新改動沒有增加。產物可以當 unpacked 載入，權限沒變。但 controller 只接上了「啟用後前 120 秒、版面不變」的情境：120 秒後新增的 Twitch 格不會被保護，原本的搶聲問題會重現；同一格換片或換 provider 後，port 還綁在舊 player 上。reducer 裡的 preset、新格正規化、settle 和降級規則有寫，但 controller 從沒把對應事件送進去，所以執行期不會發生。另外，焦點不需要 unmute 動作就能切 active，打開面板也可能讓 bootstrap 變成全靜音，計畫要求的競態回歸測試也大多還沒寫。建議退回 Cursor，先補 MutationObserver 重掃、generation／port 重建和 LAYOUT_CHANGED／PLAYER_READY 的接線，再補齊測試後重新驗收；真瀏覽器人工清單仍未執行。
