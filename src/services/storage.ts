// 小暗格 —— 把数据安安静静睡在这台设备的 localStorage 里。
// 私密、不上传，以后导出舱会从这里打包。

const PREFIX = 'codeandpurrs:';

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 存满了或隐私模式，忽略，不让它把页面搞崩
  }
}

export function clearLocal(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // 忽略
  }
}
