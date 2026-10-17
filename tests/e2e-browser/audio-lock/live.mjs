// usage: node live.mjs <label> <extensionDir|none> <outJson> [--mode=normal|fallback]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const modeArg = args.find((a) => a.startsWith('--mode='));
const mode = (modeArg && modeArg.split('=')[1]) || 'normal';
const positional = args.filter((a) => !a.startsWith('--'));
const [label, extDirArg, outFile] = positional;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.env.HPLUS_E2E_HEADLESS === '1';
const TWITCH_DEFAULT = process.env.HPLUS_E2E_TWITCH_CHANNEL || 'eslcs';
const YT_DEFAULT = process.env.HPLUS_E2E_YOUTUBE_ID || '1-LpQekNa9g';
const base = process.env.HPLUS_E2E_TMP ?? path.join(REPO_ROOT, '.cache', 'e2e-browser');
fs.mkdirSync(base, { recursive: true });
const prof = fs.mkdtempSync(path.join(base, 'live-prof-'));
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });

const chromeArgs = [
  `--user-data-dir=${prof}`,
  '--remote-debugging-pipe',
  '--site-per-process',
  '--remote-debugging-port=0',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--window-size=1600,900',
  'about:blank',
];
if (HEADLESS) chromeArgs.unshift('--headless=new');

const proc = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let errTail = '';
proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-4000); });
const out = proc.stdio[3];
const inp = proc.stdio[4];
let id = 0;
const pend = new Map();
const handlers = [];
let buf = '';
inp.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error)));
      else p.res(m.result);
    } else handlers.forEach((h) => h(m));
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const m = { id: ++id, method, params };
  if (sessionId) m.sessionId = sessionId;
  pend.set(m.id, { res, rej });
  out.write(JSON.stringify(m) + '\0');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = {
  label,
  mode,
  extDir: extDirArg,
  versions: {},
  picks: {},
  calibration: {},
  scenarios: {},
  twitchObserved: null,
  vIsRefErrors: 0,
  updateStateMessages: 0,
  twitchCommandsReceived: { mute: 0, unmute: 0 },
  audioLockWarnings: [],
  verdict: 'FAIL',
  errors: [],
  clickPoints: {},
};

let scenarioAStarted = false;
let finished = false;

const cleanupProfile = () => {
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
};

const done = async (code) => {
  if (finished) return;
  finished = true;
  try { fs.writeFileSync(outFile, JSON.stringify(result, null, 1)); } catch { /* ignore */ }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(200);
  cleanupProfile();
  process.exit(code);
};

setTimeout(() => {
  result.errors.push('global timeout');
  if (!scenarioAStarted) {
    result.verdict = 'SKIP';
    result.skipReason = 'env-timeout';
    done(4);
  } else {
    result.verdict = 'FAIL';
    result.failReason = 'global-timeout';
    done(3);
  }
}, 300000);

const iframeSessions = new Map(); // key: 'twitch'|'youtube' -> sessionId

try {
  let extDir = extDirArg;
  if (extDir !== 'none') {
    extDir = path.resolve(extDir);
    result.extDir = extDir;
    if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
      result.errors.push('extension dir missing manifest.json: ' + extDir);
      await done(2);
    }
    const r = await send('Extensions.loadUnpacked', { path: extDir });
    result.extensionId = r.id;
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });

  const onEvent = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (/Holodex\+|AudioLock/.test(t) || ['error','warning'].includes(m.params.type)) {
        result.audioLockWarnings.push({ t: Date.now(), type: m.params.type, text: t.slice(0, 400) });
      }
      if (/__v_isRef/.test(t) && /SecurityError|Blocked a frame/i.test(t)) {
        result.vIsRefErrors += 1;
      }
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const desc = JSON.stringify(m.params.exceptionDetails || {}).slice(0, 4000);
      if (/__v_isRef/.test(desc)) result.vIsRefErrors += 1;
      result.errors.push(['exception', desc]);
    }
    if (m.method === 'Target.detachedFromTarget') {
      for (const [which, sid] of iframeSessions) if (sid === m.params.sessionId) iframeSessions.delete(which);
    }
    if (m.method === 'Target.attachedToTarget') {
      const sid = m.params.sessionId;
      const url = m.params.targetInfo?.url || '';
      if (/player\.twitch\.tv/.test(url)) iframeSessions.set('twitch', sid);
      if (/youtube\.com\/embed\/|youtube-nocookie\.com\/embed\//.test(url)) {
        iframeSessions.set('youtube', sid);
      }
      send('Runtime.enable', {}, sid).catch(() => {});
      send('Page.enable', {}, sid).catch(() => {});
      // Install observation before resuming iframe scripts.
      (async () => {
        if (/player\.twitch\.tv/.test(url)) {
          const source = `(()=>{if(window.__hplusCmdCount)return;window.__hplusCmdCount={mute:0,unmute:0};window.addEventListener('message',e=>{const d=e.data;if(e.origin!=='https://holodex.net'||d?.namespace!=='twitch-embed-player-proxy'||d.eventName!==10)return;if(d.params===true)window.__hplusCmdCount.mute++;if(d.params===false)window.__hplusCmdCount.unmute++;})})()`;
          await send('Page.addScriptToEvaluateOnNewDocument', {source}, sid).catch(() => {});
          await send('Runtime.evaluate', {expression:source}, sid).catch(() => {});
        }
        await send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
      })();
      if (/player\.twitch\.tv/.test(url)) {
        send('Runtime.evaluate', {
          expression: `(()=>{if(window.__hplusCmdCount)return;window.__hplusCmdCount={mute:0,unmute:0};window.addEventListener('message',e=>{try{const d=e.data;if(!d||d.namespace!=='twitch-embed-player-proxy')return;if(d.eventName===10){if(d.params===true)window.__hplusCmdCount.mute++;if(d.params===false)window.__hplusCmdCount.unmute++;}}catch{}});})()`,
          awaitPromise: false,
        }, sid).catch(() => {});
      }
    }
  };
  handlers.push(onEvent);

  await send('Runtime.enable', {}, S);
  await send('Page.enable', {}, S);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, S);

  // Disable service worker
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{const sw={register:()=>new Promise(()=>{}),getRegistration:()=>Promise.resolve(undefined),getRegistrations:()=>Promise.resolve([]),addEventListener(){},removeEventListener(){},ready:new Promise(()=>{}),controller:null,oncontrollerchange:null,onmessage:null,startMessages(){}};Object.defineProperty(Navigator.prototype,'serviceWorker',{configurable:true,get(){return sw}})}catch(e){}`,
  }, S);

  if (mode === 'fallback') {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try{Object.defineProperty(window,'Twitch',{value:undefined,writable:true,configurable:false,enumerable:true})}catch(e){}`,
    }, S);
  }

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__hplusUpdates=[];window.addEventListener('message',e=>{const d=e.data;if(e.origin!=='https://player.twitch.tv'||d?.namespace!=='twitch-embed-player-proxy'||d.eventName!=='UPDATE_STATE')return;if(![...document.querySelectorAll('iframe')].some(f=>f.contentWindow===e.source))return;window.__hplusUpdates.push({t:Date.now(),muted:d.params?.muted});});`,
  }, S);

  const E = async (expr, sessionId = S) => {
    const ref = typeof sessionId === 'object' ? sessionId : {sessionId};
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, ...(ref.contextId ? {contextId:ref.contextId} : {}) }, ref.sessionId);
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };

  const waitFor = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await E(expr)) return true; } catch { /* ignore */ }
      await sleep(250);
    }
    result.timeoutDiagnostics = await E(`(()=>{const a=document.querySelector('#app');return{url:location.href,body:document.body.innerText.slice(-3000),store:a?.__vue__?.$store?.state.multiview,iframes:[...document.querySelectorAll('iframe')].map(f=>f.src)}})()`).catch(()=>null);
    throw new Error('timeout waiting ' + what);
  };

  result.versions.chrome = await E(`navigator.userAgent`);
  const twitchChannel = TWITCH_DEFAULT;
  const youtubeId = YT_DEFAULT;
  result.picks = {
    twitch: twitchChannel,
    youtube: youtubeId,
    method: 'default-env-or-plan',
  };

  await send('Page.navigate', { url: 'https://holodex.net/multiview' }, S);
  await waitFor(
    `!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&document.querySelector('#app').__vue__.$store)`,
    60000,
    'vue store',
  );
  result.versions.vue = await E(`document.querySelector('#app').__vue__.$root.constructor.version||document.querySelector('#app').__vue__.constructor.version||'unknown'`);

  // Seed YouTube-only first
  await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;
    st.commit('multiview/setLayout',[{x:0,y:0,w:24,h:24,i:'a'}]);
    st.commit('multiview/setLayoutContent',{a:{type:'video',id:${JSON.stringify(youtubeId)},video:{id:${JSON.stringify(youtubeId)},type:'stream',status:'live',title:'YT',channel:{id:'c1',name:'yt'}},muted:false}});
    st.commit('multiview/setMuteOthers',true);
    return true;})()`);

  const blankClick = { x: 20, y: 20 };
  result.clickPoints.blank = blankClick;
  const progress = (step) => {
    result.step = step;
    fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
    console.log(label, step);
  };
  const clickAt = async (x, y, sessionId = S) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('invalid input coordinates');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
    }
  };
  const blank = async () => {
    const pt=await E(`(()=>{for(let y=innerHeight-24;y>innerHeight/2;y-=40)for(let x=innerWidth-40;x>innerWidth/2;x-=40){const e=document.elementFromPoint(x,y);if(e&&!e.closest('a,button,input,label,iframe,video,.mv-frame,.v-overlay,.v-dialog'))return{x,y,tag:e.tagName,cls:e.className};}throw Error('no verified blank region')})()`);
    result.clickPoints.blank=pt;
    await clickAt(pt.x,pt.y);
  };
  const iframeBox = async (which) => E(`(()=>{
    const hit=[...document.querySelectorAll('iframe')].find(f=>${which === 'youtube'
      ? `/youtube\\.com\\/embed\\/|youtube-nocookie\\.com\\/embed\\//.test(f.src)`
      : `/player\\.twitch\\.tv/.test(f.src)`});
    if(!hit)return null;const r=hit.getBoundingClientRect();
    return {x:r.left,y:r.top,w:r.width,h:r.height,src:hit.src};})()`);
  const waitSession = async (which, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const known = iframeSessions.get(which);
      if (known) {
        try { if (await E('!!document.documentElement', known)) return known; } catch { iframeSessions.delete(which); }
      }
      const targets = await send('Target.getTargets');
      const match = targets.targetInfos.find(t => which === 'youtube'
        ? /youtube(?:-nocookie)?\.com\/embed\//.test(t.url)
        : /player\.twitch\.tv/.test(t.url));
      if (match) {
        const { sessionId } = await send('Target.attachToTarget', { targetId: match.targetId, flatten: true });
        iframeSessions.set(which, sessionId);
        await send('Runtime.enable', {}, sessionId);
        await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        return sessionId;
      }
      const tree = await send('Page.getFrameTree', {}, S);
      const frames = []; const walk = n => { frames.push(n.frame); for(const c of n.childFrames||[])walk(c); };walk(tree.frameTree);
      const frame = frames.find(f => which==='twitch' ? /player\.twitch\.tv/.test(f.url) : /youtube(?:-nocookie)?\.com\/embed\//.test(f.url));
      if(frame){
        try{const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'hplus-review-truth'},S);const ref={sessionId:S,contextId:executionContextId};iframeSessions.set(which,ref);return ref;}catch{}
      }
      result.frameDiagnostics = {targets:targets.targetInfos.map(t=>({type:t.type,url:t.url})),frames};
      await sleep(250);
    }
    return null;
  };
  const readVideo = async (which) => {
    const sid = iframeSessions.get(which);
    if (!sid) return null;
    try {
      return await E(`(()=>{const vs=[...document.querySelectorAll('video')];const v=vs.find(v=>v.readyState>0)||vs[0];
        return v?{muted:v.muted,volume:v.volume,paused:v.paused,readyState:v.readyState,currentTime:v.currentTime,currentSrcEmpty:!v.currentSrc}:null;})()`, sid);
    } catch { return null; }
  };
  const playing = v => !!(v && !v.paused && v.readyState >= 2);
  const audible = v => playing(v) && v.muted === false && v.volume > 0.01;
  const controlPoint = async (which, selectors) => {
    const sid = await waitSession(which, 60000);
    const box = await iframeBox(which);
    if (!sid || !box) {result.missingFrameBody=await E('document.body.innerText'); throw new Error('missing iframe/session: ' + which);}
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w / 2, y: box.y + box.h / 2 }, S);
    await sleep(200);
    const point = await E(`(()=>{for(const sel of ${JSON.stringify(selectors)}){const e=document.querySelector(sel);if(!e)continue;const r=e.getBoundingClientRect();if(r.width&&r.height)return{x:r.left+r.width/2,y:r.top+r.height/2,selector:sel};}return null})()`, sid);
    return point && { x: box.x + point.x, y: box.y + point.y, localX: point.x, localY: point.y, selector: point.selector, sid };
  };
  const clickPlay = async which => {
    const current = await readVideo(which);
    if (current && !current.paused) return;
    const selectors = which === 'youtube' ? ['.ytp-large-play-button', '.ytp-play-button', '.ytmCuedOverlayPlayButton', '.player-control-play-pause-icon']
      : ['button[data-a-target="player-overlay-play-button"]', 'button[data-a-target="player-play-pause-button"]', '.click-to-play'];
    const pt = await controlPoint(which, selectors);
    if (pt) {
      result.clickPoints[which + 'Play'] = pt;
      await clickAt(pt.x, pt.y);
    } else {
      const box = await iframeBox(which);
      if (!box) throw new Error('missing play iframe: ' + which);
      await clickAt(box.x + box.w / 2, box.y + box.h / 2);
    }
    await blank();
  };
  const waitPlaying = async (which, ms = 45000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await readVideo(which);
      if (playing(v)) return v;
      if (Date.now() - t0 < 6000) await clickPlay(which);
      await sleep(500);
    }
    return null;
  };
  // Trusted button click establishes iframe focus. If the control ignores that click,
  // the player's own keyboard shortcut is a trusted fallback; never mutate media state.
  const toggleMute = async which => {
    const before = await readVideo(which);
    const pt = await controlPoint(which, which === 'youtube' ? ['.ytp-mute-button', '.ytdVolumeControlsMuteIconButton'] : ['button[data-a-target="player-mute-unmute-button"]']);
    result.lastToggleDiagnostics={which,before,point:pt,location:await E('location.href',await waitSession(which))};
    if (!before) throw new Error('missing video: ' + which);
    const box=await iframeBox(which);
    const point=pt||{x:box.x+box.w/2,y:box.y+box.h/2,sid:await waitSession(which),selector:'player-focus-keyboard'};
    result.clickPoints[which + 'Mute'] = point;
    await clickAt(point.x, point.y);
    await sleep(100);
    let after = await readVideo(which);
    let method = 'trusted-button';
    if (after && after.muted === before.muted && Math.abs(after.volume - before.volume) < 0.01) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', text: 'm', windowsVirtualKeyCode: 77 }, typeof point.sid==='object'?point.sid.sessionId:point.sid);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }, typeof point.sid==='object'?point.sid.sessionId:point.sid);
      method = 'trusted-button-then-m';
      await sleep(100);
      after = await readVideo(which);
    }
    if(after?.paused){await clickPlay(which);await waitPlaying(which,5000);after=await readVideo(which);}
    await blank();
    return { before, after, method, t: Date.now() };
  };
  const sampleOnce = async () => {
    const [yt, tw, store] = await Promise.all([readVideo('youtube'), readVideo('twitch'), E(`(()=>{const s=document.querySelector('#app').__vue__.$store.state.multiview;return{a:s.layoutContent.a?.muted,b:s.layoutContent.b?.muted,muteOthers:s.muteOthers};})()`)]);
    return { t: Date.now(), yt, tw, store, ytAudible: audible(yt), twAudible: audible(tw), ytMutedVideo: yt?.muted === true };
  };
  const sampleFor = async ms => {
    const samples = []; const t0 = Date.now();
    while (Date.now() - t0 < ms) { samples.push(await sampleOnce()); await sleep(250); }
    return samples;
  };
  const observed = () => E(`(()=>{let found=null;function walk(v){if(v.$options?.name==='TwitchPlayer'&&v.player)found=v.player;for(const c of v.$children||[])walk(c)}walk(document.querySelector('#app').__vue__.$root);return found?Object.prototype.hasOwnProperty.call(found,'__ob__'):null})()`);
  const refreshCounters = async () => {
    const updates = await E('window.__hplusUpdates||[]');
    result.updateStateMessages = updates.length;
    result.updateStates = updates;
    const sid = iframeSessions.get('twitch');
    if (sid) result.twitchCommandsReceived = await E('window.__hplusCmdCount||{mute:0,unmute:0}', sid).catch(() => ({ mute: 0, unmute: 0 }));
  };
  const addTwitch = async () => {
    await E(`(()=>{const s=document.querySelector('#app').__vue__.$store;
      s.commit('multiview/setLayout',[{x:0,y:0,w:12,h:16,i:'a'},{x:12,y:0,w:12,h:16,i:'b'}]);
      s.commit('multiview/setLayoutContentById',{id:'b',content:{type:'video',id:${JSON.stringify(twitchChannel)},video:{id:${JSON.stringify(twitchChannel)},type:'twitch',status:'live',title:'TW',channel:{name:${JSON.stringify(twitchChannel)}}}}});return true})()`);
    await waitFor(`!![...document.querySelectorAll('iframe')].find(f=>/player\\.twitch\\.tv/.test(f.src))`, 60000, 'twitch iframe');
    result.mountDiagnostics=await E(`(()=>{const f=[...document.querySelectorAll('iframe')].find(f=>/player\\.twitch\\.tv/.test(f.src));return {body:document.body.innerText,iframe:f?.outerHTML,box:f?.getBoundingClientRect().toJSON()}})()`);
    fs.writeFileSync(outFile,JSON.stringify(result,null,1));
    await waitSession('twitch', 45000);
  };
  progress('calibration');
  await waitFor(`!![...document.querySelectorAll('iframe')].find(f=>/youtube\\.com\\/embed\\//.test(f.src))`, 60000, 'youtube iframe');
  await waitSession('youtube', 20000);
  if (!await waitPlaying('youtube')) { result.verdict = 'SKIP'; result.skipReason = 'no-live-youtube'; await done(4); }
  progress('calibration-youtube-playing');
  await addTwitch();
  progress('calibration-twitch-mounted');
  if (!await waitPlaying('twitch')) {
    result.playback = { youtube: await readVideo('youtube'), twitch: await readVideo('twitch') };
    result.verdict = 'SKIP'; result.skipReason = 'no-live-twitch'; await done(4);
  }
  result.twitchObserved = await observed();
  await sleep(1000);
  await E(`document.querySelector('#app').__vue__.$store.commit('multiview/setMuteOthers',false)`);
  await sleep(1000);
  for (const which of ['youtube', 'twitch']) {
    const calibration = await toggleMute(which);
    const { before, after } = calibration;
    calibration.ok = !!(playing(before) && playing(after) && (before.muted !== after.muted || Math.abs(before.volume-after.volume)>0.01));
    result.calibration[which] = calibration;
    await toggleMute(which);
  }
  await refreshCounters();
  if (!result.calibration.youtube.ok || !result.calibration.twitch.ok) {
    result.verdict = 'FAIL'; result.failReason = 'truth-method-invalid'; await done(1);
  }
  // Recreate the late Twitch arrival after calibration, with no persisted mute value.
  await E(`(()=>{const s=document.querySelector('#app').__vue__.$store;s.commit('multiview/removeLayoutItem','b');s.commit('multiview/setLayoutContentWithKey',{id:'a',key:'muted',value:false});s.commit('multiview/setMuteOthers',true);})()`);
  await sleep(1000);
  iframeSessions.delete('twitch');
  await blank();
  await sleep(3000);
  progress('a');
  scenarioAStarted = true;
  const aSamples = [];
  let sampleA = true;
  const sampler = (async () => { while (sampleA) { aSamples.push(await sampleOnce()); await sleep(250); } })();
  await addTwitch();
  const twPlaying = await waitPlaying('twitch');
  await sleep(Math.max(0, 45000 - (Date.now() - aSamples[0].t)));
  sampleA = false; await sampler;
  result.twitchObserved = await observed();
  await refreshCounters();
  const isMvp = /holodex-plus-audiolock|mvp/i.test(extDirArg);
  const aLast = aSamples.at(-1);
  result.scenarios.a = {
    pass: !!twPlaying && aSamples.every(s=>s.yt && !s.ytMutedVideo && s.store.a!==true) && aSamples.filter(s=>s.twAudible).length<=(mode==='fallback'?8:4) && aLast.ytAudible && !aLast.twAudible && (isMvp || result.twitchObserved===(mode==='fallback')),
    ytMutedSamples:aSamples.filter(s=>s.ytMutedVideo).length,storeATrueSamples:aSamples.filter(s=>s.store.a===true).length,
    twAudibleSamples:aSamples.filter(s=>s.twAudible).length,twitchPlayed:!!twPlaying,last:aLast,samples:aSamples,
  };
  if (mode==='fallback' && (result.twitchObserved!==true || result.vIsRefErrors<=0)) {
    result.scenarios.g={pass:false};result.failReason='fallback-not-triggered';await done(1);
  }
  if (isMvp) {
    const box = await iframeBox('twitch');await clickAt(box.x+box.w/2,box.y+box.h/2);await blank();
    const bp=(await sampleFor(3000)).at(-1);
    result.scenarios.bPrime={centerClickSwitch:{storeA:bp.store.a,storeB:bp.store.b,twitchVideoMuted:bp.tw?.muted,youtubeVideoMuted:bp.yt?.muted}};
    if (!playing(bp.tw)) await clickPlay('twitch');
  }
  const switchToTwitch = async () => {
    const before = await sampleOnce();
    if (!before.twAudible) await toggleMute('twitch');
    const samples = await sampleFor(3000);const hold=await sampleFor(3000);
    await refreshCounters();
    return {pass:samples.some(s=>s.twAudible&&s.yt?.muted===true)&&hold.every(s=>s.twAudible&&s.yt?.muted===true),samples,hold};
  };
  // Open the real media dialog through its toolbar button, then click the per-cell mute
  // button inside .media-controls-list. No cell.setMuted or store shortcut is used.
  const panelUnmuteYoutube = async () => {
    const opener = await E(`(()=>{let mv;function walk(v){if(v.$options?.name==='MultiView')mv=v;for(const c of v.$children||[])walk(c)}walk(document.querySelector('#app').__vue__.$root);if(!mv)throw Error('MultiView missing');const d=mv.buttons.find(b=>String(b.tooltip).toLowerCase().includes('media')||String(b.color)==='orange');const i=d?.icon;const btn=[...mv.$el.querySelectorAll('button')].find(b=>[...b.querySelectorAll('path')].some(p=>p.getAttribute('d')===i));if(!btn)return null;const r=btn.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!opener) throw new Error('media controls toolbar button not found');
    result.clickPoints.panelOpen=opener;await clickAt(opener.x,opener.y);
    await waitFor(`!!document.querySelector('.v-dialog--active .media-controls-list')`,5000,'media dialog');
    const pt=await E(`(()=>{const list=document.querySelector('.v-dialog--active .media-controls-list');const row=[...list.querySelectorAll('.v-list-item')].find(r=>r.textContent.includes('YT'));if(!row)return null;const buttons=[...row.querySelectorAll('button')];const b=buttons[buttons.length-1];if(!b)return null;const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,text:row.textContent}})()`);
    if(!pt)throw new Error('YouTube panel row mute button missing');
    result.clickPoints.panelYoutube=pt;const t=Date.now();await clickAt(pt.x,pt.y);
    return {t,close:async()=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},S);await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},S);await blank();}};
  };
  progress('b/c');
  result.scenarios.c=[];
  for(let round=1;round<=3;round++){
    const b=await switchToTwitch();if(round===1)result.scenarios.b=b;
    const before=await sampleOnce();await refreshCounters();const muteBefore=result.twitchCommandsReceived.mute;
    let t=Date.now(),close=async()=>{};
    if(round===2){await toggleMute('youtube');}else{const panel=await panelUnmuteYoutube();t=panel.t;close=panel.close;}
    const samples=[];let switchedInMs=null;
    while(Date.now()-t<2000){const s=await sampleOnce();samples.push(s);if(s.ytAudible&&s.tw?.muted===true){switchedInMs=Date.now()-t;break;}await sleep(100);}
    await close();const hold=await sampleFor(5000);await refreshCounters();const muteDelta=result.twitchCommandsReceived.mute-muteBefore;
    result.scenarios.c.push({round,method:round===2?'youtube-player-mute':'trusted-media-controls-list',precondition:b.pass&&before.twAudible&&before.yt?.muted===true,
      pass:b.pass&&before.twAudible&&switchedInMs!==null&&hold.every(s=>s.ytAudible&&s.tw?.muted===true)&&(mode!=='fallback'||muteDelta>0),switchedInMs,muteDelta,b,samples,hold});
  }
  if(mode==='normal'){
    progress('d');
    await E('window.__hplusBeforeReviewReload=true');
    iframeSessions.clear();await send('Page.reload',{},S);
    await waitFor(`!window.__hplusBeforeReviewReload && !!document.querySelector('#app')?.__vue__?.$store`,60000,'new document reload store');
    await waitFor(`document.querySelectorAll('iframe').length>=2`,30000,'reload iframes');
    await waitSession('youtube',15000);await waitSession('twitch',15000);
    const y=await waitPlaying('youtube',30000);const tw=await waitPlaying('twitch',30000);
    const samples=await sampleFor(20000);
    result.scenarios.d={pass:!!y&&!!tw&&samples.every(s=>s.ytAudible&&s.store.a!==true)&&samples.filter(s=>s.twAudible).length<=4&&samples.some(s=>s.store.b===true),samples};
    await refreshCounters();
    progress('f');const ex=result.errors.length;
    await E(`document.querySelector('#app').__vue__.$store.commit('multiview/removeLayoutItem','b')`);
    await sleep(5000);const after=await sampleOnce();
    result.scenarios.f={pass:result.errors.length===ex&&after.ytAudible,newExceptions:result.errors.length-ex,youtubeStillAudible:after.ytAudible};
  }
  const badCodes=['player-unavailable','player-mute-did-not-settle','store-did-not-settle','restore-failed','cell-contract-changed'];
  const bad=result.audioLockWarnings.filter(w=>w.text.includes('[Holodex+ AudioLock]')&&(badCodes.some(c=>w.text.includes(c))||(mode==='fallback'&&w.type==='warning'&&!w.text.includes('twitch-guard-unavailable'))));
  result.scenarios.e={pass:bad.length===0&&(mode==='fallback'||isMvp||result.vIsRefErrors===0),badWarns:bad.length,vIsRefErrors:result.vIsRefErrors,warnings:result.audioLockWarnings};
  if(mode==='fallback'){
    result.fallbackChannel={updateStateCount:result.updateStateMessages,commandsReceived:result.twitchCommandsReceived};
    result.scenarios.g={pass:result.twitchObserved===true&&result.vIsRefErrors>0&&result.updateStateMessages>0&&result.scenarios.a.pass&&result.scenarios.b.pass&&result.scenarios.c.every(r=>r.pass)&&result.scenarios.e.pass};
  }
  const allPass=result.scenarios.a.pass&&result.scenarios.b.pass&&result.scenarios.c.every(r=>r.pass)&&result.scenarios.e.pass&&(mode==='fallback'?result.scenarios.g.pass:result.scenarios.d.pass&&result.scenarios.f.pass);
  result.verdict=allPass?'PASS':'FAIL';if(!allPass)result.failReason='scenario-failed';
  progress('done');await done(allPass?0:1);
}catch(e){result.errors.push(String(e?.stack||e));result.stderr=errTail;result.verdict='FAIL';result.failReason='exception';await done(2);}
