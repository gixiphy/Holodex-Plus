// usage: node live-compare.mjs <json...>
import fs from 'node:fs';
import { mvpHasSameHostException } from './live-exceptions.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node live-compare.mjs <json...>');
  process.exit(2);
}

const loaded = files.map((f) => ({ file: f, json: JSON.parse(fs.readFileSync(f, 'utf8')) }));
const mvp = loaded.find((row) => /mvp|holodex-plus-audiolock/i.test(`${row.json.label || ''} ${row.json.extDir || ''}`));
const mvpHost = mvp?.json.hostExceptions || [];

const mark = (s) => {
  if (!s) return 'SKIP';
  if (s.pass === true) return 'PASS';
  if (s.pass === false) return 'FAIL';
  return 'SKIP';
};

const rows = loaded.map((row) => {
  const j = row.json;
  const c = j.scenarios?.c || [];
  const pending = j.scenarios?.f?.hostAllowedPendingMvp || j.hostAllowedPendingMvp || [];
  const isMvp = mvp && row.file === mvp.file;
  const missing = isMvp ? [] : pending.filter((entry) => !mvpHasSameHostException(entry, mvpHost));
  const fHostMvpMatch = missing.length === 0;
  let fCell = mark(j.scenarios?.f);
  if (!isMvp && missing.length > 0) fCell = 'FAIL(mvp-missing)';
  let effectiveVerdict = j.verdict || 'FAIL';
  if (!isMvp && j.verdict === 'PASS' && !fHostMvpMatch) effectiveVerdict = 'FAIL';
  const probe = (j.fallbackProbe || []).at(-1);
  return {
    file: row.file,
    label: j.label,
    mode: j.mode,
    verdict: j.verdict,
    effectiveVerdict,
    fHostMvpMatch,
    fCell,
    a: mark(j.scenarios?.a),
    b: mark(j.scenarios?.b),
    c1: mark(c[0]),
    c2: mark(c[1]),
    c3: mark(c[2]),
    d: mark(j.scenarios?.d),
    e: mark(j.scenarios?.e),
    g: mark(j.scenarios?.g),
    vIsRefErrors: j.vIsRefErrors,
    twitchObserved: j.twitchObserved,
    ytMutedSamples: j.scenarios?.a?.ytMutedSamples,
    twitchCommandsReceived: j.twitchCommandsReceived,
    updateStateMessages: j.updateStateMessages,
    centerClickSwitch: j.scenarios?.bPrime?.centerClickSwitch,
    scenarioErrors: (j.scenarioErrors || []).length,
    hostExceptions: (j.hostExceptions || []).length,
    extensionExceptions: (j.extensionExceptions || []).length,
    inputFallback: c[1]?.inputFallback ?? null,
    twitchMountRecovered: j.twitchMountRetry ? j.twitchMountRetry.recovered : null,
    probe,
    cMeta: c.map((r) => ({
      round: r.round,
      precondition: r.precondition,
      switchedInMs: r.switchedInMs,
      inputFallback: r.inputFallback ?? null,
      pass: r.pass,
    })),
  };
});

console.log(
  [
    'label',
    'mode',
    'verdict',
    'effectiveVerdict',
    'a',
    'b',
    'c1',
    'c2',
    'c3',
    'd',
    'e',
    'f',
    'g',
    'fHostMvpMatch',
    'vIsRef',
    'observed',
    'ytMuted',
    'scenarioErr',
    'hostEx',
    'extEx',
  ].join('\t'),
);
for (const r of rows) {
  console.log(
    [
      r.label,
      r.mode,
      r.verdict,
      r.effectiveVerdict,
      r.a,
      r.b,
      r.c1,
      r.c2,
      r.c3,
      r.d,
      r.e,
      r.fCell,
      r.g,
      r.fHostMvpMatch,
      r.vIsRefErrors,
      r.twitchObserved,
      r.ytMutedSamples,
      r.scenarioErrors,
      r.hostExceptions,
      r.extensionExceptions,
    ].join('\t'),
  );
  if (r.centerClickSwitch) {
    console.log('  centerClickSwitch', JSON.stringify(r.centerClickSwitch));
  }
  for (const cm of r.cMeta) {
    console.log(
      '  c' + cm.round,
      'precondition=' + cm.precondition,
      'switchedInMs=' + cm.switchedInMs,
      'inputFallback=' + cm.inputFallback,
      'pass=' + cm.pass,
    );
  }
  console.log('  twitchMountRetry.recovered', r.twitchMountRecovered);
  if (r.mode === 'fallback' && r.probe) {
    console.log(
      '  fallbackProbe',
      JSON.stringify({
        at: r.probe.at,
        twPlayerSet: r.probe.twPlayerSet,
        instHasOb: r.probe.instHasOb,
        readyListeners: r.probe.readyListeners,
        wrapperInstalled: r.probe.wrapperInstalled,
      }),
    );
  }
  console.log(
    '  cmds',
    JSON.stringify(r.twitchCommandsReceived),
    'updates',
    r.updateStateMessages,
  );
}

process.exit(rows[0]?.effectiveVerdict === 'PASS' ? 0 : 1);
