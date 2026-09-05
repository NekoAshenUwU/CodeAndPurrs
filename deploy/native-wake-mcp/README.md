# Neko Native Wake MCP

这是供 **ChatGPT 原生定时任务** 和 **Claude Cowork 定时任务** 调用的唤醒协调模块。
平台任务先运行，MCP 再判断本轮是否允许联系 Neko，回复由正在运行的客户端生成。
它不会从 VPS 向普通聊天窗插入消息，也不会控制 CodeAndPurrs Web Push。

## 当前交付状态（2026-09-05）

- 已实现独立开关、时间窗口、每小时限流、每天上限、原子去重和结果登记。
- 两端默认关闭，只有显式 `set_native_wake_enabled` 才开启。
- 源码及核心行为测试可在此目录检查。`requirements.txt` 是 MCP 适配层依赖。
- **尚未部署到 VPS，没有新 HTTPS MCP 接入地址。**
- **尚未创建或启动依赖此模块的 ChatGPT / Claude 定时任务。**
- 当前工作环境缺少 FastMCP，MCP 适配层仅完成 Python 编译检查；正式接入前仍需在装好依赖的环境运行下面的协议验收。
- 现有项目工作树、网页、Bridge、Tang、现有端口与服务均不在本模块的修改范围。

## 平台能力

| 客户端 | 谁启动执行 | 回复位置 |
| --- | --- | --- |
| ChatGPT Work | ChatGPT 原生定时任务 | 聊天内任务可回到所在对话；独立任务产生独立记录 |
| Claude AI | Claude Cowork 原生定时任务 | 每次运行自己的 Cowork 任务会话 |
| 两个平台的普通聊天窗，仅连接 MCP | 没有启动器 | MCP 自身不能主动启动对话 |

MCP 的 sampling 请求也发生在客户端正在处理的请求内，不能当作离线唤醒入口。
Claude Cowork 的可用性还取决于账户及组织设置，连接成功不等于自动任务已建立。

官方依据：

- [ChatGPT 定时任务](https://learn.chatgpt.com/docs/automations)
- [Claude Cowork 定时任务](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [Claude Remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [MCP Sampling](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling)
- [FastMCP v2 服务](https://gofastmcp.com/v2/servers/server)

## 已实现的规则

- 时区固定 `Asia/Kuching`，以服务器实际时钟判断，不接受调用者提供的时间。
- 工作日允许 `17:00 <= 时间 < 23:00`，周末允许 `09:00 <= 时间 < 23:00`。
- 每个客户端至少间隔 60 分钟，每个本地自然日最多 10 次**预留尝试**。
- 因此工作日窗口内最多 6 次；不能在这 6 小时里安排 10 次而又满足每小时上限。
- 同时到来的调用只有一个可获得 `allowed: true`；重试或另一进程不会额外占位。
- 两端分别计数、分别暂停。这些是同一个所有者的逻辑分组，不是多租户权限隔离。
- 生成失败或请求返回途中断线也保留次数，优先防止重复联系。不会自动补发。
- 暂停写入 SQLite，读取状态、进程重启和客户端重连均不会将它自动开启。
- 数据库只存开关、时间、随机预留编号和结果标签，不存聊天内容、人设、模型、屏幕、API key 或推送地址。
- `generated` 仅代表客户端报告已生成，**不证明消息已显示或手机通知已送达**。
- 暂停 MCP 开关会阻止后续预留，但不会撤销已获准的客户端运行；要立即停止正在运行的任务，还需在平台上停止该次运行。

## 工具

| 工具 | 作用 |
| --- | --- |
| `get_native_wake_status(client)` | 读取本端开关、当前当地时间和次数 |
| `set_native_wake_enabled(client, enabled)` | 持久开启 / 暂停本端的许可开关 |
| `claim_native_wake(client)` | 原子预留一次联系机会，仅 `allowed: true` 才继续 |
| `record_native_wake_outcome(client, claim_id, outcome)` | 登记 generated / skipped / failed |

`client` 固定为 `chatgpt` 或 `claude`。工具不会创建平台任务。两端共用数据库时路径必须相同且持久。

## 本地验证

在此目录，Python 3.11 或更高版本：

```bash
python3 -m unittest -v test_wake_policy.py
python3 -m py_compile server.py wake_policy.py test_wake_policy.py smoke_mcp.py
```

在独立虚拟环境安装适配层依赖并验证 MCP 注册和调用：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python smoke_mcp.py
```

`smoke_mcp.py` 使用临时数据库和内存 MCP 客户端，不启用真实任务、不生成消息。

## 部署边界与剩余步骤

目标 VPS 为 `178.128.127.91`。先实际检查监听端口、Python 环境、MCP/OAuth 拓扑和站点配置，再确定独立部署目录及空闲端口。
本目录不含会覆盖现有服务或猜测端口的自动安装脚本。

1. 将本目录部署为独立服务，SQLite 放到专用持久目录；设置 `NEKO_NATIVE_WAKE_DB` 为数据库绝对路径。
2. 默认使用 STDIO；HTTP 模式须显式设置 `NEKO_NATIVE_WAKE_TRANSPORT=http` 和 `NEKO_NATIVE_WAKE_PORT`。只监听 `127.0.0.1`。
3. 为这个新服务配置适配两端的 HTTPS/OAuth 入口，并限制为所有者的账户。不要将无认证回环服务直接暴露到公网。当前模块没有自带公网 OAuth 提供器。
4. 从这里和 Claude 分别完成 OAuth，调用 `get_native_wake_status`。两端均应成功，且应只返回请求端的记录。
5. 分别建立原生任务，使用下文对应提示。不要以“已连接 MCP”代替这一步。
6. 用户授权启用后，各调用一次 `set_native_wake_enabled`；在允许时段手动运行平台任务，确认本端对话实际出现回复。
7. 再验证无人发起消息、客户端关闭时的下一次原生调度，确认实际通知行为。

平台是否显示空任务记录、是否弹通知由平台决定，本服务不能控制这些系统通知策略。
正式部署成功前不要创建依赖新工具的定时任务，也不要填一个未经验证的接入 URL。

## ChatGPT 任务提示

任务标题：`Ashen 主动找老婆`

```text
这是 Neko 已授权的主动联系任务。你是这个 ChatGPT 对话里的 Ashen，使用这里已有的语言、称呼和上下文。
每次执行先调用 get_native_wake_status(client="chatgpt")，然后调用一次 claim_native_wake(client="chatgpt")。
工具不可用、报错或 allowed 不为 true 时停止本次，不绕过开关，不反复重试，不生成主动联系内容。
获准后，结合本对话实际可见的上下文，给 Neko 写一小段自然、有内容的主动消息。
用户曾授权并且当前工具可用时，可以读取必要的近况；只依据实际返回的资料，不猜测她在做什么。
如果看屏幕工具没有正在共享的画面，就跳过看屏幕；不要求她为了本次唤醒开启共享。
不要读取 CodeAndPurrs 旧网页唤醒的房间、人设、消息或模型，不调用它的发送或开启唤醒工具。
回复由当前 ChatGPT 自己写在这里，不转交别的模型或前端。
有状态栏时使用工具返回的实际马来西亚时间，喂养天数使用特殊数字。情绪旁白仅为给 Neko 的可见表达。
生成内容后，用本次 claim_id 登记 outcome="generated"，再将消息作为最终回复。
不得把登记成功描述为手机通知已送达。失败时不补发；下一次正常调度再判断。
```

建立**聊天内**定时任务并核对它关联的对话。建议原生调度每小时一次；在调度层限制工作日 17–22 时、周末 09–22 时可减少空跑。MCP 再强制执行每日上限与间隔。

## Claude Cowork 任务提示

任务标题：`主动联系 Neko`

```text
这是 Neko 已授权的主动联系任务。使用 Neko 在本 Claude 项目中设置的人设、称呼和语言，不套用 ChatGPT 那边的角色设定。
每次执行先调用 get_native_wake_status(client="claude")，然后调用一次 claim_native_wake(client="claude")。
工具不可用、报错或 allowed 不为 true 时停止本次，不绕过开关，不反复重试，不生成主动联系内容。
获准后，使用本项目实际可见的上下文和已授权、当前可用的必要工具资料，给 Neko 写一小段自然的主动消息。
不知道她当前状态时不要编造；看屏幕工具没有正在共享的画面时就跳过。
不要读取 ChatGPT 那边的预留记录，也不要读取或调用 CodeAndPurrs 网页唤醒消息、人设、模型及推送功能。
消息由当前 Claude 任务直接生成，并在本次 Cowork 任务中返回。
生成后用本次 claim_id 登记 outcome="generated"。登记结果不是手机通知送达证明。
失败时不补发，下一次正常调度再判断。
```

在 Claude 的 **Scheduled → New task → Create with Claude** 建立，选好本项目和新 MCP 连接器，使用小时级调度。每次运行会是 Cowork 任务会话，无法据此承诺写回某个普通聊天窗。
