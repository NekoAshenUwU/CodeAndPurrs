// PM2 启动配置——commit 进仓库,万一 PM2 entry 被删,一句话从这里恢复:
//   cd /var/www/codeandpurrs && pm2 start ecosystem.config.cjs && pm2 save
//
// ★ 重点:必须带 --env-file-if-exists=.env,不然 proxy 读不到 CLAUDE_CODE_OAUTH_TOKEN,永远走 mock。
//
// ⚠️ 别把 script 写成 'npm' + args:'run proxy:start'——踩过坑:pm2 管的是 npm 这层外壳,
// npm 不一定把重启信号转发给它 fork 出来的 node 子进程,子进程就变孤儿,继续占着 8787 端口不放,
// 下次 pm2 重启抢不到端口就崩,如此反复直到 pm2 放弃(status:errored)。
// 必须让 pm2 直接管 node 本体(用 node_args 带 flag),没有中间层,信号才打得到真身上。

module.exports = {
  apps: [
    {
      name: 'codeandpurrs',
      script: 'server/proxy.mjs',
      node_args: '--env-file-if-exists=.env',
      cwd: '/var/www/codeandpurrs',
      autorestart: true,
      max_memory_restart: '500M',
      // 给点重启间隔避免死循环
      min_uptime: '10s',
      max_restarts: 10,
      // 日志路径(默认就在 ~/.pm2/logs/,这里显式写出来好查)
      out_file: '/root/.pm2/logs/codeandpurrs-out.log',
      error_file: '/root/.pm2/logs/codeandpurrs-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
