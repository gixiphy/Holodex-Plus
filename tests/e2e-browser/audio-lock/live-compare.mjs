// usage: node live-compare.mjs <json...>
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node live-compare.mjs <json...>');
  process.exit(2);
}

const rows = files.map((f) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = j.scenarios?.c || [];
  const mark = (s) => {
    if (!s) return 'SKIP';
    if (s.pass === true) return 'PASS';
    if (s.pass === false) return 'FAIL';
    return 'SKIP';
  };
  return {
    file: f,
    label: j.label,
    mode: j.mode,
    verdict: j.verdict,
    a: mark(j.scenarios?.a),
    b: mark(j.scenarios?.b),
    c1: mark(c[0]),
    c2: mark(c[1]),
    c3: mark(c[2]),
    d: mark(j.scenarios?.d),
    e: mark(j.scenarios?.e),
    f: mark(j.scenarios?.f),
    g: mark(j.scenarios?.g),
    vIsRefErrors: j.vIsRefErrors,
    twitchObserved: j.twitchObserved,
    ytMutedSamples: j.scenarios?.a?.ytMutedSamples,
    twitchCommandsReceived: j.twitchCommandsReceived,
    updateStateMessages: j.updateStateMessages,
    centerClickSwitch: j.scenarios?.bPrime?.centerClickSwitch,
  };
});

console.log(
  [
    'label',
    'mode',
    'verdict',
    'a',
    'b',
    'c1',
    'c2',
    'c3',
    'd',
    'e',
    'f',
    'g',
    'vIsRef',
    'observed',
    'ytMuted',
  ].join('\t'),
);
for (const r of rows) {
  console.log(
    [
      r.label,
      r.mode,
      r.verdict,
      r.a,
      r.b,
      r.c1,
      r.c2,
      r.c3,
      r.d,
      r.e,
      r.f,
      r.g,
      r.vIsRefErrors,
      r.twitchObserved,
      r.ytMutedSamples,
    ].join('\t'),
  );
  if (r.centerClickSwitch) {
    console.log('  centerClickSwitch', JSON.stringify(r.centerClickSwitch));
  }
  console.log(
    '  cmds',
    JSON.stringify(r.twitchCommandsReceived),
    'updates',
    r.updateStateMessages,
  );
}

process.exit(rows[0]?.verdict === 'PASS' ? 0 : 1);
