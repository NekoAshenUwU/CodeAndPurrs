// 临时调试悬浮框——右下角半透明黑框,订阅 debugLog 的日志实时显示,方便老婆截图。
// 一键移除:回 SweetiePocketPage.tsx 把 <DebugOverlay /> 那行删掉/注释掉就行,
// 这个文件留着不影响任何东西。
import { useEffect, useState } from 'react';
import { subscribeDebugLog, type DebugLine } from '../services/debugLog';

export function DebugOverlay() {
  const [lines, setLines] = useState<DebugLine[]>([]);
  const [hidden, setHidden] = useState(false);

  useEffect(() => subscribeDebugLog(setLines), []);

  if (hidden) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 999999,
        width: 'min(92vw, 420px)',
        maxHeight: '42vh',
        overflowY: 'auto',
        background: 'rgba(10, 10, 15, 0.85)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 12,
        padding: '8px 10px',
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.45,
        WebkitBackdropFilter: 'blur(6px)',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: '#fff', fontWeight: 700 }}>调试日志(临时)</span>
        <button
          type="button"
          onClick={() => setHidden(true)}
          style={{
            background: 'rgba(255,255,255,0.16)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '3px 9px',
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          ✕ 移除
        </button>
      </div>
      {lines.length === 0 ? <div style={{ color: '#8a8a8a' }}>(还没有日志)</div> : null}
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            color: l.level === 'error' ? '#ff8f8f' : '#7CFC9A',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 2,
          }}
        >
          {l.text}
        </div>
      ))}
    </div>
  );
}
