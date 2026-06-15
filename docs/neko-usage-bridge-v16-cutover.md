# Neko Usage Bridge V16｜生产上线验收清单

V16 是 Paw Trail + VPS Bridge 这条线的收口版，用于真实域名、真实 VPS、真实红米首包上传前后的最后核对。

## 1. 上线前条件

- Cloudflare 已有 `bridge.codeandpurrs.com` DNS 记录，指向 DigitalOcean 新加坡 VPS。
- nginx 已套用 `deploy/nginx-bridge.codeandpurrs.com.conf.example` 并通过 `nginx -t`。
- systemd 已套用 `deploy/usage-bridge.service.example`，并设置真实 `USAGE_BRIDGE_TOKEN`。
- `USAGE_BRIDGE_DATA_DIR` 指向 VPS 持久目录，例如 `/var/lib/codeandpurrs/usage`。
- Paw Trail 前端设置 `VITE_USAGE_BRIDGE_BASE_URL=https://bridge.codeandpurrs.com`。

## 2. VPS 本机检查

```bash
sudo systemctl status usage-bridge --no-pager
sudo journalctl -u usage-bridge -n 80 --no-pager
curl -s http://127.0.0.1:8787/api/usage/health
```

验收标准：service 处于 running，health 返回 `ok: true`，storage 处于可写状态。

## 3. 公网检查

```bash
curl -s https://bridge.codeandpurrs.com/api/usage/health
BRIDGE_BASE_URL=https://bridge.codeandpurrs.com BRIDGE_TOKEN=<真实密钥> BRIDGE_DELETE_AFTER_SMOKE=1 npm run bridge:smoke
```

验收标准：公网 health 可访问，smoke 完成 health / ping / ingest / latest / day / trend / cleanup。

## 4. 红米首包检查

1. 红米端点「测试连接」，确认 `ping ok`。
2. 红米端点「立即上传」，确认返回 `201`。
3. 打开 `https://bridge.codeandpurrs.com/api/usage/latest?owner=neko`，确认日期、时区、summary、apps、hourly 正常。
4. 打开 Paw Trail，确认总时长、Top Apps、24h timeline、7-day trend 和 Bridge Doctor 都亮起。

## 5. 回滚与清理

如果误传测试数据：

```bash
curl -X DELETE 'https://bridge.codeandpurrs.com/api/usage/day?owner=neko&date=YYYY-MM-DD' -H 'X-Bridge-Token: <真实密钥>'
```

如果需要清空 owner：

```bash
curl -X DELETE 'https://bridge.codeandpurrs.com/api/usage/owner?owner=neko' -H 'X-Bridge-Token: <真实密钥>'
```

## 6. 收口定义

满足以下条件即可停止继续堆 V 号，转入真实使用反馈：

- 公网 health 通过。
- 公网 smoke 通过。
- 红米首包上传通过。
- Paw Trail 页面可读取并展示真实数据。
- 删除命令验证通过。
- 前端没有保存、输入、暴露真实 bridge token。
