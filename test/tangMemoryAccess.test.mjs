import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const proxy = readFileSync(new URL('../server/proxy.mjs', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/pages/PurrChannelPage.tsx', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../src/services/chat.ts', import.meta.url), 'utf8');

test('Claude and Claude Code receive Tangyuniang MCP on every turn', () => {
  const alwaysOnBindings = proxy.match(/const mem = memoryMcpConfig\(\);/g) || [];
  assert.equal(alwaysOnBindings.length, 2);
  assert.doesNotMatch(proxy, /initializeMemory|memory_initialized|MEMORY_MCP_INIT_RULE/);
});

test('memory policy permits real reads and writes without pretending text tags are writes', () => {
  assert.match(proxy, /长期记忆读写工具/);
  assert.match(proxy, /读取\/搜索工具/);
  assert.match(proxy, /写入\/更新工具/);
  assert.match(proxy, /不要用文字控制标记冒充已经写入/);
});

test('frontend no longer persists a one-time memory gate', () => {
  assert.doesNotMatch(page, /tang-memory-initialized|tangMemoryInitialized|initializeMemory/);
  assert.doesNotMatch(chat, /initializeMemory|memory_initialized|onMemoryInitialized/);
  assert.match(page, /每一轮都可以按需调用棠予酿读写工具/);
});
