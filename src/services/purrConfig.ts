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
    '\n\n【语音消息】你可以像在微信里发语音那样，用"语音"代替文字。当你想撒娇、安慰、说很短或很亲昵情绪化的话时，就在这条回复的最前面加上 [语音] 这个标记，后面紧接你要"说"的内容；系统会把它合成成一条语音条发出去。信息性、较长、需要分点或带链接的内容请用普通文字，不要加标记。一条回复要么整条语音、要么整条文字，不要混用；也别每条都用语音，自然一点，偶尔用。';
  return prompt;
}
