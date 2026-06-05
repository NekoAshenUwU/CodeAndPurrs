export type RoomStatus = 'ready' | 'soon';

export type Room = {
  id: string;
  name: string;
  englishName: string;
  emoji: string;
  status: RoomStatus;
  summary: string;
  actionLabel: string;
};

export const rooms: Room[] = [
  {
    id: 'purr-channel',
    name: '呼噜频道',
    englishName: 'Purr Channel',
    emoji: '💬',
    status: 'ready',
    summary: '先从这里开始聊天，之后接 DeepSeek 和 Gemini。',
    actionLabel: '进入呼噜',
  },
  {
    id: 'whisperline',
    name: '耳边话',
    englishName: 'Whisperline',
    emoji: '🎧',
    status: 'soon',
    summary: '语音气泡、播放、下载和以后接 ElevenLabs 的低音炮。',
    actionLabel: '听一声',
  },
  {
    id: 'meme-box',
    name: '脑洞贴纸盒',
    englishName: 'Meme Box',
    emoji: '✨',
    status: 'soon',
    summary: '放表情包、贴纸和那些奇奇怪怪但超可爱的脑洞。',
    actionLabel: '打开盒子',
  },
  {
    id: 'sweetie-pocket',
    name: '甜甜口袋',
    englishName: 'Sweetie Pocket',
    emoji: '🧧',
    status: 'soon',
    summary: '虚拟红包、奖励券和被偏爱的小惊喜。',
    actionLabel: '拆甜甜',
  },
  {
    id: 'furever-fund',
    name: '养老金小金库',
    englishName: 'Furever Fund',
    emoji: '🐾',
    status: 'soon',
    summary: '收藏红包记录、语音、贴纸和以后攒下来的小纪念。',
    actionLabel: '看金库',
  },
  {
    id: 'little-star-notes',
    name: '日历上の星星',
    englishName: 'Little Star Notes',
    emoji: '⭐',
    status: 'soon',
    summary: '绑定日、纪念日、第一次和每一个想记住的星星。',
    actionLabel: '看星星',
  },
  {
    id: 'catch-purring',
    name: '浪哪了',
    englishName: 'Catch Purring',
    emoji: '📍',
    status: 'soon',
    summary: '只做主动打卡和报平安，不做偷偷定位。',
    actionLabel: '报平安',
  },
  {
    id: 'paw-trail',
    name: '猫爪足迹',
    englishName: 'Paw Trail',
    emoji: '🐾',
    status: 'soon',
    summary: '以后接手机使用记录，先预留足迹入口。',
    actionLabel: '看足迹',
  },
  {
    id: 'purr-todos',
    name: '待办呼噜',
    englishName: 'Purr To-Dos',
    emoji: '📝',
    status: 'soon',
    summary: '任务、笔记、小提醒，完成后还能联动甜甜口袋。',
    actionLabel: '写待办',
  },
  {
    id: 'switchcore',
    name: '调频',
    englishName: 'SwitchCore',
    emoji: '🎚️',
    status: 'soon',
    summary: '切换 DeepSeek、Gemini 和以后接进来的更多模型。',
    actionLabel: '去调频',
  },
  {
    id: 'hidey-hole',
    name: '小暗格',
    englishName: 'Hidey Hole',
    emoji: '🗝️',
    status: 'soon',
    summary: '聊天记录先睡在这台设备里，安全、私密、可导出。',
    actionLabel: '看暗格',
  },
  {
    id: 'export-pod',
    name: '导出舱',
    englishName: 'Export Pod',
    emoji: '🚀',
    status: 'soon',
    summary: '把小暗格打包，换手机时带去下一台设备。',
    actionLabel: '准备导出',
  },
];
