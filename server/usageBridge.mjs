// Neko Usage Bridge 启动器（独立进程，别和聊天后端 proxy.mjs 混用）。
// 启动：node --env-file-if-exists=.env server/usageBridge.mjs
import { createUsageBridgeServer } from './usageBridgeServer.mjs';

const port = Number(process.env.BRIDGE_PORT ?? process.env.PORT ?? 8788);
const host = process.env.HOST ?? '127.0.0.1';

const server = createUsageBridgeServer();

server.listen(port, host, () => {
  console.log(`Neko Usage Bridge listening on http://${host}:${port}`);
});
