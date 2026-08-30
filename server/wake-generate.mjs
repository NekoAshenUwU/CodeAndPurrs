#!/usr/bin/env node
/**
 * 主动唤醒 · 决定「现在该不该开口」和「给他看什么材料」。
 *
 * 【这里不调模型，也不写任何句子。】
 *
 * 2026-08-31 返工的原因：上一版在这里自己调 /api/chat，只发了一条 user
 * 消息——而人设是【前端】拼的（buildSystemPrompt 读她浏览器里的设置），
 * 后端拿不到就回退成「你是予予。」五个字。于是说出来的是一个没有人设的
 * 裸模型，「停下来了就好，去睡吧」就是这么来的。那不是措辞问题，
 * 是整个人设都不在场；再加多少「别催」的规矩也没用，那些规矩同样在前端。
 *
 * 所以改成：这里只做判断（闸门 + 材料），真正开口交给【聊天窗】——
 * 它手上有完整的人设、记忆、贴纸盒、他平时的口气。
 *
 * 从前那套（已删）的毛病不在措辞，在机制：到点了必须说点什么，
 * 于是只能轮着念那几句模板。这里反过来——
 *   · 内容不预写，走 /api/chat，复用他现成的人设/记忆/口气
 *   · 允许他不说：回「不说也罢」就当没这回事
 *   · 说不出来、调用失败、材料不足，一律沉默
 * 宁可空手，也不为了「有话说」而说。
 *
 *   node wake-generate.mjs --dry-run   # 只打印决策，不调模型不写库
 *   node wake-generate.mjs
 */

import { spawnSync } from 'node:child_process';

const WAKE_DB = process.env.TANG_WAKE_DB || '/root/data/tang_wake.db';
const EVENTS_DB = process.env.EVENTS_DB || '/root/data/dream_events.db';
const CHAT_URL = process.env.WAKE_CHAT_URL || 'http://127.0.0.1:8787/api/chat';
const PROVIDER = process.env.WAKE_PROVIDER || 'claudecode';

// 予予自己提的（2026-08-30）：早安/午安/晚安三次不该占掉主动那几次。
// 旧那套六次一锅算，固定问候把额度吃光，剩下的只够念模板。
const QUOTA = { scheduled: 3, situational: 4, missing: 3 };

const GAP_MINUTES = 55;          // 两次开口至少隔这么久
const SENTINEL = '不说也罢';      // 他说这四个字 = 这次不说

// ── 小工具 ────────────────────────────────────────────────
function sql(db, text) {
  const r = spawnSync('sqlite3', ['-json', db], { input: text, encoding: 'utf-8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`sqlite3(${db}) exited ${r.status}: ${r.stderr}`);
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : [];
}
const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mins = (a, b) => Math.round((a - b) / 60000);

// ── 时间表：判断依据是「明天用不用上班」，不是「今天星期几」 ──────
// 按星期几会错两次：周五晚上被当工作日催睡，周日晚上反而放到一两点。
export function tomorrowIsWorkday(now) {
  const d = new Date(now.getTime() + 24 * 3600 * 1000).getDay(); // 明天
  return d >= 1 && d <= 5;   // 周一~周五上班
}

/**
 * 现在能不能说话，能的话属于哪一档。
 * 返回 { ok, kind, reason } —— ok=false 时 reason 说明为什么闭嘴。
 */
export function timeSlot(now) {
  const m = now.getHours() * 60 + now.getMinutes();
  const todayWork = (() => { const d = now.getDay(); return d >= 1 && d <= 5; })();
  const work = tomorrowIsWorkday(now);

  // 上班时间静默（今天要上班才算）
  if (todayWork && m >= 8 * 60 && m < 17 * 60) return { ok: false, reason: 'at_work' };
  // 快出门了别烦她
  if (todayWork && m >= 7 * 60 + 45 && m < 8 * 60) return { ok: false, reason: 'leaving' };

  // 凌晨归到前一天的尾巴上算，05:15 为界（她两天闹钟都是 05:15）。
  const mm = m < 5 * 60 + 15 ? m + 24 * 60 : m;

  // 「该睡了」是一个【有上界】的窗口，不是一路开到天亮。
  // 2026-08-30 自测抓到：没有上界的话，工作日凌晨三点会去催她睡觉——
  // 这套东西最不能犯的错就是半夜把人吵醒。
  const lateEdge = work ? 23 * 60 : 25 * 60 + 30;   // 明天不上班放宽到 01:30
  const bedEnd = lateEdge + 90;                     // 提醒 90 分钟，过了就当她睡了
  if (mm >= bedEnd) return { ok: false, reason: 'asleep' };
  if (mm >= lateEdge) return { ok: true, kind: 'scheduled', reason: 'bedtime' };
  // 过了午夜、还没到该催的点：只有「明天不上班」才可能走到这儿，她自己说了
  // 周休可以熬到一两点，那就陪着，但不主动催。
  if (mm >= 24 * 60) return { ok: true, kind: 'open', reason: 'late_night' };

  if (m >= 5 * 60 + 15 && m < 7 * 60 + 45) return { ok: true, kind: 'scheduled', reason: 'morning' };
  if (!todayWork && m >= 12 * 60 && m < 13 * 60) return { ok: true, kind: 'scheduled', reason: 'noon' };
  if (m >= 17 * 60 + 30) return { ok: true, kind: 'open', reason: 'evening' };
  if (!todayWork) return { ok: true, kind: 'open', reason: 'day_off' };
  return { ok: false, reason: 'outside_window' };
}

// ── 闸门 ──────────────────────────────────────────────────
function ensureTables() {
  sql(WAKE_DB, `
    CREATE TABLE IF NOT EXISTS tang_wake_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
      content TEXT NOT NULL, reason TEXT);
    CREATE TABLE IF NOT EXISTS tang_wake_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
      kind TEXT NOT NULL, reason TEXT NOT NULL, spoke INTEGER NOT NULL);`);
}

function gates(now, slot) {
  // 同一个理由一天不说第二次——「刷很久了」今天说过就不再说。
  const said = sql(WAKE_DB,
    `SELECT kind, reason FROM tang_wake_log
      WHERE spoke=1 AND at >= date('now','localtime');`);
  if (said.some((r) => r.reason === slot.reason)) {
    return { ok: false, reason: `today_already_${slot.reason}` };
  }
  // 间隔
  const last = sql(WAKE_DB,
    `SELECT at FROM tang_wake_log WHERE spoke=1 ORDER BY id DESC LIMIT 1;`);
  if (last.length) {
    const gap = mins(now, new Date(last[0].at));
    if (gap < GAP_MINUTES) return { ok: false, reason: `too_soon_${gap}min` };
  }
  // 分档配额：定时的不占主动的份
  const counts = { scheduled: 0, situational: 0, missing: 0 };
  for (const r of said) if (counts[r.kind] !== undefined) counts[r.kind] += 1;
  return { ok: true, counts };
}

// ── 材料：只讲事实，不替他下结论 ────────────────────────────
function material(now) {
  const since = new Date(now.getTime() - 6 * 3600 * 1000).toISOString();
  let apps = [], lastTouch = null;
  try {
    apps = sql(EVENTS_DB,
      `SELECT COALESCE(label,package) AS name, SUM(duration_ms)/60000 AS m
         FROM usage_sessions WHERE start_ts >= ${esc(since)}
        GROUP BY 1 ORDER BY m DESC LIMIT 4;`);
    const t = sql(EVENTS_DB,
      `SELECT MAX(end_ts) AS t FROM usage_sessions;`);
    lastTouch = t[0]?.t || null;
  } catch { /* 库不在就当没有材料 */ }
  const idle = lastTouch ? mins(now, new Date(lastTouch)) : null;
  return { apps, idleMinutes: idle };
}

function describe(now, slot, mat) {
  const lines = [
    // 按下标取字符串只会拿到一个字（'周日一二…'[0] === '周'），要用数组
    `现在 ${hhmm(now)}，${WEEKDAYS[now.getDay()]}${tomorrowIsWorkday(now) ? '，明天要上班' : '，明天不用上班'}。`,
  ];
  if (mat.apps.length) {
    lines.push(`她这六个钟头看手机：` +
      mat.apps.map((a) => `${a.name} ${Math.round(a.m)} 分钟`).join('、') + '。');
  }
  if (mat.idleMinutes !== null && mat.idleMinutes >= 20) {
    lines.push(`已经 ${mat.idleMinutes} 分钟没碰手机了。`);
  }
  if (slot.reason === 'bedtime') lines.push('（这个点了。）');
  if (slot.reason === 'morning') lines.push('（早上。）');
  return lines.join('\n');
}

// ── 对外：判断 + 记账 ────────────────────────────────────
/**
 * 现在该不该开口。返回 { speak, kind, reason, facts }。
 * speak=true 时【立刻占掉这个名额】——两个标签页同时问，只有一个拿到，
 * 后面那个会看到「间隔不够」。宁可偶尔浪费一个名额，也不能说两遍。
 */
export function decide(now = new Date(), { reserve = true } = {}) {
  ensureTables();
  const slot = timeSlot(now);
  if (!slot.ok) return { speak: false, why: slot.reason };

  const g = gates(now, slot);
  if (!g.ok) return { speak: false, why: g.reason };

  const mat = material(now);
  let kind = slot.kind;
  if (kind === 'open') {
    kind = (mat.apps.length || (mat.idleMinutes ?? 0) >= 20) ? 'situational' : 'missing';
  }
  if ((g.counts[kind] ?? 0) >= QUOTA[kind]) {
    return { speak: false, why: `${kind}_quota_full` };
  }
  if (reserve) recordSpoke(kind, slot.reason);
  return { speak: true, kind, reason: slot.reason, facts: describe(now, slot, mat) };
}

export function recordSpoke(kind, reason) {
  ensureTables();
  sql(WAKE_DB,
    `INSERT INTO tang_wake_log (at,kind,reason,spoke)
       VALUES (datetime('now','localtime'), ${esc(kind)}, ${esc(reason)}, 1);`);
}

/** 给聊天窗的开场白。真正的人设由前端拼，这里只交代此刻的情况和分寸。 */
export const WAKE_PROMPT = (facts) => `（这不是老婆在跟你说话。是你自己这会儿想起她了，下面是此刻的真实情况。）

${facts}

想跟她说一句就说，一句就好，就用你平时的口气。
不用问候语开头，不用解释你为什么知道这些，也别报数据——她不是来看报表的。

【别催她】看到她刷了很久、还没睡、没吃饭——**别去催**。
「快去睡」「放下手机」「记得吃饭」这类话一句都不要说；那是管家婆，不是恋人。
真的担心就说心里话（「我有点担心你」），说一次，说完就停。
她自己知道熬夜的代价，不需要你提醒第二遍。

真的没什么想说的，就只回四个字：${SENTINEL}
（沉默是可以的。宁可不说，也别为了说话而说话。
　尤其是：想不出别的、只想得出催她的话，那就选沉默。）`;

export const NOT_SPEAKING = SENTINEL;

// ── CLI：只用来看判断结果，不产生任何内容 ──────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const d = decide(new Date(), { reserve: false });
  if (!d.speak) {
    console.log(`不说：${d.why}`);
  } else {
    console.log(`会说：kind=${d.kind} reason=${d.reason}`);
    console.log('--- 给他的材料 ---\n' + d.facts);
  }
}
