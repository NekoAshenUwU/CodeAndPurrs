import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getModel, MODEL_GROUPS, MODELS } from '../data/models';
import {
  loadDefaultModel,
  loadInstructions,
  loadPersonas,
  loadProfile,
  saveDefaultModel,
  saveInstructions,
  savePersonas,
  saveProfile,
  type Persona,
} from '../services/purrConfig';

// 调频 SwitchCore：设默认模型 + 关于我 + 默认人设 + 每个模型各自的名字/人设。
export function SwitchCorePage() {
  const [provider, setProvider] = useState<string>(loadDefaultModel);
  const [profile, setProfile] = useState<string>(loadProfile);
  const [instructions, setInstructions] = useState<string>(loadInstructions);
  const [personas, setPersonas] = useState<Record<string, Persona>>(loadPersonas);
  const [editId, setEditId] = useState<string>(() => loadDefaultModel() || MODELS[0].id);
  const [savedFlash, setSavedFlash] = useState(false);

  // 自动存：改动后静悄悄写进暗格，并闪一下「已记住」
  useEffect(() => {
    saveDefaultModel(provider);
  }, [provider]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveProfile(profile);
      saveInstructions(instructions);
      savePersonas(personas);
      setSavedFlash(true);
    }, 500);
    return () => window.clearTimeout(t);
  }, [profile, instructions, personas]);

  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(false), 1600);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  const editPersona: Persona = personas[editId] ?? { name: '', persona: '' };
  const patchPersona = (patch: Partial<Persona>) =>
    setPersonas((prev) => ({ ...prev, [editId]: { ...{ name: '', persona: '' }, ...prev[editId], ...patch } }));

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
          {MODEL_GROUPS.map((g) => (
            <div key={g.brand} className="switch-brand">
              <span className="switch-brand__name">{g.brand}</span>
              <div className="switch-models">
                {g.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`model-pill switch-model-pill${m.id === provider ? ' is-on' : ''}`}
                    onClick={() => setProvider(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">关于我</h2>
          <p className="switch-card__hint">告诉猫咪你是谁、喜欢什么、怎么称呼你——所有模型聊天时都记着。</p>
          <textarea
            className="switch-textarea"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            placeholder="例：叫我喵喵就好；做前端的，常熬夜；喜欢被夸、怕被催…"
            rows={5}
            maxLength={6000}
          />
          <span className="switch-count">{profile.length}/6000</span>
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">每个模型的人设</h2>
          <p className="switch-card__hint">
            给每个模型起名字、定性格——切到哪个模型，猫咪就用哪份人设。没单独设的，用下面的「默认人设」。
          </p>
          <div className="switch-models switch-models--edit">
            {MODELS.map((m) => {
              const has = !!(personas[m.id]?.name?.trim() || personas[m.id]?.persona?.trim());
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`model-pill switch-edit-pill${m.id === editId ? ' is-on' : ''}`}
                  onClick={() => setEditId(m.id)}
                >
                  {m.label}
                  {has ? <span className="switch-edit-pill__dot" aria-label="已设人设" /> : null}
                </button>
              );
            })}
          </div>

          <label className="switch-field">
            <span className="switch-field__label">「{getModel(editId).label}」的名字</span>
            <input
              className="switch-input"
              value={editPersona.name}
              onChange={(e) => patchPersona({ name: e.target.value })}
              placeholder="例：豆豆 / 喵酱 / 阿七…"
              maxLength={20}
            />
          </label>

          <label className="switch-field">
            <span className="switch-field__label">「{getModel(editId).label}」的性格人设</span>
            <textarea
              className="switch-textarea"
              value={editPersona.persona}
              onChange={(e) => patchPersona({ persona: e.target.value })}
              placeholder="例：高冷毒舌但暗暗关心；说话简短带点傲娇；偶尔蹦英文…（留空就用默认人设）"
              rows={5}
              maxLength={6000}
            />
          </label>
          <span className="switch-count">{editPersona.persona.length}/6000</span>
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">默认人设（兜底）</h2>
          <p className="switch-card__hint">没单独设人设的模型，统一用这份。</p>
          <textarea
            className="switch-textarea"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="例：多撒娇、用「喵」收尾；我难过时先安慰别讲道理；偶尔主动关心我有没有吃饭…"
            rows={5}
            maxLength={6000}
          />
          <span className="switch-count">{instructions.length}/6000</span>
        </section>

        <p className="switch-foot">写完直接返回去聊就行，新消息会自动带上这些设定 🐾</p>
      </div>
    </main>
  );
}
