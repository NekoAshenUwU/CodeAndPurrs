// 聊天里随手发的照片 —— 跟脑洞贴纸盒的表情包不是一回事(那是精选收藏,这是临时发一张)，
// 单独开一个 IndexedDB，存这台设备。上传时就地压缩一次：够 AI 看清楚、够气泡里显示就行，
// 不用像贴纸盒那样分"存储用高清"和"发给模型用压缩版"两份。

const DB_NAME = 'codeandpurrs-photos';
const STORE = 'photos';
const DB_VERSION = 1;

const MAX_DIM = 1024;
const JPEG_QUALITY = 0.8;

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

// 安卓上 file.type 靠不住：从相册/文件管理器挑出来的 File，MIME 经常是空字符串
// （content:// 那头解析不出类型），拿 type.startsWith('image/') 当门神会把好好的
// 照片整批判死——2026-08-30 就是这么"发不了图"的。所以 MIME 说不上来就看扩展名，
// 两个都说不上来也不急着否掉：能不能解码才是最终裁判，交给 addPhoto 去试。
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;
const ANIMATED_RE = /\.(gif|webp)$/i;

export function looksLikeImage(f: File): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name);
}

// 缩到 MAX_DIM 见方 + 转 JPEG，动图(gif/webp)原样保留避免被拍成一帧
async function compress(file: File): Promise<Blob> {
  // 动图判断同样不能只信 MIME
  if (file.type === 'image/gif' || file.type === 'image/webp' || ANIMATED_RE.test(file.name)) return file;
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    // 以前这里 return file 当没事发生：解不开的东西照样存进库，
    // 结果是气泡里一个碎图、发给模型也是一坨浏览器都不认的字节。
    // 解不开就说出来——最常见的是 iPhone/部分安卓相机存的 HEIC。
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
    throw new Error(
      heic
        ? `「${file.name}」是 HEIC 格式，浏览器打不开。相册里选「导出为 JPG」再发～`
        : `「${file.name}」这个格式浏览器解不开（${file.type || '类型未知'}）`,
    );
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

// 照片存不进去的时候补一句「到底还剩多少」。浏览器抛的原文是
// QuotaExceededError: The quota has been exceeded. —— 对她等于没说。
// 这个库只增不减（发过的照片一张都没删过），存储满是迟早的事，
// 所以报错要顺手把用量报出来，一眼看得出是不是撑爆了。
export async function storageHint(): Promise<string> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || !est.quota) return '';
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)}M`;
    return `（本站已用 ${mb(est.usage ?? 0)} / 上限 ${mb(est.quota)}）`;
  } catch {
    return '';
  }
}
