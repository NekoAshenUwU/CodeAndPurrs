import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearAll,
  loadCurrentModel,
  loadSessions,
  saveCurrentModel,
  saveSessions,
  validateBackup,
  type ChatBackup,
  type ChatSession,
} from '../lib/chatStorage';
import {
  downloadBlob,
  makeBackup,
  sessionToMarkdown,
  sessionToText,
  slugify,
  timestampSlug,
} from '../lib/exporters';

type ImportMode = 'replace' | 'merge';
type StatusTone = 'ok' | 'error' | 'info';

type ExportPodProps = {
  onClose: () => void;
};

export function ExportPod({ onClose }: ExportPodProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentModel, setCurrentModel] = useState<string>('deepseek-v4');
  const [selectedId, setSelectedId] = useState<string>('');
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [status, setStatus] = useState<string>('');
  const [statusTone, setStatusTone] = useState<StatusTone>('info');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const list = loadSessions();
    setSessions(list);
    setCurrentModel(loadCurrentModel());
    if (list.length > 0) {
      setSelectedId(list[0].id);
    }
  }, []);

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  const messageCount = useMemo(
    () => sessions.reduce((acc, s) => acc + s.messages.length, 0),
    [sessions],
  );

  const flash = useCallback((text: string, tone: StatusTone = 'info') => {
    setStatus(text);
    setStatusTone(tone);
  }, []);

  const handleExportAll = useCallback(() => {
    if (sessions.length === 0) {
      flash('小暗格是空的，先去呼噜频道聊两句再回来。', 'info');
      return;
    }
    const backup = makeBackup(sessions, currentModel);
    const name = `codeandpurrs-${timestampSlug()}.json`;
    downloadBlob(name, 'application/json', JSON.stringify(backup, null, 2));
    flash(`已导出 ${name}。`, 'ok');
  }, [sessions, currentModel, flash]);

  const handleExportMarkdown = useCallback(() => {
    if (!selectedSession) {
      flash('先选一个会话。', 'info');
      return;
    }
    const name = `${slugify(selectedSession.title, selectedSession.id)}.md`;
    downloadBlob(name, 'text/markdown', sessionToMarkdown(selectedSession));
    flash(`已导出 ${name}。`, 'ok');
  }, [selectedSession, flash]);

  const handleExportTxt = useCallback(() => {
    if (!selectedSession) {
      flash('先选一个会话。', 'info');
      return;
    }
    const name = `${slugify(selectedSession.title, selectedSession.id)}.txt`;
    downloadBlob(name, 'text/plain', sessionToText(selectedSession));
    flash(`已导出 ${name}。`, 'ok');
  }, [selectedSession, flash]);

  const applyBackup = useCallback(
    (backup: ChatBackup) => {
      setSessions((prev) => {
        const next =
          importMode === 'replace'
            ? backup.sessions.slice()
            : mergeSessions(prev, backup.sessions);
        saveSessions(next);
        if (next.length > 0) {
          setSelectedId((current) =>
            next.some((s) => s.id === current) ? current : next[0].id,
          );
        } else {
          setSelectedId('');
        }
        return next;
      });
      saveCurrentModel(backup.currentModel);
      setCurrentModel(backup.currentModel);
      const verb = importMode === 'replace' ? '替换成' : '合并入';
      flash(`已${verb} ${backup.sessions.length} 个会话。`, 'ok');
    },
    [importMode, flash],
  );

  const handleImportFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!validateBackup(parsed)) {
          flash('这个文件不像是 CodeAndPurrs 的备份，检查一下再试。', 'error');
          return;
        }
        applyBackup(parsed);
      } catch {
        flash('读文件失败，可能不是有效 JSON。', 'error');
      }
    },
    [applyBackup, flash],
  );

  const handleImportPick = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const handleClearAll = useCallback(() => {
    const ok = window.confirm(
      '会清空这台设备上所有 CodeAndPurrs 聊天记录，无法恢复。要继续吗？',
    );
    if (!ok) return;
    clearAll();
    setSessions([]);
    setSelectedId('');
    setCurrentModel(loadCurrentModel());
    flash('已清空这台设备的聊天记录。', 'ok');
  }, [flash]);

  return (
    <section className="export-pod" aria-labelledby="export-pod-title">
      <button
        type="button"
        className="export-pod__close"
        onClick={onClose}
        aria-label="关闭导出舱"
      >
        ×
      </button>
      <div className="export-pod__icon" aria-hidden="true">
        🚀
      </div>
      <p className="export-pod__eyebrow">Export Pod</p>
      <h3 id="export-pod-title">导出舱</h3>
      <p className="export-pod__lead">
        把小暗格里的聊天记录打包成文件，换手机时带去下一台设备。
      </p>

      <ul className="export-pod__stats" aria-live="polite">
        <li>
          <strong>{sessions.length}</strong>
          <span>会话</span>
        </li>
        <li>
          <strong>{messageCount}</strong>
          <span>消息</span>
        </li>
        <li>
          <strong>{currentModel}</strong>
          <span>当前模型</span>
        </li>
      </ul>

      <div className="export-pod__block">
        <h4>备份全部 · JSON</h4>
        <p>包含所有会话、消息和当前选择的模型，用来搬家或做定期备份。</p>
        <button
          type="button"
          className="export-pod__primary"
          onClick={handleExportAll}
          disabled={sessions.length === 0}
        >
          导出全部 JSON
        </button>
      </div>

      <div className="export-pod__block">
        <h4>单个会话 · Markdown / TXT</h4>
        <p>只带走一段对话，方便贴到日记、笔记或分享出去。</p>
        {sessions.length === 0 ? (
          <p className="export-pod__hint">还没有会话，先去呼噜频道聊两句。</p>
        ) : (
          <>
            <label className="export-pod__field">
              <span>选择会话</span>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || '未命名会话'} · {s.messages.length} 条
                  </option>
                ))}
              </select>
            </label>
            <div className="export-pod__row">
              <button type="button" onClick={handleExportMarkdown}>
                导出 Markdown
              </button>
              <button type="button" onClick={handleExportTxt}>
                导出 TXT
              </button>
            </div>
          </>
        )}
      </div>

      <div className="export-pod__block">
        <h4>从备份文件恢复</h4>
        <p>选一份之前导出的 JSON 备份，把聊天记录装回小暗格。</p>
        <fieldset className="export-pod__modes">
          <legend>装回方式</legend>
          <label>
            <input
              type="radio"
              name="import-mode"
              value="merge"
              checked={importMode === 'merge'}
              onChange={() => setImportMode('merge')}
            />
            合并（保留旧会话，追加没见过的）
          </label>
          <label>
            <input
              type="radio"
              name="import-mode"
              value="replace"
              checked={importMode === 'replace'}
              onChange={() => setImportMode('replace')}
            />
            替换（用备份完全覆盖当前）
          </label>
        </fieldset>
        <input
          type="file"
          accept="application/json,.json"
          ref={fileRef}
          className="export-pod__file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void handleImportFile(file);
              e.target.value = '';
            }
          }}
        />
        <button type="button" className="export-pod__primary" onClick={handleImportPick}>
          选择备份文件
        </button>
      </div>

      <div className="export-pod__block export-pod__block--danger">
        <h4>清空这台设备</h4>
        <p>只清这台设备上的聊天记录，云端和别的设备上的备份不动。</p>
        <button
          type="button"
          className="export-pod__danger"
          onClick={handleClearAll}
          disabled={sessions.length === 0}
        >
          清空本地聊天
        </button>
      </div>

      {status ? (
        <div
          className={`export-pod__status export-pod__status--${statusTone}`}
          role="status"
        >
          {status}
        </div>
      ) : null}
    </section>
  );
}

function mergeSessions(existing: ChatSession[], incoming: ChatSession[]): ChatSession[] {
  const seen = new Set(existing.map((s) => s.id));
  const merged = existing.slice();
  for (const s of incoming) {
    if (!seen.has(s.id)) {
      merged.push(s);
      seen.add(s.id);
    }
  }
  return merged;
}
