export type ModelId = 'deepseek-v4' | 'gemini-2.5-flash' | 'claude-opus-5';

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
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    vendor: 'Anthropic',
    tagline: 'CC Opus 5，最会写长情书那一个。',
    strengths: '深度写作、思考、代码 review。',
    emoji: '🪄',
  },
];

export const defaultModelId: ModelId = 'claude-opus-5';
