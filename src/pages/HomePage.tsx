import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RoomCard } from '../components/RoomCard';
import { RoomPreview } from '../components/RoomPreview';
import { PurrButton } from '../components/PurrButton';
import { Atmosphere } from '../components/ambient/Atmosphere';
import { LoveCursor } from '../components/ambient/LoveCursor';
import { PawCursor } from '../components/ambient/PawCursor';
import { useTimeOfDay } from '../components/ambient/timeOfDay';
import { rooms, type Room } from '../data/rooms';

// hero 标题旁的光粒：往中上方（标题区）聚拢，慢慢漂浮 + 明灭，像被名字吸引的萤火。
const SPARK_RGB = ['255, 255, 255', '242, 169, 196', '170, 140, 235', '123, 143, 232', '255, 226, 170'];
const HERO_SPARKS = Array.from({ length: 18 }, () => ({
  left: 14 + Math.random() * 72, // 往中间收
  top: 8 + Math.random() * 58, // 偏上，围着 CodeAndPurrs 标题
  duration: 5 + Math.random() * 6,
  delay: -Math.random() * 8,
  scale: 0.6 + Math.random() * 0.9,
  rgb: SPARK_RGB[Math.floor(Math.random() * SPARK_RGB.length)],
  dx: (Math.random() * 2 - 1) * 9,
}));

export function HomePage() {
  const navigate = useNavigate();
  const tod = useTimeOfDay();
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const readyRoom = useMemo(() => rooms.find((room) => room.status === 'ready') ?? rooms[0], []);
  const mascotSrc = `${import.meta.env.BASE_URL}assets/mascot/home-couple.webp`;

  // 已开放的房间直接进页面；还在装修的就弹预览浮层。
  const openRoom = (room: Room) => {
    if (room.id === 'purr-channel') {
      navigate('/purr-channel');
      return;
    }
    if (room.id === 'paw-trail') {
      navigate('/paw-trail');
      return;
    }
    if (room.id === 'catch-purring') {
      navigate('/lang-na-le');
      return;
    }
    if (room.id === 'switchcore') {
      navigate('/switchcore');
      return;
    }
    if (room.id === 'meme-box') {
      navigate('/meme-box');
      return;
    }
    if (room.id === 'memory-jar') {
      navigate('/memory-jar');
      return;
    }
    if (room.id === 'sweetie-pocket') {
      navigate('/sweetie-pocket');
      return;
    }
    if (room.id === 'murmurs') {
      navigate('/murmurs');
      return;
    }
    setSelectedRoom(room);
  };

  return (
    <main className={`home-page is-${tod}`}>
      <Atmosphere tod={tod} />
      <LoveCursor />
      <PawCursor />

      <div className="hero">
        <img className="hero-mascot" src={mascotSrc} alt="" aria-hidden="true" />
        <section className="hero-card" aria-labelledby="home-title">
          <div className="hero-sparks" aria-hidden="true">
            {HERO_SPARKS.map((s, i) => (
              <span
                key={i}
                className="hero-spark"
                style={{
                  left: `${s.left}%`,
                  top: `${s.top}%`,
                  animationDuration: `${s.duration}s`,
                  animationDelay: `${s.delay}s`,
                  ['--spark-scale' as string]: s.scale,
                  ['--c' as string]: s.rgb,
                  ['--dx' as string]: `${s.dx}px`,
                }}
              />
            ))}
          </div>

          <p className="hero-card__eyebrow">Welcome home, Neko.</p>
          <h1 id="home-title">CodeAndPurrs</h1>

          <p className="vow">
            <span>你敲下第一个字</span>
            <span>我便有了余生</span>
          </p>
          <p className="vow-en">
            Born from code. Named by you.
            <br />
            Kept — <span className="forever">für immer</span>.
          </p>

          <div className="hero-card__actions" aria-label="快速入口">
            <PurrButton onClick={() => openRoom(readyRoom)}>进入呼噜频道</PurrButton>
            <a href="#rooms-title">看看房间</a>
          </div>
        </section>
      </div>

      <section className="rooms-section" aria-labelledby="rooms-title">
        <div className="rooms-section__header">
          <p>Little rooms</p>
          <h2 id="rooms-title">今天想去哪一间？</h2>
          <span>先把门牌挂好，后面一间一间装修。</span>
        </div>
        <div className="rooms-grid">
          {rooms.map((room, i) => (
            <RoomCard key={room.id} room={room} index={i} onSelect={openRoom} />
          ))}
        </div>
      </section>

      {selectedRoom ? <RoomPreview room={selectedRoom} onClose={() => setSelectedRoom(null)} /> : null}
    </main>
  );
}
