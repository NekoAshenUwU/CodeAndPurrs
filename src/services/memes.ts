// 脑洞贴纸盒 —— 表情包/贴纸存在这台设备的 IndexedDB 里。
// 图片可能比较大，localStorage 5MB 装不下，所以单独用 IndexedDB 存原图 blob。
// 聊天里发表情只存它的 id（见 PurrChannelPage 的 Turn.meme），用到时再来这里取 blob。

const DB_NAME = 'codeandpurrs-memes';
const STORE = 'memes';
const DB_VERSION = 1;

export type MemeItem = {
  id: string;
  name: string;
  type: string; // MIME，如 image/png
  createdAt: number;
};

type MemeRecord = MemeItem & { blob: Blob };

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打不开贴纸盒数据库'));
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// 列出所有贴纸（按加入时间新→旧），不含 blob，给网格用 getMemeURL 取图。
export async function listMemes(): Promise<MemeItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').getAll();
    req.onsuccess = () => {
      const rows = (req.result as MemeRecord[]).map(({ blob: _blob, ...meta }) => meta);
      rows.sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error ?? new Error('读不到贴纸'));
  });
}

// 存一张贴纸（从文件选择器拿到的 File）。
export async function addMeme(file: File): Promise<MemeItem> {
  const db = await openDB();
  const record: MemeRecord = {
    id: uid(),
    name: file.name || '贴纸',
    type: file.type || 'image/png',
    createdAt: Date.now(),
    blob: file,
  };
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').add(record);
    req.onsuccess = () => {
      const { blob: _blob, ...meta } = record;
      resolve(meta);
    };
    req.onerror = () => reject(req.error ?? new Error('存不进贴纸盒'));
  });
}

// 给贴纸改名（AI 靠名字挑表情包发，所以名字最好起得有意义）。
export async function renameMeme(id: string, name: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, 'readwrite');
    const g = store.get(id);
    g.onsuccess = () => {
      const rec = g.result as MemeRecord | undefined;
      if (!rec) {
        resolve();
        return;
      }
      rec.name = name;
      const p = store.put(rec);
      p.onsuccess = () => resolve();
      p.onerror = () => reject(p.error ?? new Error('改名失败'));
    };
    g.onerror = () => reject(g.error ?? new Error('改名失败'));
  });
}

export async function removeMeme(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('删不掉这张贴纸'));
  });
}

// 取某张贴纸的可显示地址（object URL）。找不到（被删了）返回 null。
// 注意：object URL 用完不主动 revoke，本应用规模小、和语音气泡同样处理。
export async function getMemeURL(id: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => {
      const rec = req.result as MemeRecord | undefined;
      resolve(rec ? URL.createObjectURL(rec.blob) : null);
    };
    req.onerror = () => reject(req.error ?? new Error('取不到这张贴纸'));
  });
}

// 取某张贴纸的 base64 data URL —— 发给能看图的模型（GPT-4o/Gemini/Claude/DeepSeek-v4-pro）用。
// 关键：发给模型前先把图压到 maxDim 见方的 JPEG，体积从几百KB降到几十KB，
// 否则多张全尺寸图叠进聊天历史会把请求体撑爆（上游报 invalid_request_error）。
export async function getMemeDataUrl(id: string, maxDim = 768): Promise<string | null> {
  const db = await openDB();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => resolve((req.result as MemeRecord | undefined)?.blob ?? null);
    req.onerror = () => reject(req.error ?? new Error('取不到这张贴纸'));
  });
  if (!blob) return null;
  try {
    return await downscaleToDataUrl(blob, maxDim);
  } catch {
    // 压缩失败（解码不了等）就退回原图 base64，至少能发出去
    return blobToDataUrl(blob);
  }
}

// 把 blob 缩到 maxDim 见方、导出 JPEG data URL（动图只取首帧，够模型看了）
async function downscaleToDataUrl(blob: Blob, maxDim: number): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败'));
      im.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height) || 1);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('拿不到画布');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => reject(fr.error ?? new Error('读不出这张贴纸'));
    fr.readAsDataURL(blob);
  });
}
