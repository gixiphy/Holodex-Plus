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
      if (/Holodex\+|AudioLock/.test(t)) {
        result.audioLockWarnings.push({ t: Date.now(), type: m.params.type, text: t.slice(0, 400) });
      }
      if (/__v_isRef/.test(t) && /SecurityError|Blocked a frame/i.test(t)) {
        result.vIsRefErrors += 1;
      }
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const desc = JSON.stringify(m.params.exceptionDetails || {}).slice(0, 400);
      if (/__v_isRef/.test(desc)) result.vIsRefErrors += 1;
      result.errors.push(['exception', desc]);
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
      send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
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

  await send('Runtime.evaluate', {
    expression: `(()=>{if(window.__hplusUpdateCount!=null)return;window.__hplusUpdateCount=0;window.__hplusLastMuted=null;window.addEventListener('message',e=>{try{if(e.origin!=='https://player.twitch.tv')return;const d=e.data;if(!d||d.namespace!=='twitch-embed-player-proxy'||d.eventName!=='UPDATE_STATE')return;window.__hplusUpdateCount++;if(d.params&&typeof d.params.muted==='boolean')window.__hplusLastMuted=d.params.muted;}catch{}})})()`,
  }, S);

  const E = async (expr, sessionId = S) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };

  const waitFor = async (expr, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await E(expr)) return true; } catch { /* ignore */ }
      await sleep(250);
    }
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

  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, S);
    }
  };

  const iframeBox = async (which) => E(`(()=>{
    const ifr=[...document.querySelectorAll('iframe')];
    const hit=ifr.find(f=>${which === 'youtube'
      ? `/youtube\\.com\\/embed\\/|youtube-nocookie\\.com\\/embed\\//.test(f.src)`
      : `/player\\.twitch\\.tv/.test(f.src)`});
    if(!hit)return null;
    const r=hit.getBoundingClientRect();
    return {x:r.left,y:r.top,w:r.width,h:r.height,src:hit.src};
  })()`);

  const waitSession = async (which, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (iframeSessions.has(which)) return iframeSessions.get(which);
      // refresh from Target.getTargets in case attach event was missed
      try {
        const tg = await send('Target.getTargets');
        for (const t of tg.targetInfos || []) {
          const url = t.url || '';
          if (which === 'twitch' && /player\.twitch\.tv/.test(url)) {
            const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
            iframeSessions.set('twitch', sessionId);
            await send('Runtime.enable', {}, sessionId);
            await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
            return sessionId;
          }
          if (which === 'youtube' && /youtube\.com\/embed\/|youtube-nocookie\.com\/embed\//.test(url)) {
            const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
            iframeSessions.set('youtube', sessionId);
            await send('Runtime.enable', {}, sessionId);
            await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
            return sessionId;
          }
        }
      } catch { /* ignore */ }
      await sleep(500);
    }
    return null;
  };

  const readVideo = async (which) => {
    let sid = iframeSessions.get(which);
    if (!sid) sid = await waitSession(which, 2000);
    if (!sid) return null;
    try {
      return await E(`(()=>{const vs=[...document.querySelectorAll('video')];
        const v=vs.find(x=>x.readyState>0)||vs[0];
        if(!v)return {muted:null,volume:null,paused:true,readyState:0,currentTime:0,currentSrcEmpty:true,videoCount:vs.length};
        return {muted:v.muted,volume:v.volume,paused:v.paused,readyState:v.readyState,currentTime:v.currentTime,currentSrcEmpty:!v.currentSrc,videoCount:vs.length};
      })()`, sid);
    } catch {
      return null;
    }
  };

  const clickPlay = async (which) => {
    const box = await iframeBox(which);
    if (!box) throw new Error('no iframe for ' + which);
    const sid = iframeSessions.get(which) || await waitSession(which, 5000);
    if (sid) {
      await send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }
    // hover to reveal controls
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
    }, S);
    await sleep(400);
    let btn = null;
    if (sid) {
      try {
        btn = await E(`(()=>{
          const sels=${which === 'youtube'
            ? `['.ytp-large-play-button','button.ytp-play-button']`
            : `['button[data-a-target="player-play-pause-button"]','button[data-a-target="player-overlay-play-button"]','.click-to-play','.player-overlay-play']`};
          for(const sel of sels){const el=document.querySelector(sel);if(el){const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,sel};}}
          return null;
        })()`, sid);
      } catch { /* ignore */ }
    }
    const pts = [];
    if (btn) pts.push({ x: box.x + btn.x, y: box.y + btn.y, how: btn.sel });
    pts.push({ x: box.x + box.w / 2, y: box.y + box.h / 2, how: 'center' });
    result.clickPoints[which + 'Play'] = pts;
    for (const pt of pts) {
      await clickAt(pt.x, pt.y);
      await sleep(300);
    }
    await clickAt(blankClick.x, blankClick.y);
  };

  const waitPlaying = async (which, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await readVideo(which);
      if (v && !v.paused && v.readyState >= 2) return v;
      await sleep(500);
    }
    return null;
  };

  // Wait for youtube iframe attach + play
  await waitFor(`!![...document.querySelectorAll('iframe')].find(f=>/youtube\\.com\\/embed\\/|youtube-nocookie\\.com\\/embed\\//.test(f.src))`, 60000, 'yt iframe');
  await waitSession('youtube', 30000);
  await sleep(2000);
  await clickPlay('youtube');
  let ytPlaying = await waitPlaying('youtube', 45000);
  if (!ytPlaying) {
    await clickPlay('youtube');
    ytPlaying = await waitPlaying('youtube', 20000);
  }
  if (!ytPlaying) {
    // pick alternate live from Holodex home (max 2 more = 3 total with default)
    result.picks.defaultFailed = {
      youtubeId,
      session: iframeSessions.has('youtube'),
      lastVideo: await readVideo('youtube'),
      iframe: await iframeBox('youtube'),
    };
    const alts = await E(`(()=>{
      try{
        const links=[...document.querySelectorAll('a[href*=\"/watch/\"]')].map(a=>a.getAttribute('href')).filter(Boolean);
        const ids=[];
        for(const h of links){const m=h.match(/\\/watch\\/([\\w-]{6,})/);if(m&&!ids.includes(m[1]))ids.push(m[1]);if(ids.length>=5)break;}
        return ids;
      }catch(e){return []}
    })()`).catch(() => []);
    let ok = false;
    for (const alt of (alts || []).slice(0, 2)) {
      if (alt === youtubeId) continue;
      result.picks.tried = [...(result.picks.tried || []), alt];
      await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;const id=${JSON.stringify(alt)};
        st.commit('multiview/setLayout',[{x:0,y:0,w:24,h:24,i:'a'}]);
        st.commit('multiview/setLayoutContent',{a:{type:'video',id,video:{id,type:'stream',status:'live',title:'YT',channel:{id:'c1',name:'yt'}},muted:false}});
        return id;})()`);
      iframeSessions.delete('youtube');
      await sleep(3000);
      await waitSession('youtube', 20000);
      await clickPlay('youtube');
      ytPlaying = await waitPlaying('youtube', 30000);
      if (ytPlaying) {
        result.picks.youtube = alt;
        result.picks.method = 'holodex-live-card';
        ok = true;
        break;
      }
    }
    if (!ok) {
      result.verdict = 'SKIP';
      result.skipReason = 'no-live-youtube';
      await done(4);
    }
  }

  // Calibration YouTube (mute-others off so lock does not fight the toggle)
  await E(`document.querySelector('#app').__vue__.$store.commit('multiview/setMuteOthers', false)`);
  const ytBefore = await readVideo('youtube');
  const ytBox = await iframeBox('youtube');
  if (ytBox) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ytBox.x + ytBox.w / 2, y: ytBox.y + ytBox.h - 30 }, S);
    await sleep(400);
  }
  const ytMuteBtn = iframeSessions.get('youtube')
    ? await E(`(()=>{const el=document.querySelector('.ytp-mute-button,button.ytp-mute-button');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`, iframeSessions.get('youtube')).catch(() => null)
    : null;
  if (ytMuteBtn && ytBox) {
    await clickAt(ytBox.x + ytMuteBtn.x, ytBox.y + ytMuteBtn.y);
    await sleep(800);
  } else if (ytBox) {
    // fallback: press 'm' while iframe focused
    await clickAt(ytBox.x + ytBox.w / 2, ytBox.y + ytBox.h / 2);
    await sleep(200);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'm', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }, S);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }, S);
    await sleep(800);
  }
  const ytAfter = await readVideo('youtube');
  const ytCalOk = ytBefore && ytAfter && (ytBefore.muted !== ytAfter.muted || Math.abs((ytBefore.volume || 0) - (ytAfter.volume || 0)) > 0.01);
  // restore audible if we muted
  if (ytAfter && ytAfter.muted) {
    if (ytMuteBtn && ytBox) {
      await clickAt(ytBox.x + ytMuteBtn.x, ytBox.y + ytMuteBtn.y);
      await sleep(400);
    }
  }
  await clickAt(blankClick.x, blankClick.y);
  result.calibration.youtube = { ok: !!ytCalOk, before: ytBefore, after: ytAfter };
  await E(`document.querySelector('#app').__vue__.$store.commit('multiview/setMuteOthers', true)`);

  scenarioAStarted = true;

  // Add Twitch cell
  await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;
    st.commit('multiview/setLayout',[{x:0,y:0,w:12,h:24,i:'a'},{x:12,y:0,w:12,h:24,i:'b'}]);
    st.commit('multiview/setLayoutContentById',{id:'b',content:{type:'video',id:${JSON.stringify(twitchChannel)},video:{id:${JSON.stringify(twitchChannel)},type:'twitch',status:'live',title:'TW',channel:{name:${JSON.stringify(twitchChannel)}}}}});
    return true;})()`);

  await waitFor(`!![...document.querySelectorAll('iframe')].find(f=>/player\\.twitch\\.tv/.test(f.src))`, 60000, 'twitch iframe');
  await waitSession('twitch', 30000);
  await sleep(3000);
  await clickPlay('twitch');
  let twPlaying = await waitPlaying('twitch', 45000);
  if (!twPlaying) {
    await clickPlay('twitch');
    twPlaying = await waitPlaying('twitch', 20000);
  }
  if (!twPlaying) {
    result.picks.twitchFailed = {
      channel: twitchChannel,
      session: iframeSessions.has('twitch'),
      lastVideo: await readVideo('twitch'),
      iframe: await iframeBox('twitch'),
    };
    // try up to 2 alternate channels from Twitch directory
    await send('Page.navigate', { url: 'https://www.twitch.tv/directory/all' }, S);
    await sleep(4000);
    const channels = await E(`(()=>{
      const cards=[...document.querySelectorAll('a[href^=\"/\"]')].map(a=>a.getAttribute('href')||'');
      const names=[];
      for(const h of cards){
        const m=h.match(/^\\/([A-Za-z0-9_]{3,25})$/);
        if(m && !['directory','videos','downloads','jobs','p','prime','turbo','settings','search','privacy','warranty'].includes(m[1].toLowerCase())){
          if(!names.includes(m[1])) names.push(m[1]);
        }
        if(names.length>=10)break;
      }
      return names;
    })()`).catch(() => []);
    await send('Page.navigate', { url: 'https://holodex.net/multiview' }, S);
    await waitFor(
      `!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&document.querySelector('#app').__vue__.$store)`,
      60000,
      'vue after twitch pick',
    );
    await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;const yt=${JSON.stringify(result.picks.youtube)};
      st.commit('multiview/setLayout',[{x:0,y:0,w:12,h:24,i:'a'},{x:12,y:0,w:12,h:24,i:'b'}]);
      st.commit('multiview/setLayoutContent',{a:{type:'video',id:yt,video:{id:yt,type:'stream',status:'live',title:'YT',channel:{id:'c1',name:'yt'}},muted:false}});
      st.commit('multiview/setMuteOthers',true);
      return true;})()`);
    let okTw = false;
    for (const ch of (channels || []).slice(0, 2)) {
      if (ch === twitchChannel) continue;
      result.picks.triedTwitch = [...(result.picks.triedTwitch || []), ch];
      await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;const ch=${JSON.stringify(ch)};
        st.commit('multiview/setLayoutContentById',{id:'b',content:{type:'video',id:ch,video:{id:ch,type:'twitch',status:'live',title:'TW',channel:{name:ch}}}});
        return ch;})()`);
      iframeSessions.delete('twitch');
      await sleep(4000);
      await waitSession('twitch', 20000);
      await clickPlay('youtube');
      await waitPlaying('youtube', 20000);
      await clickPlay('twitch');
      twPlaying = await waitPlaying('twitch', 30000);
      if (twPlaying) {
        result.picks.twitch = ch;
        result.picks.method = (result.picks.method || '') + '+twitch-directory';
        okTw = true;
        break;
      }
    }
    if (!okTw) {
      result.verdict = 'SKIP';
      result.skipReason = 'no-live-twitch';
      await done(4);
    }
  }

  // Calibration Twitch with mute-others off so remute does not hide the toggle
  await E(`document.querySelector('#app').__vue__.$store.commit('multiview/setMuteOthers', false)`);
  const twBefore = await readVideo('twitch');
  const twBox = await iframeBox('twitch');
  if (twBox) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: twBox.x + twBox.w / 2, y: twBox.y + twBox.h - 40 }, S);
    await sleep(500);
  }
  const twMuteBtn = iframeSessions.get('twitch')
    ? await E(`(()=>{const el=document.querySelector('button[data-a-target="player-mute-unmute-button"],button[aria-label*="Mute"],button[aria-label*="Unmute"],button[aria-label*="靜音"],button[aria-label*="静音"]');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,label:el.getAttribute('aria-label')};})()`, iframeSessions.get('twitch')).catch(() => null)
    : null;
  result.clickPoints.twitchMute = twMuteBtn && twBox
    ? { x: twBox.x + twMuteBtn.x, y: twBox.y + twMuteBtn.y, label: twMuteBtn.label }
    : null;
  if (twMuteBtn && twBox) {
    await clickAt(twBox.x + twMuteBtn.x, twBox.y + twMuteBtn.y);
    await sleep(1000);
  } else if (twBox) {
    await clickAt(twBox.x + twBox.w / 2, twBox.y + twBox.h / 2);
    await sleep(200);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'm', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }, S);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 }, S);
    await sleep(1000);
  }
  const twAfter = await readVideo('twitch');
  const twCalOk = twBefore && twAfter && (twBefore.muted !== twAfter.muted || Math.abs((twBefore.volume || 0) - (twAfter.volume || 0)) > 0.01);
  result.calibration.twitch = { ok: !!twCalOk, before: twBefore, after: twAfter };
  // restore muted Twitch before re-enabling lock
  if (twAfter && !twAfter.muted && twMuteBtn && twBox) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: twBox.x + twBox.w / 2, y: twBox.y + twBox.h - 40 }, S);
    await sleep(300);
    await clickAt(twBox.x + twMuteBtn.x, twBox.y + twMuteBtn.y);
    await sleep(500);
  }
  await clickAt(blankClick.x, blankClick.y);
  await E(`document.querySelector('#app').__vue__.$store.commit('multiview/setMuteOthers', true)`);
  if (!ytCalOk || !twCalOk) {
    result.verdict = 'FAIL';
    result.failReason = 'truth-method-invalid';
    await done(1);
  }

  const sampleOnce = async () => {
    const yt = await readVideo('youtube');
    const tw = await readVideo('twitch');
    const store = await E(`(()=>{const st=document.querySelector('#app').__vue__.$store.state.multiview;return{a:st.layoutContent.a&&st.layoutContent.a.muted,b:st.layoutContent.b&&st.layoutContent.b.muted,muteOthers:st.muteOthers};})()`);
    const audible = (v) => !!(v && !v.paused && v.readyState >= 2 && !v.muted && (v.volume == null || v.volume > 0.01));
    return {
      t: Date.now(),
      yt,
      tw,
      store,
      ytAudible: audible(yt),
      twAudible: audible(tw),
      ytMutedVideo: !!(yt && yt.muted),
    };
  };

  const sampleFor = async (ms) => {
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      samples.push(await sampleOnce());
      await sleep(250);
    }
    return samples;
  };

  const refreshCounters = async () => {
    result.updateStateMessages = await E(`window.__hplusUpdateCount||0`);
    const sid = iframeSessions.get('twitch');
    if (sid) {
      const c = await E(`window.__hplusCmdCount||{mute:0,unmute:0}`, sid).catch(() => ({ mute: 0, unmute: 0 }));
      result.twitchCommandsReceived = c;
    }
  };

  result.twitchObserved = await E(`(()=>{
    function walk(vm,fn){fn(vm);for(const c of vm.$children||[])walk(c,fn)}
    const root=document.querySelector('#app').__vue__.$root;
    let found=null;
    walk(root,vm=>{if(vm.$options&&vm.$options.name==='TwitchPlayer'&&vm.player)found=vm.player});
    if(!found)return null;
    return Object.prototype.hasOwnProperty.call(found,'__ob__');
  })()`);

  // Scenario a
  const aSamples = await sampleFor(45000);
  const aYtMuted = aSamples.filter((s) => s.ytMutedVideo).length;
  const aStoreATrue = aSamples.filter((s) => s.store.a === true).length;
  const aTwAudible = aSamples.filter((s) => s.twAudible).length;
  const aLast = aSamples[aSamples.length - 1];
  const aTwitchPlayed = aSamples.some((s) => s.tw && !s.tw.paused && s.tw.readyState >= 2);
  const aAudibleLimit = mode === 'fallback' ? 8 : 4;
  const aPass =
    aTwitchPlayed &&
    aYtMuted === 0 &&
    aStoreATrue === 0 &&
    aTwAudible <= aAudibleLimit &&
    aLast && aLast.ytAudible && !aLast.twAudible &&
    (mode !== 'fallback' || result.twitchObserved === true) &&
    (mode === 'fallback' || result.twitchObserved === false);
  result.scenarios.a = {
    pass: !!aPass,
    ytMutedSamples: aYtMuted,
    storeATrueSamples: aStoreATrue,
    twAudibleSamples: aTwAudible,
    twitchPlayed: aTwitchPlayed,
    last: aLast,
    twitchObserved: result.twitchObserved,
  };

  if (mode === 'fallback') {
    if (result.twitchObserved !== true || result.vIsRefErrors <= 0) {
      result.verdict = 'FAIL';
      result.failReason = 'fallback-not-triggered';
      result.scenarios.g = { pass: false, failReason: 'fallback-not-triggered' };
      await done(1);
    }
  }

  // b′ only for MVP (path contains audiolock and not dist_chrome)
  const isMvp = /holodex-plus-audiolock|mvp/i.test(String(extDirArg));
  if (isMvp && mode === 'normal') {
    const box = await iframeBox('twitch');
    if (box) {
      await clickAt(box.x + box.w / 2, box.y + box.h / 2);
      await sleep(200);
      await clickAt(blankClick.x, blankClick.y);
    }
    const bp = await sampleFor(3000);
    const last = bp[bp.length - 1];
    result.scenarios.bPrime = {
      centerClickSwitch: {
        storeA: last?.store?.a,
        storeB: last?.store?.b,
        twitchVideoMuted: last?.tw?.muted,
        youtubeVideoMuted: last?.yt?.muted,
      },
    };
  }

  // Scenario b: unmute Twitch via its mute button
  await refreshCounters();
  const updatesBeforeB = result.updateStateMessages;
  if (twBox) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: twBox.x + twBox.w / 2, y: twBox.y + 20 }, S);
    await sleep(500);
  }
  const mutePt = result.clickPoints.twitchMute;
  if (mutePt) {
    await clickAt(mutePt.x, mutePt.y);
    await sleep(200);
    await clickAt(blankClick.x, blankClick.y);
  }
  const bSamples = await sampleFor(3000);
  const bHold = await sampleFor(3000);
  const bOk = bSamples.some((s) => s.twAudible && !s.ytAudible) &&
    bHold.every((s) => s.twAudible && !s.ytAudible);
  await refreshCounters();
  result.scenarios.b = {
    pass: !!bOk,
    samples: bSamples.slice(-3),
    hold: bHold.slice(-3),
    updateStateDelta: result.updateStateMessages - updatesBeforeB,
  };

  // Scenario c: reverse switch x3
  const cRounds = [];
  for (let round = 1; round <= 3; round++) {
    await refreshCounters();
    const muteBefore = result.twitchCommandsReceived.mute;
    if (round === 2) {
      // YouTube mute button
      const yb = await iframeBox('youtube');
      const ym = iframeSessions.get('youtube')
        ? await E(`(()=>{const el=document.querySelector('.ytp-mute-button');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`, iframeSessions.get('youtube')).catch(() => null)
        : null;
      if (yb && ym) {
        await clickAt(yb.x + ym.x, yb.y + ym.y);
        await sleep(200);
        await clickAt(blankClick.x, blankClick.y);
      }
    } else {
      // Holodex media controls: open via cell UI if possible, else setMuted via store cell API
      await E(`(()=>{
        const root=document.querySelector('#app').__vue__.$root;
        function walk(vm,fn){fn(vm);for(const c of vm.$children||[])walk(c,fn)}
        let cellA=null;
        walk(root,vm=>{if(vm.$options&&vm.$options.name&&/VideoCell/.test(vm.$options.name)&&String(vm.item&&vm.item.i)==='a')cellA=vm});
        if(cellA&&typeof cellA.setMuted==='function'){cellA.setMuted(false);return 'cell';}
        const st=document.querySelector('#app').__vue__.$store;
        st.commit('multiview/setLayoutContentWithKey',{id:'a',key:'muted',value:false});
        return 'store';
      })()`);
    }
    const tClick = Date.now();
    let switched = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const s = await sampleOnce();
      if (s.ytAudible && !s.twAudible) { switched = true; break; }
      await sleep(100);
    }
    const hold = await sampleFor(5000);
    const rebound = hold.some((s) => s.twAudible && !s.ytAudible);
    await refreshCounters();
    const muteDelta = result.twitchCommandsReceived.mute - muteBefore;
    const pass = switched && !rebound && (mode !== 'fallback' || muteDelta > 0);
    cRounds.push({
      round,
      method: round === 2 ? 'youtube-mute-button' : 'panel-or-cell-setMuted',
      pass: !!pass,
      switchedInMs: switched ? Date.now() - tClick : null,
      rebound,
      muteDelta,
    });
  }
  result.scenarios.c = cRounds;

  if (mode === 'normal') {
    // d reload
    await send('Page.reload', {}, S);
    await waitFor(
      `!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&document.querySelector('#app').__vue__.$store)`,
      60000,
      'vue after reload',
    );
    await sleep(2000);
    await clickPlay('youtube');
    await waitPlaying('youtube', 90000);
    await clickPlay('twitch');
    await waitPlaying('twitch', 90000);
    const dSamples = await sampleFor(20000);
    const dPass =
      dSamples.filter((s) => s.ytMutedVideo).length === 0 &&
      dSamples.filter((s) => s.twAudible).length <= 4 &&
      dSamples.every((s) => s.store.a !== true) &&
      dSamples.some((s) => s.store.b === true);
    result.scenarios.d = {
      pass: !!dPass,
      ytMutedSamples: dSamples.filter((s) => s.ytMutedVideo).length,
      twAudibleSamples: dSamples.filter((s) => s.twAudible).length,
    };

    // f remove twitch
    const exBefore = result.errors.length;
    await E(`document.querySelector('#app').__vue__.$store.commit('multiview/removeLayoutItem','b')`);
    await sleep(5000);
    const after = await sampleOnce();
    result.scenarios.f = {
      pass: result.errors.length === exBefore && after.ytAudible,
      newExceptions: result.errors.length - exBefore,
      youtubeStillAudible: after.ytAudible,
    };
  }

  // e console checks
  const degradedCodes = [
    'player-unavailable',
    'player-mute-did-not-settle',
    'store-did-not-settle',
    'restore-failed',
    'cell-contract-changed',
  ];
  const badWarns = result.audioLockWarnings.filter((w) =>
    degradedCodes.some((c) => String(w.text).includes(c)),
  );
  const contractWarns = result.audioLockWarnings.filter((w) =>
    String(w.text).includes('twitch-sdk-contract-changed'),
  );
  const ePass = mode === 'fallback'
    ? badWarns.length === 0 && contractWarns.length === 0
    : badWarns.length === 0 && result.vIsRefErrors === 0;
  result.scenarios.e = {
    pass: !!ePass,
    badWarns: badWarns.length,
    vIsRefErrors: result.vIsRefErrors,
    warnings: result.audioLockWarnings.slice(0, 20),
  };

  await refreshCounters();
  if (mode === 'fallback') {
    result.fallbackChannel = {
      updateStateCount: result.updateStateMessages,
      firstUpdateStateAt: null,
      commandsReceived: result.twitchCommandsReceived,
      observedViaIframeState: result.updateStateMessages > 0,
    };
    result.scenarios.g = {
      pass:
        result.twitchObserved === true &&
        result.scenarios.a.pass &&
        result.scenarios.b.pass &&
        cRounds.every((r) => r.pass) &&
        result.scenarios.e.pass,
    };
  }

  const allPass = mode === 'fallback'
    ? result.scenarios.g?.pass
    : result.scenarios.a.pass &&
      result.scenarios.b.pass &&
      cRounds.every((r) => r.pass) &&
      result.scenarios.d?.pass &&
      result.scenarios.e.pass &&
      result.scenarios.f?.pass;

  result.verdict = allPass ? 'PASS' : 'FAIL';
  if (!allPass) result.failReason = 'scenario-failed';
  await done(allPass ? 0 : 1);
} catch (e) {
  result.errors.push(String(e && e.stack || e));
  result.stderr = errTail;
  result.verdict = 'FAIL';
  result.failReason = 'exception';
  await done(2);
}
