import { useState, type CSSProperties } from 'react';
import type { Room } from '../data/rooms';

type RoomCardProps = {
  room: Room;
  index: number;
  onSelect: (room: Room) => void;
};

export function RoomCard({ room, index, onSelect }: RoomCardProps) {
  const [iconOk, setIconOk] = useState(true);
  const [tapped, setTapped] = useState(false);
  const iconSrc = `${import.meta.env.BASE_URL}assets/icons/${room.id}.png`;
  const isReady = room.status === 'ready';

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
      onClick={() => {
        setTapped(true);
        onSelect(room);
      }}
      onAnimationEnd={() => setTapped(false)}
    >
      <span className="room-tile__icon" aria-hidden="true">
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
        <span className={isReady ? 'room-tile__dot is-ready' : 'room-tile__dot'} />
      </span>
      <span className="room-tile__name">{room.name}</span>
      <span className="room-tile__english">{room.englishName}</span>
    </button>
  );
}
