import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyException, mvpHasSameHostException } from './live-exceptions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewFallback = path.resolve(here, '../../../docs/plans/reviews/e2e-fix5-review-2/fallback.json');

test('rejects_non_null_error_with_fetchVideoData_in_stack', () => {
  const classified = classifyException({
    exception: { description: 'Error: unexpected non-null regression' },
    stackTrace: {
      callFrames: [{ functionName: 'fetchVideoData', url: 'https://holodex.net/assets/main.js' }],
    },
  });
  assert.equal(classified.allowId, null);
});

test('rejects_null_error_outside_fetchVideoData', () => {
  const classified = classifyException({
    exception: { description: "TypeError: Cannot read properties of null (reading 'length')" },
    stackTrace: {
      callFrames: [{ functionName: 'otherWork', url: 'https://holodex.net/assets/main.js' }],
    },
  });
  assert.equal(classified.allowId, null);
});

test('accepts_null_length_in_fetchVideoData', () => {
  const saved = JSON.parse(fs.readFileSync(reviewFallback, 'utf8'));
  const details = JSON.parse(saved.hostExceptions[0].raw);
  const classified = classifyException(details);
  assert.equal(classified.allowId, 'null-length-fetchVideoData');
  assert.equal(classified.kind, 'host');
  assert.match(classified.firstLine, /^TypeError: Cannot read properties of null \(reading 'length'\)$/);
});

test('accepts_getCurrentTime_from_host_assets', () => {
  const classified = classifyException({
    exception: { description: 'TypeError: this.player.getCurrentTime is not a function' },
    stackTrace: {
      callFrames: [
        { functionName: 'readTime', url: 'https://holodex.net/assets/TwitchPlayer.js' },
        { functionName: 'tick', url: 'https://holodex.net/assets/MultiView.js' },
      ],
    },
  });
  assert.equal(classified.allowId, 'getCurrentTime-not-function');
  assert.equal(classified.kind, 'host');
});

test('rejects_getCurrentTime_from_extension_frame', () => {
  const classified = classifyException({
    exception: { description: 'TypeError: this.player.getCurrentTime is not a function' },
    stackTrace: {
      callFrames: [
        { functionName: 'readTime', url: 'https://holodex.net/assets/TwitchPlayer.js' },
        { functionName: 'wrap', url: 'chrome-extension://abc/audio-lock.js' },
      ],
    },
  });
  assert.equal(classified.allowId, null);
  assert.equal(classified.kind, 'extension');
});

test('mvp_match_requires_same_allowId_and_firstLine', () => {
  const mvp = [
    { allowId: 'null-length-fetchVideoData', firstLine: "TypeError: Cannot read properties of null (reading 'length')" },
    { allowId: 'getCurrentTime-not-function', firstLine: 'TypeError: this.player.getCurrentTime is not a function' },
  ];
  assert.equal(mvpHasSameHostException(mvp[0], mvp), true);
  assert.equal(mvpHasSameHostException({
    allowId: 'null-length-fetchVideoData',
    firstLine: "TypeError: Cannot read properties of null (reading 'foo')",
  }, mvp), false);
  assert.equal(mvpHasSameHostException({
    allowId: 'getCurrentTime-not-function',
    firstLine: "TypeError: Cannot read properties of null (reading 'length')",
  }, mvp), false);
});
