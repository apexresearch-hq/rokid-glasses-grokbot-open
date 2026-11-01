# gateway-relay

本机中转：从 远端 session-bridge **认领**任务 → 用 Grok Bot **内部网关** `sendPrompt` 打进目标 bot 聊天 → 轮询 transcript → 把回复 POST 回桥的 `/v1/ingest`（或任务里的 signed `reply_url`）。

同时做 **电脑→眼镜**：定期拉已绑定 bot 的 transcript，把非眼镜回合产生的 bot 新回复以「电脑续聊」ingest 到同一 glasses session。

## 为什么必须在本机跑

Grok Bot 网关只监听本机 `127.0.0.1:1340`（`gateway.json` 里可能写 `0.0.0.0`，客户端仍只用 loopback）。远端 session-bridge **够不到** 这台 box 的 1340，所以由本机 **出站** 长轮询桥，绝不把 1340 暴露公网。

## 启动

```bash
# 密钥：~/.secrets/leqi-bridge-token 与 leqi-bridge-url（已存在则无需再设）
# 或 export BRIDGE_TOKEN=… SESSION_BRIDGE_URL=https://glasses.example.com

cd gateway-relay
./scripts/start.sh          # 后台，日志 ~/.prism/leqi-gateway-relay.log
./scripts/restart.sh
./scripts/stop.sh

# 或前台
BRIDGE_TOKEN=… SESSION_BRIDGE_URL=https://glasses.example.com node relay.js

# systemd --user（可选）
mkdir -p ~/.config/systemd/user
cp leqi-gateway-relay.service ~/.config/systemd/user/
# 把 WorkingDirectory 改成你的实际路径，或 symlink
systemctl --user daemon-reload
systemctl --user enable --now leqi-gateway-relay
```

## 冒烟 / 单测

```bash
node smoke.js    # 网关 listAgents + transcript；有 token 时查桥 /health
npm test         # 本地单元测试（不碰秘密）
```

## 环境变量

| 变量 | 含义 | 默认 |
|------|------|------|
| `SESSION_BRIDGE_URL` | 公网桥 | `~/.secrets/leqi-bridge-url` 或 glasses.example.com |
| `BRIDGE_TOKEN` | 桥 Bearer | `~/.secrets/leqi-bridge-token` |
| `GROK_GATEWAY_FILE` | 网关配置 | `~/agent-data/gateway.json` |
| `DEFAULT_BOT_ID` | 无 target 时 | **必填**（代码默认空） |
| `REPLY_TIMEOUT_MS` | 等回复超时 | 12 min |
| `CLAIM_WAIT_MS` | 长轮询 | 20s |
| `SYNC_INTERVAL_MS` | 电脑→眼镜扫描 | 5s |

## 安全

- 网关 token / BRIDGE_TOKEN / reply_url **永不**写入日志明文或 git。
- 只连 `127.0.0.1:1340`；不要做端口映射或 Cloudflare 到 1340。
- 内部网关无官方未公开，升级可能失效；用户已接受该风险。

## 与 webhook 的关系

session-bridge 默认 `DELIVERY_MODE=gateway`。工人超过 `GATEWAY_FALLBACK_MS`（默认 60s）未认领时，桥会 fallback 到旧 webhook。webhook 代码路径保留。
