# 公网接入待审方案

此方案尚未执行。当前服务仅在 VPS 本机 127.0.0.1:8894 运行，两端唤醒均关闭。

## 建议的独立入口

- 域名：`wake-mcp.nekopurrs.uk`；2026-09-06 检查时没有 DNS 记录。
- 预定 MCP 地址：`https://wake-mcp.nekopurrs.uk/mcp`，目前不可用。
- 认证：独立 GitHub OAuth App，名称 `Neko Native Wake`。
- OAuth 首页：`https://wake-mcp.nekopurrs.uk`。
- OAuth 回调：`https://wake-mcp.nekopurrs.uk/auth/callback`。
- 只放行 GitHub 所有者 `NekoAshenUwU`，请求 `read:user` 权限。

使用独立 OAuth App，保留原有 OAuth App 的回调和密钥。GitHub 用户名应在配置前再与所有者确认。

## 用户确认后的具体变更

1. 新增该域名的 DNS 记录，指向 `178.128.127.91`。
2. 创建专用 OAuth App，将凭据直接存入 VPS 专用的 `/etc/neko-native-wake.env`（权限 0600），不放入聊天、源码或日志。生成独立随机签名密钥。
3. 只重启 `neko-native-wake.service`，在本机确认 `/healthz` 的 `auth_mode` 为 `github`，缺失或无效凭据访问 `/mcp` 返回 401，OAuth 元数据正确。
4. 新增专用 nginx 站点 `/etc/nginx/sites-available/neko-native-wake`。先开 ACME 验证路径，签发该域名自己的证书，再启用 `nginx-public.conf.draft` 中的 HTTPS 代理。
5. 每次改 nginx 前备份当前配置，执行 `nginx -t` 成功后才平滑 reload。不 restart nginx，不改旧站点内容。
6. 从公网再次核对 HTTPS、OAuth 元数据和未授权 401，再让 ChatGPT 与 Claude 分别连接并实际调用状态工具。
7. 客户端原生任务建立并验收后，才启用对应唤醒开关。

## 保护与回退

- 不写入四个既有项目目录；不修改或重启 8890、8891、8892、8893 对应的服务。
- nginx reload 是共享网关操作，因此必须取得用户确认；即使只是新增站点，也先做配置备份和验证。
- 回退只停止新服务、移除新增站点的启用链接并验证后 reload；保留新模块数据库和备份。
- 不直接打开 VPS 的 8894 公网端口，不把 private 模式的服务暴露出去。
- 不改现有 GitHub OAuth App，不把旧服务密钥复制到新模块。
- `nginx-public.conf.draft` 是未启用草案。DNS、证书、真实 OAuth 登录与平台调度均未验收。

## 本机验收记录

2026-09-06 Asia/Kuching：FastMCP 2.14.7；10 项策略测试、4 项认证测试通过。
已通过 MCP 内存调用和运行中 HTTP 工具调用；ChatGPT/Claude 均为 enabled=false、claims_today=0。
GitHub 认证测试使用假凭据与本机 ASGI，不代表真实客户端已经完成 GitHub 登录。
已核对受保护入口文件、服务文件、所有现有 nginx 站点的校验值未变，四个主进程号未变。
