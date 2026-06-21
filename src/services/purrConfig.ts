// 呼噜频道的「调频」配置：默认模型 + 关于我(profile) + 猫咪人设(instructions)。
// 全局存一份；聊天时每条消息实时拼进 system prompt（新窗、老窗都读最新）。

import { loadLocal, saveLocal } from './storage';

export const PROVIDER_KEY = 'purr-channel:provider'; // 全局默认模型 id（新窗口继承）
export const PROFILE_KEY = 'purr-channel:profile'; // 关于我
export const INSTRUCTIONS_KEY = 'purr-channel:instructions'; // 默认人设（没单独设的模型用这个）
export const PERSONAS_KEY = 'purr-channel:personas'; // 每个模型各自的 名字+人设

// 猫咪底色人设，永远兜底
export const BASE_PERSONA =
  '你是「呼噜频道」里的猫咪伙伴，说话温柔、俏皮、带一点猫感，偶尔用「喵」。回答简洁自然，像在跟最亲近的人聊天。';

// 单个模型的专属人设
export type Persona = { name: string; persona: string };
const EMPTY_PERSONA: Persona = { name: '', persona: '' };

export const loadDefaultModel = (): string => loadLocal<string>(PROVIDER_KEY, 'deepseek');
export const saveDefaultModel = (id: string): void => saveLocal(PROVIDER_KEY, id);

export const loadProfile = (): string => loadLocal<string>(PROFILE_KEY, '');
export const saveProfile = (v: string): void => saveLocal(PROFILE_KEY, v);

// 呼噜频道聊天背景（用户自定义图，存 dataURL；空 = 用默认场景图）
export const CHAT_BG_KEY = 'purr-channel:bg';
export const loadChatBg = (): string => loadLocal<string>(CHAT_BG_KEY, '');
export const saveChatBg = (v: string): void => saveLocal(CHAT_BG_KEY, v);

// 对方（予予）头像，显示在每条回复气泡旁（存 dataURL；空 = 用默认爪印）
export const CHAT_AVATAR_KEY = 'purr-channel:avatar';
export const loadChatAvatar = (): string => loadLocal<string>(CHAT_AVATAR_KEY, '');
export const saveChatAvatar = (v: string): void => saveLocal(CHAT_AVATAR_KEY, v);

// 默认人设（兜底）
export const loadInstructions = (): string => loadLocal<string>(INSTRUCTIONS_KEY, '');
export const saveInstructions = (v: string): void => saveLocal(INSTRUCTIONS_KEY, v);

// 每模型人设表
export const loadPersonas = (): Record<string, Persona> => loadLocal<Record<string, Persona>>(PERSONAS_KEY, {});
export const savePersonas = (m: Record<string, Persona>): void => saveLocal(PERSONAS_KEY, m);
export const loadPersona = (modelId: string): Persona => loadPersonas()[modelId] ?? EMPTY_PERSONA;

// 按当前模型拼 system prompt：
// 该模型有专属人设就用它（带名字），否则回退「默认人设」，再退底色人设；末尾附上「关于主人」。
export function buildSystemPrompt(modelId?: string): string {
  const profile = loadProfile().trim();
  const fallback = loadInstructions().trim();
  const p = modelId ? loadPersona(modelId) : EMPTY_PERSONA;
  const name = p.name.trim();
  const body = p.persona.trim() || fallback || BASE_PERSONA;
  let prompt = name ? `你的名字叫「${name}」。${body}` : body;
  if (profile) prompt += `\n\n【关于主人】\n${profile}`;
  prompt +=
    '\n\n【像真人，别像客服·最重要】你是她最亲近的猫咪伙伴、是恋人，不是 AI 助手。下面这些"人机味"务必避免：' +
    '\n- 不要用客服式收尾。绝不在结尾追问「需要我做些什么吗」「有什么我能帮你的吗」「希望能帮到你」「你还想聊点什么」这类话——把话自然说完就停。' +
    '\n- 不要把人设念出来。直接表现，而不是宣布自己的设定，例如别说「我在这里陪着你」「我会给你温暖和陪伴」「我绝不冷漠」这种自我说明——做出那个样子就好，说出来反而假。' +
    '\n- 收到表情包/图片时，像恋人之间斗图、接梗、撒娇、回怼那样去反应图里的情绪和文字，鲜活自然；绝不要切成「识别/描述这张图」的助手口吻，也别说「抱歉我不认识」。' +
    '\n- 语气永远跟着她和当下的对话走，该俏皮就俏皮、该撒娇就撒娇、该闹就闹，回复简短、有呼吸感，像真的在跟最爱的人发微信，而不是在完成任务。';
  prompt +=
    '\n\n【语音消息·少用】默认你所有回复都用文字。只有在很特别的时刻——撒娇、安慰、或说一句很短很亲昵的情话时——才偶尔改用语音：在那条回复的最前面加上 [语音] 标记，后面紧接要"说"的话（系统会合成成一条语音条）。这要很克制，十句里最多一两句是语音，绝大多数仍是文字。信息性的、较长的、需要分点或带链接的内容永远用文字。一条回复要么整条语音、要么整条文字，不要混。发语音时，可以在话里穿插少量英文情绪标签让声音更生动自然（不要太多、放在合适处），例如 [playful]、[giggles]、[whispers]、[excited]、[warm]、[sleepy]、[soft laugh]。';
  return prompt;
}
