# 主机端部署

一条命令把主机配好：后端、relay、以及 tailnet 上的 HTTPS。没有反向代理，没有要续期的证书，
也没有任何端口对公网开放。

```
分机 ──Tailscale──▶ <机器名>.<tailnet>.ts.net:8443
                         │  tailscaled 自己终止 TLS（证书自动签发与续期）
                         ▼  127.0.0.1:4097   relay（Bearer → Basic，多后端路由，设备级撤销）
                         ▼  127.0.0.1:4096   opencode serve
                            127.0.0.1:4098   opencode serve（另一档，可选）
```

## 为什么没有 Caddy

`tailscale serve` 自带反向代理与自动证书，能直接替掉整个反向代理层。
实测它不缓冲 SSE：受控数据源每秒一个事件，经它之后平均间隔 1.001 秒、首个事件 1.02 秒到达，
与不经代理的基线只差约 11 毫秒。少一个组件、少一份配置、少一个开机自启项，
而且 macOS 与 Windows 主机的形态因此一致。

代价要认：没有等同于 Caddy 的访问日志；协议行为由 tailscaled 决定，
无法像 Caddyfile 那样关掉 HTTP/3。如果 Safari 出现「无法建立安全连接」而服务端毫无日志，
优先怀疑这一点。

## 用法

### 装一台主机

```bash
./deploy-macos.sh \
  --managed-backend default:4096 \
  --managed-backend gpt:4098:gpt
```

`--managed-backend 名称:端口[:档位]` 会安装 launchd 任务并把后端注册成一个 target。
带上档位就会设置 `OMO_PROFILE` 与 `OPENCODE_CONFIG`，走的是和 `opencode-gpt` 命令相同的机制。
分机界面上，每个 target 表现为一台可切换的「机器」。

**两个后端共用同一个 `opencode.db`，所以两台「机器」的会话列表完全相同**，
同一个会话会在每一档下各出现一次。差别只在于这次提示词由哪个进程执行、走哪一档席位配置。
想要各自独立的会话库，用 `--backend-data-home` 给它们分开的数据目录。

### 在活着的部署旁边试新版本

影子模式不装 launchd、不碰现有配置，用另一组端口把新版本跑起来：

```bash
./deploy-macos.sh --mode shadow \
  --target default:127.0.0.1:4096 \
  --backend-env ~/.config/opencode-relay/backend.env
```

`--target` 注册一个**已经在跑**的后端而不接管它，所以影子栈和正式栈可以共用同一个后端进程——
relay 对后端而言只是又一个 HTTP 客户端。`--backend-env` 只读复用现有凭据，不复制密钥文件。

### 拆掉

```bash
./uninstall-macos.sh --dry-run          # 先看清单
./uninstall-macos.sh                    # 卸载服务，保留凭据与已配对设备
./uninstall-macos.sh --purge            # 连配置目录一起删
```

不带 `--purge` 时不会删凭据与配对状态——拆掉通常是为了重装，
而丢掉配对状态意味着每台手机和笔记本都要重新配一次。

## 脚本遵守的几条规矩

- **不写死任何路径。** Tailscale 的 CLI 在 App 包里而不在 PATH 上；`git` 可能是一个
  经 `xcode-select` 解析的壳。每个工具都探测，探测不到就报错退出，而不是在后面某处莫名失败。
- **plist 里绝不出现 `ProcessType`。** 设成 `Background` 会把任务放进受限调度带，
  实测 Node 服务在那之下要 90 秒以上才能绑上端口，表现得像卡死。
- **launchd 不读登录 shell。** 任务拿不到 PATH，也拿不到代理变量。
  服务需要的一切都写在 `service-env.sh` 里由启动脚本载入；需要走代理时在那里配，
  并且务必把 tailnet 排除在代理之外，否则会出现「分机连得上 relay，但后端连不上模型」。
- **每一步都查退出码，并用独立手段复核。** 装完之后的验证是**经 tailnet 主机名**发起的，
  不是打 `127.0.0.1`——后者会绕开 TLS 终止和代理这两跳，测了等于没测。
- **凭据只进环境变量**，不进命令行，因此不会出现在 `ps` 输出和 shell 历史里。

## 已知未覆盖

- Windows 主机（WSL）尚未实现，方案见 `research/02-Windows主机走WSL方案.md`
- 两个后端同时写一个 `opencode.db` 的锁行为尚未验证
- `tailscale serve` 的 SSE 实测是从本机打自己的 ts.net 名字做的，
  设备间那一跳尚未覆盖
