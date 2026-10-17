// Page exception classification shared by live.mjs and live-compare.mjs.

export const HOST_EXCEPTION_ALLOWLIST = [
  {
    id: 'null-length-fetchVideoData',
    firstLine: /^TypeError: Cannot read properties of null \(reading '[^']+'\)$/,
    frame: (frames) => frames.some((f) => String(f.functionName || '').endsWith('fetchVideoData') && String(f.url || '').startsWith('https://holodex.net/assets/')),
  },
  {
    id: 'getCurrentTime-not-function',
    firstLine: /^TypeError: this\.player\.getCurrentTime is not a function$/,
    frame: (frames) => frames.length > 0 && frames.every((f) => String(f.url || '').startsWith('https://holodex.net/assets/')),
  },
];

const lineMatches = (rule, firstLine) => (
  rule.firstLine instanceof RegExp ? rule.firstLine.test(firstLine) : rule.firstLine === firstLine
);

export function classifyException(exceptionDetails) {
  const details = exceptionDetails || {};
  const description = details.exception?.description || details.text || '';
  const firstLine = String(description).split('\n')[0];
  const frames = (details.stackTrace?.callFrames || []).map((frame) => ({
    functionName: frame.functionName || '',
    url: frame.url || '',
  }));
  const urls = frames.map((frame) => frame.url).join('\n');
  const messageBlob = `${details.text || ''}\n${description}`;
  let kind = 'unclassified';
  if (/chrome-extension:\/\//.test(`${urls}\n${details.url || ''}\n${messageBlob}`) || /AudioLock|Holodex\+/.test(messageBlob)) {
    kind = 'extension';
  } else if (frames.length > 0 && frames.every((frame) => frame.url.startsWith('https://holodex.net/assets/'))) {
    kind = 'host';
  }
  const allow = HOST_EXCEPTION_ALLOWLIST.find((rule) => lineMatches(rule, firstLine) && rule.frame(frames));
  return {
    kind,
    firstLine,
    frames,
    allowId: allow && kind === 'host' ? allow.id : null,
  };
}

export function mvpHasSameHostException(entry, mvpHostExceptions) {
  return (mvpHostExceptions || []).some((row) => row.allowId === entry.allowId && row.firstLine === entry.firstLine);
}
