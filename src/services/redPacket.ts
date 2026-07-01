// 甜甜口袋 —— 虚拟红包账本。棠棠和予予各有各的户口，互不混：
// 一笔红包记的是「谁发的」，收的人自然就是另一方，累积进收的人自己的口袋。
// 存这台设备的 localStorage（跟记忆罐头一个道理，够用不用后端）。

import { loadLocal, saveLocal } from './storage';

export type Sender = 'user' | 'ai';

export type RedPacket = {
  id: string;
  from: Sender;
  amount: number;
  note: string;
  createdAt: number;
};

const KEY = 'sweetie-pocket:packets';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const loadPackets = (): RedPacket[] => loadLocal<RedPacket[]>(KEY, []);

// 存一笔红包（谁发的 + 金额 + 留言），返回记好的那条
export function addPacket(from: Sender, amount: number, note: string): RedPacket {
  const list = loadPackets();
  const p: RedPacket = { id: uid(), from, amount, note: note.trim(), createdAt: Date.now() };
  saveLocal(KEY, [p, ...list]);
  return p;
}

// 某一方口袋里累积了多少：对方发的红包金额总和
export function balanceOf(who: Sender, list: RedPacket[] = loadPackets()): number {
  const senderOfOther: Sender = who === 'user' ? 'ai' : 'user';
  return list.filter((p) => p.from === senderOfOther).reduce((sum, p) => sum + p.amount, 0);
}

// 开局给两边口袋各塞 500，只在这台设备第一次打开时补一次(账本已经有记录/已经塞过就不再塞)
const SEEDED_KEY = 'sweetie-pocket:seeded-starter';
export function ensureStarterPackets(): void {
  if (loadLocal<boolean>(SEEDED_KEY, false)) return;
  if (loadPackets().length === 0) {
    const now = Date.now();
    saveLocal(KEY, [
      { id: uid(), from: 'user' as Sender, amount: 500, note: '开局塞给你的', createdAt: now },
      { id: uid(), from: 'ai' as Sender, amount: 500, note: '开局塞给你的', createdAt: now + 1 },
    ]);
  }
  saveLocal(SEEDED_KEY, true);
}
