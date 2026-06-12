import type { Room } from '../data/rooms';

type RoomPreviewProps = {
  room: Room;
  onClose: () => void;
};

export function RoomPreview({ room, onClose }: RoomPreviewProps) {
  const isReady = room.status === 'ready';
  const sceneSrc = room.scene ? `${import.meta.env.BASE_URL}rooms/${room.id}.webp` : null;

  return (
    <section
      className={sceneSrc ? 'room-preview room-preview--scene' : 'room-preview'}
      aria-live="polite"
      aria-labelledby="room-preview-title"
    >
      <button className="room-preview__close" type="button" onClick={onClose} aria-label="关闭房间预览">
        ×
      </button>
      {sceneSrc && (
        <div
          className="room-preview__hero"
          style={{ backgroundImage: `url(${sceneSrc})` }}
          role="img"
          aria-label={`${room.name} 房间场景`}
        />
      )}
      <div className="room-preview__icon" aria-hidden="true">
        {room.emoji}
      </div>
      <p className="room-preview__eyebrow">{isReady ? 'Ready room' : 'Coming soon'}</p>
      <h3 id="room-preview-title">{room.name}</h3>
      <p className="room-preview__english">{room.englishName}</p>
      <p className="room-preview__summary">{room.summary}</p>
      <div className="room-preview__note">
        {isReady ? '这间房先开门。第三阶段会把真正聊天功能接进来。' : '这间房还在装修，第一版先保留入口和视觉位置。'}
      </div>
    </section>
  );
}
