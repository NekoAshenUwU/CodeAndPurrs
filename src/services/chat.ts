// 呼噜频道的聊天客户端 —— 只跟自家后端 /api/chat 说话，key 在服务端，前端碰不到。

export type ChatRole = 'system' | 'user' | 'assistant';

// 一条消息的内容：纯文字，或「文字 + 图片」的多模态片段（发表情包时用）。
// 图片用 OpenAI 风格的 data URL，后端再按各家格式翻译。
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = {
  role: ChatRole;
  content: string | ContentPart[];
};

// 后端实际对接的服务商（openai/anthropic 待后端接入，前端先可选）
export type Provider = 'deepseek' | 'gemini' | 'openai' | 'anthropic';

export type StreamHandlers = {
  onReasoning?: (text: string) => void;
  onContent?: (text: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
};

export type StreamOptions = {
  provider: Provider;
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
};

// 发起一次流式对话。后端用 SSE 推回 reasoning / content / error / done 四种事件。
export async function streamChat(
  { provider, messages, model, signal }: StreamOptions,
  handlers: StreamHandlers,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, messages, model }),
      signal,
    });
  } catch (err) {
    handlers.onError?.(`连不上后端，确认 npm run dev 起来了吗？（${String(err)}）`);
    return;
  }

  if (!response.ok || !response.body) {
    handlers.onError?.(`后端返回了 ${response.status}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;

        let event: { type: string; text?: string; message?: string };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'reasoning':
            if (event.text) handlers.onReasoning?.(event.text);
            break;
          case 'content':
            if (event.text) handlers.onContent?.(event.text);
            break;
          case 'error':
            handlers.onError?.(event.message ?? '未知错误');
            break;
          case 'done':
            handlers.onDone?.();
            return;
        }
      }
    }
    handlers.onDone?.();
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    handlers.onError?.(String(err));
  }
}
