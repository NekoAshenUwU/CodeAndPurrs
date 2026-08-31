import type { ChatMessage, Provider } from './chat';

export type AutoWakeClientState = {
  windowId: string;
  windowName: string;
  assistantName?: string;
  modelId: string;
  provider: Provider;
  model?: string;
  systemPrompt: string;
  messages: ChatMessage[];
  liveContext?: string;
  lastUserAt: number;
  lastAssistantAt: number;
};

export type AutoWakeInboxMessage = {
  id: string;
  windowId: string;
  windowName: string;
  assistantName?: string;
  modelId?: string;
  role: 'assistant';
  content: string;
  at: number;
};

export type AutoWakeStatus = 'unsupported' | 'blocked' | 'off' | 'on';

function supported(): boolean {
  return typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
}

function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const raw = window.atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function keyBytes(value: ArrayBuffer | null): Uint8Array {
  return value ? new Uint8Array(value) : new Uint8Array();
}

function sameApplicationServerKey(subscription: PushSubscription, expected: Uint8Array): boolean {
  const actual = keyBytes(subscription.options.applicationServerKey);
  if (actual.length !== expected.length) return false;
  return actual.every((byte, index) => byte === expected[index]);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body?.error || `自动唤醒服务返回 ${response.status}`));
  return body as T;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  });
  await reg.update().catch(() => undefined);
  return navigator.serviceWorker.ready;
}

async function freshRegistration(): Promise<ServiceWorkerRegistration> {
  const old = await navigator.serviceWorker.getRegistration('/');
  if (old) {
    const oldSubscription = await old.pushManager.getSubscription().catch(() => null);
    await oldSubscription?.unsubscribe().catch(() => false);
    await old.unregister();
  }
  await wait(400);
  await navigator.serviceWorker.register('/sw.js', {
    scope: '/',
    updateViaCache: 'none',
  });
  return navigator.serviceWorker.ready;
}

function isRecoverablePushError(error: unknown): boolean {
  const message = String((error as Error)?.message || error).toLowerCase();
  return message.includes('push service error') ||
    message.includes('push service not available') ||
    message.includes('storage error') ||
    message.includes('sender_id_mismatch') ||
    message.includes('different applicationserverkey');
}

async function subscribeWithRecovery(publicKey: string): Promise<PushSubscription> {
  const applicationServerKey = decodeApplicationServerKey(publicKey);
  let reg = await registration();
  let existing = await reg.pushManager.getSubscription();
  if (existing && !sameApplicationServerKey(existing, applicationServerKey)) {
    await existing.unsubscribe();
    existing = null;
  }
  if (existing) return existing;

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.buffer,
      });
    } catch (error) {
      lastError = error;
      if (!isRecoverablePushError(error)) throw error;
      await wait(900 * (attempt + 1));
      reg = attempt === 0 ? await registration() : await freshRegistration();
    }
  }
  throw new Error(
    `手机的推送服务连续登记失败。Chrome 与 Google Play 服务需要允许联网和后台运行，再点一次铃铛（${String((lastError as Error)?.message || lastError)}）`,
  );
}

async function postSubscription(state: AutoWakeClientState, subscription: PushSubscription): Promise<void> {
  await json(
    await fetch('/api/autowake/subscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON(), state }),
    }),
  );
}

export async function getAutoWakeStatus(): Promise<AutoWakeStatus> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await registration();
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function enableAutoWake(state: AutoWakeClientState): Promise<void> {
  if (!supported()) throw new Error('这个浏览器不支持后台通知');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? '通知权限被浏览器拦住了，请在网站设置里改成允许' : '没有允许通知');
  }
  const config = await json<{ publicKey: string }>(
    await fetch('/api/autowake/config', { credentials: 'include', cache: 'no-store' }),
  );
  const subscription = await subscribeWithRecovery(config.publicKey);
  await postSubscription(state, subscription);
}

export async function syncAutoWakeState(state: AutoWakeClientState): Promise<boolean> {
  if (!supported() || Notification.permission !== 'granted') return false;
  const reg = await registration();
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return false;
  await postSubscription(state, subscription);
  return true;
}

export async function fetchAutoWakeInbox(): Promise<AutoWakeInboxMessage[]> {
  const body = await json<{ messages?: AutoWakeInboxMessage[] }>(
    await fetch('/api/autowake/inbox', { credentials: 'include', cache: 'no-store' }),
  );
  return Array.isArray(body.messages) ? body.messages : [];
}

export async function acknowledgeAutoWake(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await json(
    await fetch('/api/autowake/ack', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  );
}

export async function testAutoWake(): Promise<void> {
  await json(
    await fetch('/api/autowake/test', {
      method: 'POST',
      credentials: 'include',
    }),
  );
}
