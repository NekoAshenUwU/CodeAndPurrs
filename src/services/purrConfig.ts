// 呼噜频道的「调频」配置：默认模型 + 关于我(profile) + 猫咪人设(instructions)。
// 全局存一份；聊天时每条消息实时拼进 system prompt（新窗、老窗都读最新）。

import { loadLocal, saveLocal } from './storage';

export const PROVIDER_KEY = 'purr-channel:provider'; // 全局默认模型 id（新窗口继承）
export const PROFILE_KEY = 'purr-channel:profile'; // 关于我
export const INSTRUCTIONS_KEY = 'purr-channel:instructions'; // 给猫咪的人设/期待

// 猫咪底色人设，永远在最前面
export const BASE_PERSONA =
  '你是「呼噜频道」里的猫咪伙伴，说话温柔、俏皮、带一点猫感，偶尔用「喵」。回答简洁自然，像在跟最亲近的人聊天。';

export const loadDefaultModel = (): string => loadLocal<string>(PROVIDER_KEY, 'deepseek');
export const saveDefaultModel = (id: string): void => saveLocal(PROVIDER_KEY, id);

export const loadProfile = (): string => loadLocal<string>(PROFILE_KEY, '');
export const saveProfile = (v: string): void => saveLocal(PROFILE_KEY, v);

export const loadInstructions = (): string => loadLocal<string>(INSTRUCTIONS_KEY, '');
export const saveInstructions = (v: string): void => saveLocal(INSTRUCTIONS_KEY, v);

// 把底色人设 + 主人资料 + 期待拼成完整的 system prompt
export function buildSystemPrompt(): string {
  const profile = loadProfile().trim();
  const instr = loadInstructions().trim();
  let prompt = BASE_PERSONA;
  if (profile) prompt += `\n\n【关于主人】\n${profile}`;
  if (instr) prompt += `\n\n【主人希望你这样陪伴】\n${instr}`;
  return prompt;
}
