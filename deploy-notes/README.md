# 部署说明（本地私有副本）

本目录是 `BB-84C/opencode-mobile-solution` 的私有副本，记录一次在 macOS +
Tailscale 上的完整落地过程，供组织内后续克隆脚本引用。

## 与上游的差异

| 文件 | 差异 | 是否已提给上游 |
|---|---|---|
| `relay/lib/proxy.mjs` | 客户端 SSE 中断时释放上游连接 | 是，见 `PR草稿.md` |
| `relay/lib/pairing-store.mjs` | 配对设备授权范围取交集而非替换 | 是，同上 |
| `relay/test/helpers/fake-upstream.mjs` | 修正失效的连接计数器 | 是，同上 |
| `relay/test/stream-teardown.test.mjs` | 新增回归测试 | 是，同上 |
| `app/app.json` | 改为自己的 bundle identifier | 否，个人配置 |
| `app/package.json` | `expo prebuild` 自动更新脚本 | 否，工具生成 |

上游 PR 分支：`fix/relay-stream-teardown`，只含 relay 的 4 个文件。

## 这套部署的形态

不使用上游默认的 VPS + FRP 方案，改为 relay 直接跑在工作站本机，
用 Tailscale 承载传输：

```
iPhone ──WireGuard──▶ <机器名>.<tailnet>.ts.net:8443
                           │ Caddy（证书由本机 tailscaled 提供，自动续期）
                           ▼
                     127.0.0.1:4097  relay
                           ▼
                     127.0.0.1:4096  opencode serve
```

零公网暴露、零年费。详见 `部署方案.md` 的方案 B 部分。

## 本机辅助命令（不在本仓库内，位于 ~/.local/bin）

- `opencode-shared` 挂载到与手机共用的后端
- `opencode-mobile-reinstall` 免费签名到期后一键重装
- `opencode-mobile-expiry-check` 每日检查签名剩余天数（launchd 自动调用）

## 注意

本仓库不含任何凭据。`tokens.json`、`passkeys.json`、`env`、`frpc.toml`
均由上游 `.gitignore` 覆盖，实际凭据位于本机 `~/.config/opencode-relay/`。
