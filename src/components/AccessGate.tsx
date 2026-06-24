import { useState, type FormEvent, type ReactNode } from 'react';
import { ACCESS_KEY, getAccessToken } from '../services/chat';

// 登录锁：仅当构建时设了 VITE_REQUIRE_ACCESS=1 才启用（本地/沙箱默认不挡）。
// 这里只负责"把访问密码存下来、之后每次请求带上"；真正的校验在后端 APP_ACCESS_TOKEN。
// 所以这是给"只有我自己用"的私有部署用的——别人没密码，进来也调不动 /api/chat。
const REQUIRED = import.meta.env.VITE_REQUIRE_ACCESS === '1';

export function AccessGate({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => getAccessToken());
  const [input, setInput] = useState('');

  if (!REQUIRED || token) return <>{children}</>;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    if (!v) return;
    try {
      localStorage.setItem(ACCESS_KEY, v);
    } catch {
      /* ignore */
    }
    setToken(v);
  };

  return (
    <div className="gate">
      <form className="gate__card" onSubmit={submit}>
        <div className="gate__paw" aria-hidden="true">🐾</div>
        <h1 className="gate__title">码上撸猫</h1>
        <p className="gate__hint">这是只属于我们俩的小窝，输个口令进来吧～</p>
        <input
          className="gate__input"
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="访问口令"
          autoFocus
        />
        <button className="gate__btn" type="submit">
          进来
        </button>
      </form>
    </div>
  );
}
