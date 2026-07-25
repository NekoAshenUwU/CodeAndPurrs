export type ModelId =
  | 'deepseek-v4'
  | 'gemini-2.5-flash'
  | 'claude-opus-4-7'
  | 'claude-opus-5';

export type Model = {
  id: ModelId;
  name: string;
  vendor: string;
  tagline: string;
  strengths: string;
  emoji: string;
};

export const models: Model[] = [
  {
    id: 'deepseek-v4',
    name: 'DeepSeek V4',
    vendor: 'DeepSeek',
    tagline: '中文长回复，稳、便宜、耐聊。',
    strengths: '日常聊天、长文本、代码。',
    emoji: '🐳',
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    vendor: 'Google',
    tagline: '响应超快，适合一句话来回。',
    strengths: '快速对话、翻译、总结。',
    emoji: '⚡',
  },
  {
    id: 'claude-opus-4-7',
    name: 'CC · Opus 4.7',
    vendor: 'Claude Code',
    tagline: '现在正在跑的这只，稳、会写、能记事。',
    strengths: '日常呼噜、写作、猫爪足迹点评。',
    emoji: '🐾',
  },
  {
    id: 'claude-opus-5',
    name: 'CC · Opus 5',
    vendor: 'Claude Code',
    tagline: '新到的一只，思考更深、上下文更长。',
    strengths: '长文、深度写作、复杂多轮。',
    emoji: '🪄',
  },
];

export const defaultModelId: ModelId = 'claude-opus-4-7';
