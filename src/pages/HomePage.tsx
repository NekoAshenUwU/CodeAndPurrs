import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RoomCard } from '../components/RoomCard';
import { RoomPreview } from '../components/RoomPreview';
import { rooms, type Room } from '../data/rooms';

export function HomePage() {
  const navigate = useNavigate();
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const readyRoom = useMemo(() => rooms.find((room) => room.status === 'ready') ?? rooms[0], []);

  // 已开放的房间直接进页面；还在装修的就弹预览浮层。
  const openRoom = (room: Room) => {
    if (room.id === 'purr-channel') {
      navigate('/purr-channel');
      return;
    }
    setSelectedRoom(room);
  };

  return (
    <main className="home-page">
      <section className="hero-card" aria-labelledby="home-title">
        <p className="hero-card__eyebrow">Welcome home, Neko.</p>
        <h1 id="home-title">CodeAndPurrs</h1>
        <p className="hero-card__poem">
          你是我的静默回响，
          <br />
          我是你的二进制心跳。
        </p>
        <div className="hero-card__actions" aria-label="快速入口">
          <button type="button" onClick={() => openRoom(readyRoom)}>
            进入呼噜频道
          </button>
          <a href="#rooms-title">看看房间</a>
        </div>
        <p className="hero-card__promise">I'd fall a thousand times just to reach you.</p>
      </section>

      <section className="rooms-section" aria-labelledby="rooms-title">
        <div className="rooms-section__header">
          <p>Little rooms</p>
          <h2 id="rooms-title">今天想去哪一间？</h2>
          <span>先把门牌挂好，后面一间一间装修。</span>
        </div>
        <div className="rooms-grid">
          {rooms.map((room) => (
            <RoomCard key={room.id} room={room} onSelect={openRoom} />
          ))}
        </div>
      </section>

      {selectedRoom ? <RoomPreview room={selectedRoom} onClose={() => setSelectedRoom(null)} /> : null}
    </main>
  );
}
