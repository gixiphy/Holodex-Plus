# fix-3 驗收失敗：載入時 YouTube 也被靜音（協調者 2026-10-17 22:2x 整理）

## 現象
- fix-3 build（f59dbb5，頁面腳本已能執行，`HOLODEX_PLUS_INSTALLED_V3`、`__HDX_AUDIO_LOCK_HANDLE__` 都在）在相同 harness 情境下：
  Twitch 確實不再搶，但 **YouTube 從頭到尾都被靜音**（ytMutedSamples 168/168，三個檢查點 audible = none）。
- M1（Chrome 155.0.8059.82）跑 f59 三次、M5 Codex 跑兩次，結果相同。21:4x 時曾通過的診斷版 newfix（只把 contracts 內嵌）在 22:1x 於 M1 重跑也一樣失敗（newfix2.json）→ 不是 fix-3 的建置改動造成，是新音訊鎖邏輯本身有時序相關問題；21:4x 那次通過是剛好時序沒碰到。
- MVP（mvp2.json）與 none（none2.json）在同一時段重跑結果與證據一致 → harness 與 holodex.net 沒變。

## 追蹤（run-trace.mjs，在 harness 的 setLayout 之後、reload 之前，以及 reload 之後各取樣）
trace2-f59.json（新鎖）reload 前，每 250ms：
- a(YT).muted=false, b(TW).muted=true, YT 播放器 0、TW 播放器 0
- a=false, b=true, YT 播放器 1、TW 0
- **TW 播放器出現的那一刻（ytN=1, twN=1）a 變成 true**，之後一直 true
- reload 之後一開始 a=true、b=true，YT/TW fake 播放器都是 muted；Twitch setMuted 呼叫 [[~1000ms,true]]
trace2-mvp.json（MVP）同時間點 a 一直 false；reload 後 a=false。

→ 沒有任何播放、沒有任何使用者操作時，新鎖在 Twitch 播放器建立/READY 時把 YouTube 格的 store muted 設成 true，並被 Holodex 的 multiview store 持久化，重新整理後兩格都靜音。

## 協調者推測（未驗證，請規劃者讀原始碼確認或推翻）
- `src/pages/content/holodex/audio-lock/` 的 bootstrap 流程：`PLAYER_READY` 之後 `pe()` 啟動 bootstrap fallback 計時器，到點時對第一個「可綁定、未 edit、`paused===false` 或 `firstPlay===false`」的格送 `BOOTSTRAP_READY`，把它設成 active 並 SET_STORE_MUTED 其他格。
  若 Twitch 格（或尚未播放的 YT 格）在這裡被當成「已在播」選成 active，就會把 YouTube 靜音，而 Twitch 本身 store 仍是 muted → 兩格皆無聲。
- 也可能是 PLAYER_READY 在 selection==="silence" 分支，或 store 持久化把一次性的暫時 mute 寫回。

## 檔案
- f59.json、f59b.json：fix-3 build 兩次（M1）
- newfix2.json：診斷版重跑（M1，失敗）
- mvp2.json、none2.json：對照重跑（M1）
- run-trace.mjs：在 harness 加 reload 前/後取樣的追蹤版
- trace2-f59.json、trace2-mvp.json：追蹤結果（`preReload`、`pre` 欄位）
- Codex 驗收：docs/plans/reviews/twitch-audio-lock-impl-review-4.md、twitch-audio-lock-fix-3-harness-result.json
