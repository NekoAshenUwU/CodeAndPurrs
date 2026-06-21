import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getModel, MODEL_GROUPS, MODELS } from '../data/models';
import {
  loadChatAvatar,
  loadChatUserAvatar,
  loadChatBg,
  loadDefaultModel,
  loadInstructions,
  loadPersonas,
  loadProfile,
  saveChatAvatar,
  saveChatUserAvatar,
  saveChatBg,
  saveDefaultModel,
  saveInstructions,
  savePersonas,
  saveProfile,
  type Persona,
} from '../services/purrConfig';

// 把上传的图压成不太大的 dataURL（jpeg 0.82），省 localStorage。头像传小一点的 max。
function compressImage(file: File, max = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('no canvas'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = String(reader.result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 调频 SwitchCore：设默认模型 + 关于我 + 默认人设 + 每个模型各自的名字/人设。
export function SwitchCorePage() {
  const [provider, setProvider] = useState<string>(loadDefaultModel);
  const [profile, setProfile] = useState<string>(loadProfile);
  const [instructions, setInstructions] = useState<string>(loadInstructions);
  const [personas, setPersonas] = useState<Record<string, Persona>>(loadPersonas);
  const [editId, setEditId] = useState<string>(() => loadDefaultModel() || MODELS[0].id);
  const [savedFlash, setSavedFlash] = useState(false);
  const [chatBg, setChatBg] = useState<string>(loadChatBg);
  const [bgBusy, setBgBusy] = useState(false);
  const [avatar, setAvatar] = useState<string>(loadChatAvatar);
  const [avBusy, setAvBusy] = useState(false);
  const [myAvatar, setMyAvatar] = useState<string>(loadChatUserAvatar);
  const [myAvBusy, setMyAvBusy] = useState(false);

  const applyBg = (dataUrl: string) => {
    const root = document.documentElement;
    if (dataUrl) root.style.setProperty('--chat-bg-image', `url(${dataUrl})`);
    else root.style.removeProperty('--chat-bg-image');
  };
  const onPickBg = async (file: File | undefined) => {
    if (!file) return;
    setBgBusy(true);
    try {
      const dataUrl = await compressImage(file);
      saveChatBg(dataUrl);
      setChatBg(dataUrl);
      applyBg(dataUrl);
    } catch {
      window.alert('这张图处理失败了，换一张试试～');
    } finally {
      setBgBusy(false);
    }
  };
  const resetBg = () => {
    saveChatBg('');
    setChatBg('');
    applyBg('');
  };

  const onPickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setAvBusy(true);
    try {
      const dataUrl = await compressImage(file, 256); // 头像小一点就够，省空间
      saveChatAvatar(dataUrl);
      setAvatar(dataUrl);
    } catch {
      window.alert('这张头像处理失败了，换一张试试～');
    } finally {
      setAvBusy(false);
    }
  };
  const resetAvatar = () => {
    saveChatAvatar('');
    setAvatar('');
  };

  const onPickMyAvatar = async (file: File | undefined) => {
    if (!file) return;
    setMyAvBusy(true);
    try {
      const dataUrl = await compressImage(file, 256);
      saveChatUserAvatar(dataUrl);
      setMyAvatar(dataUrl);
    } catch {
      window.alert('这张头像处理失败了，换一张试试～');
    } finally {
      setMyAvBusy(false);
    }
  };
  const resetMyAvatar = () => {
    saveChatUserAvatar('');
    setMyAvatar('');
  };

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

        <section className="switch-card">
          <h2 className="switch-card__title">对方头像</h2>
          <p className="switch-card__hint">传一张图当予予的头像，会显示在每条回复气泡旁边（只存在你手机里）。</p>
          <div className="switch-bg switch-bg--avatar">
            <div
              className="switch-bg__preview switch-bg__preview--avatar"
              style={avatar ? { backgroundImage: `url(${avatar})` } : undefined}
            >
              {avatar ? null : <span>🐾</span>}
            </div>
            <div className="switch-bg__ops">
              <label className={`switch-bg__btn${avBusy ? ' is-busy' : ''}`}>
                {avBusy ? '处理中…' : avatar ? '换一张' : '上传头像'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={avBusy}
                  onChange={(e) => onPickAvatar(e.target.files?.[0])}
                />
              </label>
              {avatar ? (
                <button type="button" className="switch-bg__btn is-ghost" onClick={resetAvatar}>
                  恢复默认
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">我的头像</h2>
          <p className="switch-card__hint">传一张图当你自己的头像，会显示在你发的消息气泡旁边（只存在你手机里）。</p>
          <div className="switch-bg switch-bg--avatar">
            <div
              className="switch-bg__preview switch-bg__preview--avatar"
              style={myAvatar ? { backgroundImage: `url(${myAvatar})` } : undefined}
            >
              {myAvatar ? null : <span>🐾</span>}
            </div>
            <div className="switch-bg__ops">
              <label className={`switch-bg__btn${myAvBusy ? ' is-busy' : ''}`}>
                {myAvBusy ? '处理中…' : myAvatar ? '换一张' : '上传头像'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={myAvBusy}
                  onChange={(e) => onPickMyAvatar(e.target.files?.[0])}
                />
              </label>
              {myAvatar ? (
                <button type="button" className="switch-bg__btn is-ghost" onClick={resetMyAvatar}>
                  恢复默认
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="switch-card">
          <h2 className="switch-card__title">聊天背景</h2>
          <p className="switch-card__hint">换成你喜欢的图，呼噜频道就用它当背景（只存在你手机里，随时换/还原）。</p>
          <div className="switch-bg">
            <div
              className="switch-bg__preview"
              style={chatBg ? { backgroundImage: `url(${chatBg})` } : undefined}
            >
              {chatBg ? null : <span>默认场景</span>}
            </div>
            <div className="switch-bg__ops">
              <label className={`switch-bg__btn${bgBusy ? ' is-busy' : ''}`}>
                {bgBusy ? '处理中…' : chatBg ? '换一张' : '上传图片'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={bgBusy}
                  onChange={(e) => onPickBg(e.target.files?.[0])}
                />
              </label>
              {chatBg ? (
                <button type="button" className="switch-bg__btn is-ghost" onClick={resetBg}>
                  恢复默认
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <p className="switch-foot">写完直接返回去聊就行，新消息会自动带上这些设定 🐾</p>
      </div>
    </main>
  );
}
