import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error('usage: node compare.mjs <candidate.json> <baseline.json> [<more.json>...]');
  process.exit(2);
}

const results = files.map((f) => {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { file: f, data };
});

function audioLockWarnings(result) {
  return (result.console || []).filter(
    ([, type, text]) => type === 'warning' && String(text).includes('[Holodex+ AudioLock]')
  ).length;
}

function passCandidate(result) {
  const c = result.checks || {};
  const reasons = [];
  if (!(c.flags?.v3 === true && c.flags?.newHandle === true)) {
    reasons.push('flags.v3/newHandle');
  }
  if (c.afterBothPlay?.audible !== 'YT') reasons.push('afterBothPlay');
  if (c.afterSelfUnmute1?.audible !== 'YT') reasons.push('afterSelfUnmute1');
  if (c.afterLaggedRepeats?.audible !== 'YT') reasons.push('afterLaggedRepeats');
  if (c.everStolenDuringLag !== 0) reasons.push('everStolenDuringLag');
  if (!(c.ytMutedSamples === 0 && c.samples >= 150)) reasons.push('ytMutedSamples/samples');
  if (c.afterUserUnmuteTwitch?.audible !== 'TW') reasons.push('afterUserUnmuteTwitch');
  if ((result.errors || []).length !== 0) reasons.push('errors');
  if ((result.console || []).some(([, , text]) => /SyntaxError|Cannot use import statement/.test(String(text)))) {
    reasons.push('SyntaxError');
  }
  if ((result.console || []).some(([, type, text]) => type === 'warning' && String(text).includes('[Holodex+ AudioLock]'))) {
    reasons.push('AudioLock warning');
  }
  return { ok: reasons.length === 0, reasons };
}

function cell(result, key) {
  const c = result.checks || {};
  switch (key) {
    case '頁面腳本有跑':
      return c.flags?.v3 === true ? 'yes' : 'no';
    case 'Twitch 晚播後':
      return c.afterBothPlay?.audible ?? '—';
    case '自己取消靜音後':
      return c.afterSelfUnmute1?.audible ?? '—';
    case '延遲＋重複 6 次後':
      return c.afterLaggedRepeats?.audible ?? '—';
    case '延遲期間被搶次數':
      return c.everStolenDuringLag ?? '—';
    case 'YouTube 被靜音取樣／總取樣':
      return `${c.ytMutedSamples ?? '—'}/${c.samples ?? '—'}`;
    case '使用者點 Twitch 後':
      return c.afterUserUnmuteTwitch?.audible ?? '—';
    case 'AudioLock 警告數':
      return audioLockWarnings(result);
    case '判定': {
      const p = passCandidate(result);
      return p.ok ? 'PASS' : `FAIL (${p.reasons.join(', ')})`;
    }
    default:
      return '—';
  }
}

const rows = [
  '頁面腳本有跑',
  'Twitch 晚播後',
  '自己取消靜音後',
  '延遲＋重複 6 次後',
  '延遲期間被搶次數',
  'YouTube 被靜音取樣／總取樣',
  '使用者點 Twitch 後',
  'AudioLock 警告數',
  '判定',
];

const labels = results.map((r) => r.data.label || r.file);
let md = '| 檢查 | ' + labels.join(' | ') + ' |\n';
md += '| --- | ' + labels.map(() => '---').join(' | ') + ' |\n';
for (const row of rows) {
  md += '| ' + row + ' | ' + results.map((r) => cell(r.data, row)).join(' | ') + ' |\n';
}
process.stdout.write(md);

const candidate = passCandidate(results[0].data);
process.exit(candidate.ok ? 0 : 1);
