// 呼噜频道的模型花名册：调频页和聊天页共用。
// id 既是选中标识、也是存进窗口/默认的值（老值 'deepseek'/'gemini' 仍有效，无需迁移）。
// brand 用来在调频页分组；provider/model 决定后端怎么调（openai/anthropic 待后端接入）。

import type { Provider } from '../services/chat';

export type ModelBrand = 'DeepSeek' | 'Gemini' | 'GPT' | 'Claude';

export type ModelInfo = {
  id: string;
  brand: ModelBrand;
  label: string; // 展示名（顺风顺水字体）
  provider: Provider;
  model?: string; // 传给后端的具体模型名
};

export const MODELS: ModelInfo[] = [
  { id: 'deepseek', brand: 'DeepSeek', label: 'DeepSeek', provider: 'deepseek' },
  { id: 'gemini', brand: 'Gemini', label: 'Gemini', provider: 'gemini' },
  // chatgpt-4o-latest = ChatGPT 里那个"温暖版"4o，比 API 默认的 gpt-4o 像活人得多，看图也行
  { id: 'chatgpt-4o-latest', brand: 'GPT', label: 'GPT-4o 最新版', provider: 'openai', model: 'chatgpt-4o-latest' },
  { id: 'gpt-4o', brand: 'GPT', label: 'GPT-4o', provider: 'openai', model: 'gpt-4o' },
  { id: 'o3', brand: 'GPT', label: 'o3（推理）', provider: 'openai', model: 'o3' },
  { id: 'claude-sonnet-4-6', brand: 'Claude', label: 'Sonnet 4.6', provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { id: 'claude-opus-4-6', brand: 'Claude', label: 'Opus 4.6', provider: 'anthropic', model: 'claude-opus-4-6' },
  { id: 'claude-opus-4-8', brand: 'Claude', label: 'Opus 4.8', provider: 'anthropic', model: 'claude-opus-4-8' },
];

export const BRAND_ORDER: ModelBrand[] = ['DeepSeek', 'Gemini', 'GPT', 'Claude'];

export const MODEL_GROUPS: { brand: ModelBrand; models: ModelInfo[] }[] = BRAND_ORDER.map((brand) => ({
  brand,
  models: MODELS.filter((m) => m.brand === brand),
}));

export const getModel = (id: string): ModelInfo => MODELS.find((m) => m.id === id) ?? MODELS[0];
