export type SpotifyStatus = {
  configured: boolean;
  connected: boolean;
  displayName?: string;
};

export type SpotifyTrack = {
  id: string;
  uri: string;
  name: string;
  artist: string;
  album: string;
  image: string | null;
  durationMs: number;
};

export type SpotifyPick = {
  track: SpotifyTrack;
  reason: string;
  intensity: 'soft' | 'normal' | 'high';
};

type WebPlaybackTrack = {
  uri: string;
  id: string;
  name: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album: { name: string; images: Array<{ url: string }> };
};

export type WebPlaybackState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: WebPlaybackTrack };
};

export type SpotifyPlayer = {
  connect(): Promise<boolean>;
  disconnect(): void;
  togglePlay(): Promise<void>;
  previousTrack(): Promise<void>;
  nextTrack(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  activateElement(): Promise<void>;
  addListener(event: string, callback: (payload: any) => void): boolean;
};

declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (callback: (token: string) => void) => void;
        volume?: number;
        enableMediaSession?: boolean;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

async function json<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Spotify 请求失败（${response.status}）`);
  return data;
}

export async function getSpotifyStatus(): Promise<SpotifyStatus> {
  return json<SpotifyStatus>(await fetch('/api/spotify/status', { credentials: 'include' }));
}

export async function getSpotifyToken(): Promise<string> {
  const data = await json<{ accessToken: string }>(
    await fetch('/api/spotify/token', { credentials: 'include' }),
  );
  return data.accessToken;
}

export async function pickSpotifyTrack(prompt: string): Promise<SpotifyPick> {
  return json<SpotifyPick>(
    await fetch('/api/spotify/pick', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }),
  );
}

export async function playSpotifyTrack(deviceId: string, uri: string): Promise<void> {
  await json<{ ok: boolean }>(
    await fetch('/api/spotify/play', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, uri }),
    }),
  );
}

function loadSpotifySdk(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-codeandpurrs-spotify]');
    const timeout = window.setTimeout(() => reject(new Error('Spotify 播放器加载超时')), 15_000);
    window.onSpotifyWebPlaybackSDKReady = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    if (existing) return;
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.dataset.codeandpurrsSpotify = 'true';
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Spotify 播放器脚本载入失败'));
    };
    document.head.appendChild(script);
  });
}

export async function createSpotifyPlayer(handlers: {
  onReady: (deviceId: string) => void;
  onState: (state: WebPlaybackState | null) => void;
  onError: (message: string) => void;
}): Promise<SpotifyPlayer> {
  await loadSpotifySdk();
  if (!window.Spotify) throw new Error('Spotify 播放器没有准备好');

  const player = new window.Spotify.Player({
    name: '他的歌单 · CodeAndPurrs',
    getOAuthToken: (callback) => {
      getSpotifyToken().then(callback).catch((error) => handlers.onError(String(error.message || error)));
    },
    volume: 0.72,
    enableMediaSession: true,
  });

  player.addListener('ready', ({ device_id }: { device_id: string }) => handlers.onReady(device_id));
  player.addListener('not_ready', () => handlers.onError('Spotify 播放器暂时离线'));
  player.addListener('player_state_changed', handlers.onState);
  for (const event of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
    player.addListener(event, ({ message }: { message: string }) => handlers.onError(message));
  }

  const connected = await player.connect();
  if (!connected) throw new Error('Spotify 播放器连接失败');
  return player;
}
