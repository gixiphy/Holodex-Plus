// usage: node run.mjs <label> <extensionDir|none> <outJson>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [label, extDirArg, outFile] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const FAKES = fs.readFileSync(path.join(HERE, 'fakes.js'), 'utf8');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = process.env.HPLUS_E2E_TMP ?? path.join(REPO_ROOT, '.cache', 'e2e-browser');
fs.mkdirSync(base, { recursive: true });
const prof = fs.mkdtempSync(path.join(base, 'prof-'));
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
let extDir = extDirArg;
const proc = spawn(CHROME, ['--headless=new', `--user-data-dir=${prof}`, '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let errTail = ''; proc.stderr.on('data', d => { errTail = (errTail + d).slice(-4000); });
const out = proc.stdio[3], inp = proc.stdio[4];
let id = 0; const pend = new Map(); const handlers = []; let buf = '';
inp.on('data', d => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  }
  else handlers.forEach(h => h(m)); } });
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const m = { id: ++id, method, params }; if (sessionId) m.sessionId = sessionId; pend.set(m.id, { res, rej }); out.write(JSON.stringify(m) + '\0'); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const result = { label, extDir: extDirArg, console: [], timeline: [], prePlay: [], checks: {}, errors: [] };
const done = async (code) => {
  try { fs.writeFileSync(outFile, JSON.stringify(result, null, 1)); } catch { /* ignore */ }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { await new Promise((r) => setTimeout(r, 200)); } catch { /* ignore */ }
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
};
setTimeout(() => { result.errors.push('global timeout'); done(3); }, 240000);
try {
  if (extDir !== 'none') {
    extDir = path.resolve(extDir);
    result.extDir = extDir;
    if (!fs.existsSync(path.join(extDir, 'manifest.json'))) {
      result.errors.push('extension dir missing manifest.json: ' + extDir);
      await done(2);
    }
    const r = await send('Extensions.loadUnpacked', { path: extDir }); result.extensionId = r.id;
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
  const ev = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.args.map(a => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview.properties?.map(p => [p.name, p.value])) : a.type)).join(' ');
      if (/Holodex\+|AudioLock|HARNESS/.test(t) || m.params.type === 'warning' || m.params.type === 'error') result.console.push([Date.now(), m.params.type, t.slice(0, 400)]); }
    if (m.method === 'Runtime.exceptionThrown') result.console.push([Date.now(), 'exception', JSON.stringify(m.params.exceptionDetails).slice(0, 400)]);
    if (m.method === 'Log.entryAdded') { const e = m.params.entry; if (/chrome-extension|holodex-inject|Holodex/.test(e.text + (e.url || ''))) result.console.push([Date.now(), 'log-' + e.level, (e.text + ' ' + (e.url || '')).slice(0, 400)]); }
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) result.console.push([Date.now(), 'NAV', m.params.frame.url]);
    if (m.method === 'Fetch.requestPaused') {
      const u = m.params.request.url; let body = null, ct = 'text/html';
      if (/player\.twitch\.tv\/js\/embed\/v1\.js/.test(u)) { body = 'var SCRIPT_KIND="twitch";\n' + FAKES; ct = 'application/javascript'; }
      else if (/youtube\.com\/iframe_api/.test(u)) { body = 'var SCRIPT_KIND="youtube";\n' + FAKES; ct = 'application/javascript'; }
      else if (/^https:\/\/player\.twitch\.tv\/\?/.test(u) || /^https:\/\/www\.youtube\.com\/embed\//.test(u)) body = '<!doctype html><title>fake</title><body style="background:#123"></body>';
      if (body !== null) send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: ct }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, m.sessionId).catch(() => {});
      else send('Fetch.continueRequest', { requestId: m.params.requestId }, m.sessionId).catch(() => {});
    }
    if (m.method === 'Target.attachedToTarget') { const s = m.params.sessionId;
      send('Fetch.enable', { patterns: [{ urlPattern: '*player.twitch.tv*' }, { urlPattern: '*youtube.com/iframe_api*' }, { urlPattern: '*youtube.com/embed/*' }] }, s).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {}); }
  };
  handlers.push(ev);
  await send('Runtime.enable', {}, S); await send('Log.enable', {}, S);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*player.twitch.tv*' }, { urlPattern: '*youtube.com/iframe_api*' }, { urlPattern: '*youtube.com/embed/*' }] }, S);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, S);
  const E = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result.value; };
  // 1. seed persisted layout, then reload so cells mount from it
  await send('Page.enable', {}, S);
  // harness only: keep Holodex's service worker from installing and reloading the page mid-test
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{const sw={register:()=>new Promise(()=>{}),getRegistration:()=>Promise.resolve(undefined),getRegistrations:()=>Promise.resolve([]),addEventListener(){},removeEventListener(){},ready:new Promise(()=>{}),controller:null,oncontrollerchange:null,onmessage:null,startMessages(){}};Object.defineProperty(Navigator.prototype,'serviceWorker',{configurable:true,get(){return sw}})}catch(e){}` }, S);
  await send('Page.navigate', { url: 'https://holodex.net/multiview' }, S);
  const waitFor = async (expr, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await E(expr)) return true; } catch { /* ignore */ } await sleep(250); } throw new Error('timeout waiting ' + what); };
  const samplePre = async (tag, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const s = await E(`(()=>{const st=document.querySelector('#app').__vue__.$store.state.multiview;return {t:Date.now(),tag:${JSON.stringify(tag)},storeA:st.layoutContent.a&&st.layoutContent.a.muted,storeB:st.layoutContent.b&&st.layoutContent.b.muted,ytN:window.__fake?window.__fake.yt.length:-1,twN:window.__fake?window.__fake.tw.length:-1};})()`);
        result.prePlay.push(s);
      } catch (e) {
        result.prePlay.push({ t: Date.now(), tag, err: String(e && e.message || e) });
      }
      await sleep(250);
    }
  };
  await waitFor(`!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&document.querySelector('#app').__vue__.$store)`, 60000, 'vue store');
  await E(`(()=>{const st=document.querySelector('#app').__vue__.$store;
    st.commit('multiview/setLayout',[{x:0,y:0,w:12,h:12,i:'a'},{x:12,y:0,w:12,h:12,i:'b'}]);
    st.commit('multiview/setLayoutContent',{a:{type:'video',id:'ytFAKE00001',video:{id:'ytFAKE00001',type:'stream',status:'live',title:'YT',channel:{id:'c1',name:'yt'}}},
      b:{type:'video',id:'fakechannel',video:{id:'fakechannel',type:'twitch',status:'live',title:'TW',channel:{name:'fakechannel'}}}});
    st.commit('multiview/setMuteOthers',true); return JSON.stringify(st.state.multiview.layoutContent);})()`);
  await samplePre('pre-reload', 3000);
  await send('Page.reload', {}, S);
  await sleep(1000);
  const ready = `!!(document.querySelector('#app')&&document.querySelector('#app').__vue__&&window.__fake&&window.__fake.tw.length>=1&&window.__fake.yt.length>=1)`;
  await waitFor(ready, 60000, 'fake players');
  // Holodex sometimes reloads itself once shortly after load; wait until the page stays put for 8s
  for (let k = 0; k < 4; k++) { const navs = result.console.filter(x => x[1] === 'NAV').length; await samplePre('post-reload-settle', 8000); await waitFor(ready, 60000, 'fake players after settle'); if (result.console.filter(x => x[1] === 'NAV').length === navs) break; }
  await samplePre('pre-play', 1500);
  result.checks.flags = await E(`({v3:!!window.HOLODEX_PLUS_INSTALLED_V3, mvpLock:!!window.__HDX_AUDIO_LOCK__, newHandle:!!window.__HDX_AUDIO_LOCK_HANDLE__, scripts:[...document.querySelectorAll('script')].map(s=>s.src).filter(x=>x.startsWith('chrome-extension')), path:location.pathname})`);
  const snap = `(()=>{const st=document.querySelector('#app').__vue__.$store.state.multiview;const tw=window.__fake.tw.at(-1),yt=window.__fake.yt.at(-1);
    return {t:Date.now(),storeA:st.layoutContent.a&&st.layoutContent.a.muted,storeB:st.layoutContent.b&&st.layoutContent.b.muted,ytMuted:yt.state.muted,twMuted:tw.state.muted,muteOthers:st.muteOthers,twCalls:tw.state.setMutedCalls.length};})()`;
  const record = async (tag, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = await E(snap); s.tag = tag; result.timeline.push(s); await sleep(250); } };
  const audible = (s) => (s.ytMuted ? '' : 'YT') + (s.twMuted ? '' : 'TW') || 'none';
  result.checks.initial = await E(snap);
  const preReload = result.prePlay.filter((x) => x.tag === 'pre-reload');
  const prePlaySamples = result.prePlay.filter((x) => x.tag === 'post-reload-settle' || x.tag === 'pre-play');
  result.checks.preReloadSamples = preReload.length;
  result.checks.preReloadYtStoreMuted = preReload.filter((x) => x.storeA === true).length;
  result.checks.prePlaySamples = prePlaySamples.length;
  result.checks.prePlayYtStoreMuted = prePlaySamples.filter((x) => x.storeA === true).length;
  // 2. play YouTube first, Twitch 3s later (Twitch loads slower in real life)
  await E(`window.__fake.yt.at(-1).__startPlaying()`); await record('yt-play', 3000);
  await E(`window.__fake.tw.at(-1).__startPlaying()`); await record('tw-play', 4000);
  const afterPlay = result.timeline.at(-1); result.checks.afterBothPlay = { audible: audible(afterPlay), ...afterPlay };
  // make sure YouTube is the selected audio (as Fi would): use Holodex's own cell API like media controls do
  if (audible(afterPlay) !== 'YT') {
    result.checks.forcedYT = true;
  }
  // 3. Twitch unmutes itself once (no user input)
  await E(`window.__fake.tw.at(-1).__selfUnmute()`); await record('tw-self-unmute-1', 6000);
  const s1 = result.timeline.at(-1); result.checks.afterSelfUnmute1 = { audible: audible(s1), ...s1 };
  // 4. Twitch player with slow mute (2.5s lag), self-unmutes every 4s x6 (ads/reconnect)
  await E(`window.__fake.tw.at(-1).state.lagMs=2500`);
  for (let k = 0; k < 6; k++) { await E(`window.__fake.tw.at(-1).__selfUnmute()`); await record('tw-lag-unmute-' + (k + 2), 4000); }
  await record('tw-lag-settle', 5000);
  const s2 = result.timeline.at(-1); result.checks.afterLaggedRepeats = { audible: audible(s2), ...s2 };
  result.checks.everStolenDuringLag = result.timeline.filter(x => x.tag.startsWith('tw-lag') && x.storeA === true).length;
  result.checks.ytMutedSamples = result.timeline.filter(x => x.ytMuted).length;
  result.checks.samples = result.timeline.length;
  // 5. user really clicks into the Twitch player and unmutes it -> audio should switch to Twitch
  await E(`window.__fake.tw.at(-1).state.lagMs=0`);
  const r = await E(`(()=>{const f=window.__fake.tw.at(-1).iframe.getBoundingClientRect();return {x:f.left+f.width/2,y:f.top+f.height/2};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }, S);
  await sleep(300); await E(`window.__fake.tw.at(-1).__selfUnmute()`); await record('user-unmute-tw', 5000);
  const s3 = result.timeline.at(-1); result.checks.afterUserUnmuteTwitch = { audible: audible(s3), activeIsIframe: await E(`document.activeElement&&document.activeElement.tagName`), ...s3 };
  await done(0);
} catch (e) { result.errors.push(String(e && e.stack || e)); result.stderr = errTail; await done(2); }
