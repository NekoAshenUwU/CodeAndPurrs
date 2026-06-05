import type { Room } from '../data/rooms';

type RoomPreviewProps = {
  room: Room;
  onClose: () => void;
};

export function RoomPreview({ room, onClose }: RoomPreviewProps) {
  const isReady = room.status === 'ready';

  return (
    <section className="room-preview" aria-live="polite" aria-labelledby="room-preview-title">
      <button className="room-preview__close" type="button" onClick={onClose} aria-label="关闭房间预览">
        ×
      </button>
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
