// PM2 启动配置——commit 进仓库,万一 PM2 entry 被删,一句话从这里恢复:
//   cd /var/www/codeandpurrs && pm2 start ecosystem.config.cjs && pm2 save
//
// ★ 重点:script 必须走 npm run proxy:start (package.json 里那条带 --env-file-if-exists)
// 直接 pm2 start node ... 会跳过 .env,proxy 读不到 CLAUDE_CODE_OAUTH_TOKEN,永远走 mock。

module.exports = {
  apps: [
    {
      name: 'codeandpurrs',
      script: 'npm',
      args: 'run proxy:start',
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
