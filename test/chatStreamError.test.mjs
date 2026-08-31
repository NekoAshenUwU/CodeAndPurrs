import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../src/services/chat.ts', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/pages/PurrChannelPage.tsx', import.meta.url), 'utf8');

test('an SSE error is terminal and cannot be overwritten by a later done event', () => {
  assert.match(chat, /let settled = false/);
  assert.match(chat, /if \(settled\) continue/);
  assert.match(chat, /case 'error':\s*fail\(/);
  assert.match(chat, /case 'done':\s*finish\(\)/);
  assert.match(page, /onDone: \(\) => \{\s*\/\/[\s\S]*?if \(streamFailed\) return/);
});

test('a successful SSE stream without content becomes an explicit error', () => {
  assert.match(chat, /if \(!receivedContent\) \{\s*fail\('模型没有返回正文/);
});
