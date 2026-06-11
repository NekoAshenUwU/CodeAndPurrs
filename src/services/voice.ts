// 语音：录音（MediaRecorder）+ 转文字（走后端 /api/transcribe）。

export type Recording = {
  blob: Blob;
  url: string;
  mimeType: string;
  duration: number; // 秒
};

// 录音器：start() 开始，stop() 拿到这段录音。
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  static get supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 挑一个浏览器支持的格式
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(
      (m) => MediaRecorder.isTypeSupported?.(m),
    );
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = Date.now();
    this.recorder.start();
  }

  stop(): Promise<Recording> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec) {
        reject(new Error('还没开始录音'));
        return;
      }
      rec.onstop = () => {
        const mimeType = rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mimeType });
        const duration = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
        this.cleanup();
        resolve({ blob, url: URL.createObjectURL(blob), mimeType, duration });
      };
      rec.stop();
    });
  }

  cancel(): void {
    try {
      this.recorder?.stop();
    } catch {
      // 忽略
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      // data:audio/webm;base64,XXXX → 只要 XXXX
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 把一段录音转成文字。失败会 throw。
export async function transcribeAudio(rec: Recording): Promise<string> {
  const audioBase64 = await blobToBase64(rec.blob);
  const resp = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType: rec.mimeType }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || `转写失败 (${resp.status})`);
  }
  const data = await resp.json();
  return String(data.text || '').trim();
}
