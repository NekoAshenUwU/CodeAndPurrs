import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Room } from '../data/rooms';

type RoomCardProps = {
  room: Room;
  index: number;
  onSelect: (room: Room) => void;
};

export function RoomCard({ room, index, onSelect }: RoomCardProps) {
  const [iconOk, setIconOk] = useState(true);
  const [tapped, setTapped] = useState(false);
  const iconRef = useRef<HTMLSpanElement | null>(null);
  const iconSrc = `${import.meta.env.BASE_URL}assets/icons/${room.id}.png`;
  const isReady = room.status === 'ready';

  // 光跟着手走：高光焦点随指针在玻璃表面流动
  const trackLight = (e: PointerEvent<HTMLButtonElement>) => {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
  };

  const resetLight = () => {
    const el = iconRef.current;
    if (!el) return;
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
  };

  const classes = ['room-tile'];
  if (isReady) classes.push('is-ready');
  if (tapped) classes.push('is-tapped');

  // 每块门牌错开浮动相位，避免整齐划一的机械感
  const floatStyle = { '--float-delay': `${-((index * 0.73) % 4).toFixed(2)}s` } as CSSProperties;

  return (
    <button
      className={classes.join(' ')}
      type="button"
      style={floatStyle}
      aria-label={`${room.name} ${room.englishName} · ${isReady ? 'Ready' : 'Soon'}`}
      onPointerMove={trackLight}
      onPointerLeave={resetLight}
      onClick={() => {
        setTapped(true);
        onSelect(room);
      }}
      onAnimationEnd={() => setTapped(false)}
    >
      <span className="room-tile__icon" ref={iconRef} aria-hidden="true">
        {iconOk ? (
          <img
            className="room-tile__img"
            src={iconSrc}
            alt=""
            loading="lazy"
            onError={() => setIconOk(false)}
          />
        ) : (
          <span className="room-tile__emoji">{room.emoji}</span>
        )}
        <span className="room-tile__glow" />
        <span className={isReady ? 'room-tile__dot is-ready' : 'room-tile__dot'} />
      </span>
      <span className="room-tile__name">{room.name}</span>
      <span className="room-tile__english">{room.englishName}</span>
    </button>
  );
}
