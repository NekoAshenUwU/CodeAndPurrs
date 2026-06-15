import { createUsageBridgeServer } from './usageBridgeServer.mjs';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const server = createUsageBridgeServer();

server.listen(port, host, () => {
  console.log(`Neko Usage Bridge listening on http://${host}:${port}`);
});
