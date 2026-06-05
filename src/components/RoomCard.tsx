import type { Room } from '../data/rooms';

type RoomCardProps = {
  room: Room;
  onSelect: (room: Room) => void;
};

export function RoomCard({ room, onSelect }: RoomCardProps) {
  return (
    <button
      className="room-card"
      type="button"
      aria-label={`${room.name} ${room.englishName}`}
      onClick={() => onSelect(room)}
    >
      <span className="room-card__icon" aria-hidden="true">
        {room.emoji}
      </span>
      <span className="room-card__copy">
        <span className="room-card__name">{room.name}</span>
        <span className="room-card__english">{room.englishName}</span>
      </span>
      <span className="room-card__summary">{room.summary}</span>
      <span className={room.status === 'ready' ? 'room-card__status ready' : 'room-card__status'}>
        {room.status === 'ready' ? 'Ready' : 'Soon'} · {room.actionLabel}
      </span>
    </button>
  );
}
