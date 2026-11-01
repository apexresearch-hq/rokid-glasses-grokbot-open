# prism-plugin-grokbot（可运行 v0.2）

Rokid Prism **PluginBridge v4** 插件，零依赖 Node（>=18）。眼镜 / Prism Panel → Prism Cloud → Prism Hub → **本插件（stdio）** → session-bridge HTTP → Grok Bot 例行任务 Webhook；Grok Bot 回传 `/v1/ingest` 后，插件按小说式分页推回眼镜。

线协议与官方 SDK `@rokid-prism/pluginbridge-plugin-sdk@0.1.4`（[Rokid-Prism/prism-plugin-sdk](https://github.com/Rokid-Prism/prism-plugin-sdk) `node/src/stdioServer.ts`）一致：请求 `{id,method,params}`、响应 `{id,ok,payload|error}`、事件 `{event:"plugin.event",payload:{subscription_id,event}}` / `{event:"history.stream",...}`，字段一律 snake_case，校验 `PRISM_PLUGIN_PROTOCOL_VERSION=4`。

> 已对照 SDK `wire_case.go` / `stdioServer.ts` 复核：v4 线协议锁定 snake_case（Hub 会拒绝非 snake_case 字段），SDK 里的 PascalCase 只是语言内类型名，不要改成 PascalCase。
> 会话目录：参照官方 openclaw 插件实现 `adapter.subscribePlugin`（`can_reverse_sync`/`can_plugin_wide_watch: true`），先发 `desktop.session.directory.reconciled`，再按 `GROKBOT_DIR_POLL_MS`（默认 5000）轮询，会话变化时发 `desktop.session.index.changed`（payload.session_hint + native_session）。会话 cwd 默认 `grokbot`（`GROKBOT_CWD` 可改）。

## 方法映射

| Hub 方法 | 实现 |
|---|---|
| `adapter.probe` / `discover` | 能力声明；discover 探测桥 `/health` |
| `adapter.listSessions` | `GET /v1/sessions` → NativeSessionHint[] |
| `adapter.attachSession` | `GET /v1/sessions/:id`（不存在→`not_found`） |
| `adapter.startSessionWithMessage` | `POST /v1/command`（新会话） |
| `adapter.send` | `POST /v1/command` + `session_id`（续聊） |
| `adapter.subscribe` | 轮询会话；每个新章节依次推送 `status` → `message.cover`（≤40 字）→ `message.page` ×N → `completed` |
| `adapter.waitForRun` | 阻塞到该 run 的新章节出现，返回 `completed` 事件，payload 含 `cover`、`pages[]`、`text`（封面+空行+全文） |
| `adapter.readStatus` / `readDetail` / `readHistory` / `readHistoryStream` | 会话状态、章节历史 |
| `adapter.interrupt`、草稿、审批、controlSession | `not_implemented` |

Webhook URL/Key **只在桥的环境变量里**（`GROKBOT_WEBHOOK_URL` / `GROKBOT_WEBHOOK_KEY`），插件不碰。

插件环境变量：`SESSION_BRIDGE_URL`（默认 `http://127.0.0.1:8787`）、`BRIDGE_TOKEN`、`GROKBOT_CHARS_PER_PAGE`（默认 180）、`GROKBOT_POLL_MS`（1500）、`GROKBOT_RUN_TIMEOUT_MS`（600000）。

## 测试（模拟 Hub，端到端）

```bash
# 桥先跑起来（../session-bridge: node server.js）
npm test        # = node test/mock-hub.js
```
模拟 Hub 走 stdio 驱动插件：probe → list → 开会话 → attach → subscribe → 用 `/v1/ingest` 模拟 Grok Bot 回复 → waitForRun → 续聊 → history stream → close。桥没配 Webhook 时不会触发真实 Grok Bot。

## 侧载到 Hub

把本目录拷到 Hub 的 `plugin_dirs`（或 `~/.prism/pluginbridge-plugins/grokbot`），manifest 的 `command` 已指向 `node src/plugin.js`。`src/stub-probe.js` 是旧的探测脚本，保留作排障用。

## 调试日志

`GROKBOT_DEBUG_LOG`（默认 `%USERPROFILE%\.prism\logs\grokbot-plugin.log`，其它系统 `~/.prism/logs/grokbot-plugin.log`；设为 `0` 关闭）记录每条 IN/OUT 线消息、ENV（PRISM_*/GROKBOT_*）和异常；token/authorization/sig 等字段与 Bearer 值都会脱敏。

## 配置来源

Prism Hub 启动插件时只传 `PRISM_PLUGIN_*` 环境变量，不会继承用户环境变量。插件启动时按顺序补齐缺失项：① 进程环境 → ② 插件根目录（`PRISM_PLUGIN_ROOT`，否则 `src/..`）下的 `.env`（KEY=VALUE，参考 `.env.example`）→ ③ Windows 上 `reg query HKCU\Environment`。支持 `SESSION_BRIDGE_URL`、`BRIDGE_TOKEN`/`SESSION_BRIDGE_TOKEN`、`GROKBOT_CWD`、`GROKBOT_DEBUG_LOG`。启动日志会写出每项来源（不含值）。`.env` 含令牌，不要提交或打包。

`adapter.readAgentUsage` 返回空的 AgentUsage `{}`（字段均可省略）。

## 标准事件（v0.3）

回复按官方插件的标准类型发出：发送时 `message.user` + `run.started`；回复到达时 `message.assistant`（payload.text 为全文，cover/pages/page_count 作为小说分页附加元数据）→ `message.completed` → `run.completed`（waitForRun 返回它，status=completed，id=run_id）；失败/中断为 `run.failed`（中断时 payload.interrupted=true）；中间状态为 `run.progress`。readDetail 返回 detail_snapshot（status/primary_action/current_model 等），模型名统一报 "Grok Bot"。

Windows 注册表回退使用绝对路径 `%SystemRoot%\System32\reg.exe`（Hub 启动插件时可能没有 PATH），失败再用 PowerShell `[Environment]::GetEnvironmentVariable(name, "User")`。
