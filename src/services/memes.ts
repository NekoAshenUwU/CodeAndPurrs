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
