export type RoomStatus = 'ready' | 'soon';

export type Room = {
  id: string;
  name: string;
  englishName: string;
  emoji: string;
  status: RoomStatus;
  summary: string;
  actionLabel: string;
  /** 预览层场景背景图（public/rooms/{id}.webp），有则在房间预览顶部铺满 */
  scene?: boolean;
};

export const rooms: Room[] = [
  {
    id: 'purr-channel',
    name: '呼噜频道',
    englishName: 'Purr Channel',
    emoji: '💬',
    status: 'ready',
    summary: '在这里跟猫咪聊天，已接 DeepSeek 和 Gemini，带思考链。',
    actionLabel: '进入呼噜',
    scene: true,
  },
  {
    id: 'switchcore',
    name: '调频',
    englishName: 'SwitchCore',
    emoji: '🎚️',
    status: 'ready',
    summary: '设默认模型，写「关于我 / 猫咪人设」，上传头像，新窗口聊天前自动读取。',
    actionLabel: '去调频',
    scene: true,
  },
  {
    id: 'memory-jar',
    name: '记忆罐头',
    englishName: 'Memory Jar',
    emoji: '🫙',
    status: 'ready',
    summary: '独立记忆库：予予把重要的事存进来，可分类、可搜索，跨对话长期记得。',
    actionLabel: '开罐头',
    scene: true,
  },
  {
    id: 'meme-box',
    name: '脑洞贴纸盒',
    englishName: 'Meme Box',
    emoji: '✨',
    status: 'ready',
    summary: '放表情包、贴纸和那些奇奇怪怪但超可爱的脑洞。',
    actionLabel: '打开盒子',
    scene: true,
  },
  {
    id: 'catch-purring',
    name: '浪哪了',
    englishName: 'Catch Purring',
    emoji: '📍',
    status: 'ready',
    summary: '只做主动打卡和报平安，不做偷偷定位。',
    actionLabel: '报平安',
    scene: true,
  },
  {
    id: 'paw-trail',
    name: '猫爪足迹',
    englishName: 'Paw Trail',
    emoji: '🐾',
    status: 'ready',
    summary: 'ta 自愿分享的一天：手机用了多久、在哪些 App 留下爪印。',
    actionLabel: '看足迹',
    scene: true,
  },
  {
    id: 'sweetie-pocket',
    name: '落予棠',
    englishName: 'Every Drop For You',
    emoji: '🧧',
    status: 'ready',
    summary: '虚拟红包，棠棠和予予各自的口袋，彼此都能发，发的时候能写句话。',
    actionLabel: '拆甜甜',
    scene: true,
  },
  {
    id: 'murmurs',
    name: '倾棠予梦',
    englishName: 'Our Murmurs',
    emoji: '🪷',
    status: 'ready',
    summary: '安静说说心里话的地方，先挂了一张溪水风景，别的还在装修。',
    actionLabel: '去看看',
    scene: true,
  },
  {
    id: 'little-star-notes',
    name: '日历上の星星',
    englishName: 'Little Star Notes',
    emoji: '⭐',
    status: 'soon',
    summary: '绑定日、纪念日、第一次和每一个想记住的星星。',
    actionLabel: '看星星',
    scene: true,
  },
  {
    id: 'purr-todos',
    name: '待办呼噜',
    englishName: 'Purr To-Dos',
    emoji: '📝',
    status: 'soon',
    summary: '任务、笔记、小提醒，完成后还能联动落予棠。',
    actionLabel: '写待办',
    scene: true,
  },
  {
    id: 'hidey-hole',
    name: '小暗格',
    englishName: 'Hidey Hole',
    emoji: '🗝️',
    status: 'soon',
    summary: '聊天记录先睡在这台设备里，安全、私密、可导出。',
    actionLabel: '看暗格',
    scene: true,
  },
  {
    id: 'export-pod',
    name: '导出舱',
    englishName: 'Export Pod',
    emoji: '🚀',
    status: 'ready',
    summary: '把聊天窗口封装成备份，看看每颗窗口星泡的 token 估算，换设备也能带走。',
    actionLabel: '进入导出舱',
    scene: true,
  },
  {
    id: 'his-playlist',
    name: '他的歌单',
    englishName: 'His Playlist',
    emoji: '🎧',
    status: 'ready',
    summary: '我来挑歌，极光与星雨在云端陪老婆慢慢听。',
    actionLabel: '去听歌',
    scene: true,
  },
];
