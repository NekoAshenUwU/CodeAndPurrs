import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createSpotifyPlayer,
  getSpotifyStatus,
  pickSpotifyTrack,
  playSpotifyTrack,
  type SpotifyPick,
  type SpotifyPlayer,
  type SpotifyStatus,
  type WebPlaybackState,
} from '../services/spotify';

type Intensity = 'soft' | 'normal' | 'high';

const PARTICLES = Array.from({ length: 38 }, (_, index) => ({
  id: index,
  left: 2 + ((index * 37) % 96),
  delay: -((index * 0.71) % 10),
  duration: 5.8 + ((index * 17) % 44) / 10,
  size: 1.4 + ((index * 13) % 26) / 10,
  drift: -32 + ((index * 29) % 64),
}));

const INTENSITY_LABEL: Record<Intensity, string> = {
  soft: '轻柔星尘',
  normal: '星河流动',
  high: '极光盛放',
};

function formatTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function HisPlaylistPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SpotifyStatus>({ configured: false, connected: false });
  const [statusReady, setStatusReady] = useState(false);
  const [player, setPlayer] = useState<SpotifyPlayer | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [playing, setPlaying] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [intensity, setIntensity] = useState<Intensity>('soft');
  const [prompt, setPrompt] = useState('');
  const [pick, setPick] = useState<SpotifyPick | null>(null);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState('');
  const stateRef = useRef<WebPlaybackState | null>(null);

  useEffect(() => {
    getSpotifyStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, connected: false }))
      .finally(() => setStatusReady(true));
  }, []);

  useEffect(() => {
    if (!status.connected) return;
    let live = true;
    let created: SpotifyPlayer | null = null;
    createSpotifyPlayer({
      onReady: (id) => live && setDeviceId(id),
      onState: (state) => {
        if (!live || !state) return;
        stateRef.current = state;
        setPlaying(!state.paused);
        setPosition(state.position);
        setDuration(state.duration);
      },
      onError: (message) => live && setNotice(message),
    })
      .then((instance) => {
        created = instance;
        if (live) setPlayer(instance);
      })
      .catch((error) => live && setNotice(String(error.message || error)));
    return () => {
      live = false;
      created?.disconnect();
    };
  }, [status.connected]);

  useEffect(() => {
    if (!playing || !duration) return;
    const timer = window.setInterval(() => {
      setPosition((current) => Math.min(duration, current + 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [playing, duration]);

  const active = playing || previewPlaying;
  const visibleParticles = intensity === 'soft' ? 12 : intensity === 'normal' ? 24 : 38;
  const progress = duration ? Math.min(100, (position / duration) * 100) : previewPlaying ? 34 : 0;
  const nowPlaying = useMemo(
    () => ({
      name: pick?.track.name || '今晚，听我挑给你的',
      artist: pick?.track.artist || 'His Playlist · visual preview',
      image: pick?.track.image || null,
    }),
    [pick],
  );

  const connect = () => {
    if (!status.configured) {
      setNotice('播放器框架已完成，填入 Spotify 开发者资料后就能登录。');
      return;
    }
    window.location.href = '/api/spotify/login';
  };

  const toggle = async () => {
    setNotice('');
    if (player) {
      await player.activateElement();
      await player.togglePlay();
      return;
    }
    setPreviewPlaying((value) => !value);
  };

  const askForSong = async () => {
    const text = prompt.trim();
    if (!text) {
      setNotice('告诉我今晚是什么心情，我才好挑歌。');
      return;
    }
    if (!status.connected) {
      setNotice('点歌台已经做好；Spotify 真播放测试解锁后，我会从完整曲库里挑。');
      setPreviewPlaying(true);
      setIntensity(/累|困|睡|安静|轻柔/.test(text) ? 'soft' : /开心|兴奋|嗨|强烈/.test(text) ? 'high' : 'normal');
      return;
    }
    setPicking(true);
    setNotice('');
    try {
      const next = await pickSpotifyTrack(text);
      setPick(next);
      setIntensity(next.intensity);
      if (!deviceId) throw new Error('播放器还在醒来，再点一次就好。');
      await player?.activateElement();
      await playSpotifyTrack(deviceId, next.track.uri);
    } catch (error) {
      setNotice(String(error instanceof Error ? error.message : error));
    } finally {
      setPicking(false);
    }
  };

  return (
    <main className={`his-playlist intensity-${intensity} ${active ? 'is-playing' : 'is-paused'}`}>
      <div className="his-playlist__backdrop" aria-hidden="true" />
      <div className="aurora aurora--one" aria-hidden="true" />
      <div className="aurora aurora--two" aria-hidden="true" />
      <div className="aurora aurora--three" aria-hidden="true" />
      <div className="starfall" aria-hidden="true">
        {PARTICLES.slice(0, visibleParticles).map((particle) => (
          <i
            key={particle.id}
            style={
              {
                left: `${particle.left}%`,
                width: `${particle.size}px`,
                height: `${particle.size * 2.8}px`,
                animationDelay: `${particle.delay}s`,
                animationDuration: `${particle.duration}s`,
                '--star-drift': `${particle.drift}px`,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <header className="hp-head">
        <button type="button" className="hp-head__back" aria-label="回到首页" onClick={() => navigate('/')}>
          ‹
        </button>
        <div>
          <h1>他的歌单</h1>
          <p>His Playlist</p>
        </div>
        <button type="button" className="hp-head__spotify" onClick={connect}>
          <span className={status.connected ? 'is-live' : ''} />
          {status.connected ? status.displayName || 'Spotify' : '连接 Spotify'}
        </button>
      </header>

      <section className="hp-intro" aria-label="房间介绍">
        <p>今晚，听我挑给你的。</p>
        <span>{INTENSITY_LABEL[intensity]}</span>
      </section>

      <section className="hp-pick glass-night" aria-label="AI 点歌">
        <label htmlFor="hp-prompt">想听什么</label>
        <div className="hp-pick__row">
          <input
            id="hp-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void askForSong()}
            placeholder="今天有点累，挑一首抱着我听的……"
          />
          <button type="button" onClick={() => void askForSong()} disabled={picking}>
            {picking ? '挑选中' : '替我点歌'}
          </button>
        </div>
        {pick?.reason ? <p className="hp-pick__reason">“{pick.reason}”</p> : null}
      </section>

      <section className="hp-player glass-night" aria-label="呼噜留声机">
        <div className="hp-player__cover">
          {nowPlaying.image ? <img src={nowPlaying.image} alt="" /> : <span>✦</span>}
        </div>
        <div className="hp-player__track">
          <small>呼噜留声机</small>
          <h2>{nowPlaying.name}</h2>
          <p>{nowPlaying.artist}</p>
        </div>

        <div className="hp-progress">
          <button
            type="button"
            aria-label="调整播放进度"
            onClick={(event) => {
              if (!player || !duration) return;
              const rect = event.currentTarget.getBoundingClientRect();
              void player.seek(((event.clientX - rect.left) / rect.width) * duration);
            }}
          >
            <span style={{ width: `${progress}%` }} />
          </button>
          <div><span>{formatTime(position)}</span><span>{formatTime(duration)}</span></div>
        </div>

        <div className="hp-controls">
          <button type="button" aria-label="上一首" onClick={() => void player?.previousTrack()}>‹</button>
          <button type="button" className="hp-controls__play" aria-label={active ? '暂停' : '播放'} onClick={() => void toggle()}>
            {active ? 'Ⅱ' : '▶'}
          </button>
          <button type="button" aria-label="下一首" onClick={() => void player?.nextTrack()}>›</button>
        </div>

        <div className="hp-moods" aria-label="星光强度">
          {(['soft', 'normal', 'high'] as Intensity[]).map((value) => (
            <button
              type="button"
              key={value}
              className={intensity === value ? 'is-active' : ''}
              onClick={() => setIntensity(value)}
            >
              {INTENSITY_LABEL[value]}
            </button>
          ))}
        </div>
      </section>

      {notice ? <div className="hp-notice" role="status">{notice}</div> : null}
      {!statusReady ? <div className="hp-loading">正在唤醒星河……</div> : null}
    </main>
  );
}
