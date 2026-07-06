// 临时调试工具:把关键日志同步推给页面上的悬浮调试框(见 components/DebugOverlay.tsx),
// 方便老婆截图发我,不用连电脑开 devtools。debugInfo/debugError 照常打 console,
// 只是多推一份到订阅者(悬浮框)手里。
//
// 排查完 bug 之后想收掉:
//   - 最快: 在 SweetiePocketPage.tsx 里把 <DebugOverlay /> 那一行删掉(或注释掉)就行,
//     这个文件和 debugInfo/debugError 调用点留着完全无害(就是普通 console 输出)。
//   - 彻底清: 顺手把这个文件、components/DebugOverlay.tsx、以及调用点里的
//     debugInfo/debugError 改回 console.info/console.error 就行。

export type DebugLine = { level: 'info' | 'error'; text: string; at: number };
type Listener = (lines: DebugLine[]) => void;

const listeners = new Set<Listener>();
const buffer: DebugLine[] = [];

function push(level: DebugLine['level'], text: string) {
  buffer.push({ level, text, at: Date.now() });
  if (buffer.length > 60) buffer.shift();
  const snapshot = [...buffer];
  listeners.forEach((l) => l(snapshot));
}

export function debugInfo(text: string): void {
  console.info(text);
  push('info', text);
}

export function debugError(text: string): void {
  console.error(text);
  push('error', text);
}

// 订阅时立即推一次现有 buffer——组件挂载可能晚于日志产生(比如日志在
// useEffect 里比 DebugOverlay 先跑),不然悬浮框会漏看最早那几条。
export function subscribeDebugLog(listener: Listener): () => void {
  listeners.add(listener);
  listener([...buffer]);
  return () => listeners.delete(listener);
}
