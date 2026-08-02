import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExportPod, type PodTheme } from '../components/ExportPod';

export function ExportPodPage() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<PodTheme>('auto');

  return (
    <main className="export-pod-page" data-theme={theme}>
      <div className="export-pod-page__scene" aria-hidden="true" />
      <header className="export-pod-page__topbar">
        <button
          type="button"
          className="export-pod-page__back"
          onClick={() => navigate('/')}
          aria-label="回首页"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path
              d="M11.5 3.5L5.5 9l6 5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="export-pod-page__title">
          <h1 className="export-pod-page__title-zh">导出舱</h1>
          <p className="export-pod-page__title-en">Export Pod</p>
        </div>
        <span className="export-pod-page__spacer" aria-hidden="true" />
      </header>
      <ExportPod onClose={() => navigate('/')} onThemeChange={setTheme} />
    </main>
  );
}
