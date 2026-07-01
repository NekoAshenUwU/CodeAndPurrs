// 滚动摘要 —— 对话超过 HISTORY_MAX 硬截断窗口之外的老消息，不再直接丢弃。
// 每个聊天窗口异步用便宜模型(DeepSeek)把老消息压成一小段摘要存起来，
// 聊天时塞进 system prompt 兜底，比全指望日记/记忆罐头手动兜底更彻底。

import { loadLocal, saveLocal } from './storage';

export type RollingSummary = {
  summary: string; // 已经压缩好的摘要文本，按批次追加
  summarizedCount: number; // 从头数，已经被折进 summary 的消息条数
};

const EMPTY: RollingSummary = { summary: '', summarizedCount: 0 };
const key = (windowId: string) => `purr-channel:rolling-summary:${windowId}`;

export function loadRollingSummary(windowId: string): RollingSummary {
  return loadLocal<RollingSummary>(key(windowId), EMPTY);
}

export function saveRollingSummary(windowId: string, data: RollingSummary): void {
  saveLocal(key(windowId), data);
}
