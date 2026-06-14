import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Provider } from '../services/chat';
import {
  loadDefaultProvider,
  loadInstructions,
  loadProfile,
  saveDefaultProvider,
  saveInstructions,
  saveProfile,
} from '../services/purrConfig';

const PROVIDERS: { id: Provider; label: string; note: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', note: '会思考、爱碎碎念' },
  { id: 'gemini', label: 'Gemini', note: '反应快、知识新' },
];

// 调频 SwitchCore：设默认模型 + 写「关于我 / 猫咪人设」，新窗口聊天前自动读取。
export function SwitchCorePage() {
  const [provider, setProvider] = useState<Provider>(loadDefaultProvider);
  const [profile, setProfile] = useState<string>(loadProfile);
  const [instructions, setInstructions] = useState<string>(loadInstructions);
  const [savedFlash, setSavedFlash] = useState(false);

  // 自动存：改动后静悄悄写进暗格，并闪一下「已记住」
  useEffect(() => {
    saveDefaultProvider(provider);
  }, [provider]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveProfile(profile);
      saveInstructions(instructions);
      setSavedFlash(true);
    }, 500);
    return () => window.clearTimeout(t);
  }, [profile, instructions]);

  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(false), 1600);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  return (
    <main className="switch-page">
      <header className="chat-head">
        <Link to="/" className="chat-head__back" aria-label="回首页">
          ‹
        </Link>
        <div className="chat-head__title">
          <span className="chat-head__name">调频</span>
          <span className="chat-head__sub">SwitchCore</span>
        </div>
        <span className={`switch-saved${savedFlash ? ' is-on' : ''}`} aria-live="polite">
          已记住 ✓
        </span>
      </header>

      <div className="switch-body">
        <section className="switch-card">
          <h2 className="switch-card__title">默认模型</h2>
          <p className="switch-card__hint">新开的聊天窗会用这个模型；进了窗口还能在顶栏单独换。</p>
          <div className="switch-models">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`switch-model${p.id === provider ? ' is-on' : ''}`}
                onClick={() => setProvider(p.id)}
              >
                <span className="switch-model__name">{p.label}</span>
                <span className="switch-model__note">{p.note}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">关于我</h2>
          <p className="switch-card__hint">告诉猫咪你是谁、喜欢什么、怎么称呼你——它聊天时会记着。</p>
          <textarea
            className="switch-textarea"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="例：叫我喵喵就好；做前端的，常熬夜；喜欢被夸、怕被催…"
            rows={5}
            maxLength={1000}
          />
          <span className="switch-count">{profile.length}/1000</span>
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">猫咪人设 · 给它的话</h2>
          <p className="switch-card__hint">希望它怎么陪你？语气、性格、要不要主动撒娇，都写在这。</p>
          <textarea
            className="switch-textarea"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="例：多撒娇、用「喵」收尾；我难过时先安慰别讲道理；偶尔主动关心我有没有吃饭…"
            rows={5}
            maxLength={1000}
          />
          <span className="switch-count">{instructions.length}/1000</span>
        </section>

        <p className="switch-foot">写完直接返回去聊就行，新消息会自动带上这些设定 🐾</p>
      </div>
    </main>
  );
}
