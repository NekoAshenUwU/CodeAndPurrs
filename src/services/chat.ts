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

// 后端实际对接的服务商
export type Provider = 'deepseek' | 'gemini' | 'openai' | 'anthropic' | 'claudecode' | 'codexcli';

export type StreamHandlers = {
  onReasoning?: (text: string) => void;
  onContent?: (text: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
};

// 贴纸盒预览:每张贴纸的名字 + 缩略图(384px JPEG dataUrl),让 CC 家版真"看到"
// 每个名字对应哪张图,以后发 [贴纸:名字] 时不再靠猜。只对能看图的 provider
// (claudecode/openai/anthropic) 发送,其它 provider 忽略,不浪费上下文。
export type StickerGalleryEntry = { name: string; dataUrl: string };

// 思考预算档位:后端把 low→512/medium→1024/high→2048 塞成 MAX_THINKING_TOKENS,
// 只对 claudecode/anthropic 生效,别家忽略。咕噜圆桌走 'low' 省 token。
export type ThinkingBudget = 'low' | 'medium' | 'high';

export type StreamOptions = {
  provider: Provider;
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
  stickerGallery?: StickerGalleryEntry[];
  thinking?: ThinkingBudget;
  conversationId?: string;
};

// 发起一次流式对话。后端用 SSE 推回 reasoning / content / error / done 四种事件。
export async function streamChat(
  { provider, messages, model, signal, stickerGallery, thinking, conversationId }: StreamOptions,
  handlers: StreamHandlers,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        messages,
        model,
        stickerGallery,
        thinking,
        conversationId,
      }),
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
  let settled = false;
  let receivedContent = false;

  // error / done 都是终态。服务端为了把 SSE 正常收尾，可能在 error 后继续发 done；
  // done 不能把刚刚的错误覆盖成一条“已完成但正文为空”的假消息。
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    handlers.onError?.(message);
  };
  const finish = () => {
    if (settled) return;
    if (!receivedContent) {
      fail('模型没有返回正文，请展开详情查看服务端状态');
      return;
    }
    settled = true;
    handlers.onDone?.();
  };

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

        // 已经收到终态后继续把连接读完，但不再触发第二个终态回调。
        if (settled) continue;

        switch (event.type) {
          case 'reasoning':
            if (event.text) handlers.onReasoning?.(event.text);
            break;
          case 'content':
            if (event.text) {
              receivedContent = true;
              handlers.onContent?.(event.text);
            }
            break;
          case 'error':
            fail(event.message ?? '未知错误');
            break;
          case 'done':
            finish();
            return;
        }
      }
    }
    finish();
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    fail(String(err));
  }
}
