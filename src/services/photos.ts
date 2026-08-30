// 聊天里随手发的照片 —— 跟脑洞贴纸盒的表情包不是一回事(那是精选收藏,这是临时发一张)，
// 单独开一个 IndexedDB，存这台设备。上传时就地压缩一次：够 AI 看清楚、够气泡里显示就行，
// 不用像贴纸盒那样分"存储用高清"和"发给模型用压缩版"两份。

const DB_NAME = 'codeandpurrs-photos';
const STORE = 'photos';

const MAX_DIM = 1024;
const JPEG_QUALITY = 0.8;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // 不指定版本：直接打开浏览器现有的最高版本，避免旧前端把已经升级过的
    // 照片库强行按 v1 打开而触发 VersionError。
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打不开照片数据库'));
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

// 缩到 MAX_DIM 见方 + 转 JPEG，动图(gif/webp)原样保留避免被拍成一帧
async function compress(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.type === 'image/webp') return file;
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height) || 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  return blob && blob.size < file.size ? blob : file;
}

// 压缩后存进去，返回 id（存进 Turn.photo，用到时再来这里取）
export async function addPhoto(file: File): Promise<string> {
  const blob = await compress(file);
  const db = await openDB();
  const id = uid();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').add({ id, blob });
    req.onsuccess = () => resolve(id);
    req.onerror = () => reject(req.error ?? new Error('存不下这张照片'));
  });
}

// 取可显示地址（object URL），聊天气泡里用
export async function getPhotoURL(id: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => {
      const rec = req.result as { blob: Blob } | undefined;
      resolve(rec ? URL.createObjectURL(rec.blob) : null);
    };
    req.onerror = () => reject(req.error ?? new Error('取不到这张照片'));
  });
}

// 取 base64 data URL，发给模型看图用（存的时候已经压过一次，这里直接读，不用二次压缩）
export async function getPhotoDataUrl(id: string): Promise<string | null> {
  const db = await openDB();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const req = tx(db, 'readonly').get(id);
    req.onsuccess = () => resolve((req.result as { blob: Blob } | undefined)?.blob ?? null);
    req.onerror = () => reject(req.error ?? new Error('取不到这张照片'));
  });
  if (!blob) return null;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => reject(fr.error ?? new Error('读不出这张照片'));
    fr.readAsDataURL(blob);
  });
}
