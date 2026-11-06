# OpenCode Remote

**[English](#english) · [简体中文](#简体中文)** — click a language below to expand or collapse it. 点击下方语言标题即可展开或收起。

<a id="english"></a>
<details open>
<summary><b>English</b></summary>

Reach the [OpenCode](https://github.com/anomalyco/opencode) sessions on your own
machines from a phone or another computer. This is a starting kit, not a hosted
service: you run every part yourself and hold every credential.

### What is in the repository

| Part | What it is | Version |
|------|------------|---------|
| **`app/`** — OpenCode Mobile | The Expo / React Native client. It builds the iPhone app, and the same code is exported as the web bundle the desktop client loads. | 2.0.0 |
| **`desktop/`** — OpenCode Cockpit | An Electron shell around that bundle for macOS and Windows: the TUI's keybindings, tray residency, start at login, system notifications. | 2.0.0 |
| **`relay/`** | A small Node service bound to loopback. It turns each device's bearer token into the backend's Basic auth, routes between several backends, enforces per-device directory scope, and hosts a passkey-protected dashboard for pairing phones and authorizing machines. | — |
| **`clients/`** | VPS route: local launchers for Windows and macOS that attach `opencode` on a workstation to the shared, relay-connected backend. Also notes for client machines that run a third-party VPN beside Tailscale. | — |
| **`host/`** | Tailnet route: one-command deployment of backends and relay on an always-on Mac, plus `renew-ios-app.sh` for re-signing the iPhone app. | — |

Nothing here hard-codes a server or an identity. The app has no built-in relay
address, the relay and launcher hostnames default to `opencode.example.com`, and
the iPhone bundle identifier is `com.example.opencodemobile` until you set yours.

### Choose a deployment route

The relay code is the same for both routes. Pick one; the clients work with
either.

| | **VPS route** | **Tailnet route** |
|---|---|---|
| Relay runs on | a VPS or other always-on host, behind Caddy or nginx | the machine that runs the backends |
| Backends reach the relay | through an SSH reverse tunnel or FRP | over loopback |
| Clients reach the relay | over a public HTTPS domain | over a [Tailscale](https://tailscale.com) network |
| Machines are added by | OAuth device-authorization enrollment from the dashboard | static targets written by the deploy script |
| You need | a VPS, a domain, a TLS proxy | Tailscale on every device |
| Start with | [`relay/README.md`](relay/README.md), [`relay/deploy/`](relay/deploy), [`clients/`](clients) | [`host/README.md`](host/README.md) |

**VPS route**

```
 iOS / Android          VPS / always-on host          Your workstation
 ┌───────────┐          ┌──────────────────┐          ┌──────────────────┐
 │  app/     │  bearer  │  TLS proxy :443  │  bearer  │  opencode serve  │
 │  (phone)  │─────────▶│  (Caddy/nginx)   │          │  :4096           │
 └───────────┘          │      │           │  Basic   │  (headless API)  │
                        │      ▼           │─────────▶│                  │
                        │  relay :4097 ────┼── tunnel │  clients/ wrap   │
                        └──────────────────┘  (ssh/   │  opencode        │
                                               frp)   └──────────────────┘
```

**Tailnet route**

```
 Phone / desktop client                 Host (always on)
 ┌──────────────────┐   Tailscale      ┌──────────────────────────────────────┐
 │ app/  (iPhone)   │   HTTPS          │ tailscale serve  :8443  (TLS, certs) │
 │ desktop/ (macOS, │─────────────────▶│        │                             │
 │  Windows)        │  bearer token    │        ▼                             │
 └──────────────────┘                  │ relay  127.0.0.1:4097                │
                                       │   bearer → Basic, target routing     │
                                       │        ▼                             │
                                       │ opencode serve 127.0.0.1:4096 (,4098)│
                                       └──────────────────────────────────────┘
```

On both routes the relay checks a client's bearer token, rewrites it to Basic
auth and forwards to the backend the client selected, so a client never sees the
backend password. A phone pairs once by scanning a single-use QR code from the
relay dashboard and keeps a revocable credential in its keychain. Details:
[`docs/architecture.md`](docs/architecture.md).

### What the clients do

- Browse the sessions on every paired machine, send prompts, pick agent, model
  and reasoning variant, answer permission requests and questions, attach photos
  and PDFs.
- **Select any part of a reply**: a few words or a span across paragraphs and code
  blocks on the phone, across messages on the desktop; *Select text* opens the
  whole conversation for selections that span messages.
- **Formulas**: `$…$`, `\(…\)`, `$$…$$` and `\[…\]` are typeset with KaTeX; copying
  a selection that contains math gives the TeX source.
- **Todo board**: the main agent's todo list with progress and the task in
  progress, like the TUI sidebar (`ctrl+x b` on the desktop).
- **Failed turns are shown**: API errors, network errors or a missing model appear
  in red boxes in the transcript and above the prompt, retries say why, instead
  of the session stopping silently.
- **Nothing waits unseen**: subagent permission requests can be answered from the
  parent session; the session list marks sessions that wait for you or stopped on
  an error; the desktop client raises system notifications and stays in the tray.

### Build and run

There are no prebuilt public binaries: the desktop packages are unsigned and an
iPhone build is tied to the Apple account that signs it, so each part is built
from source.

1. **Backends and relay** — follow your route: [`host/README.md`](host/README.md)
   (tailnet) or [`relay/README.md`](relay/README.md) plus the launcher README in
   [`clients/windows`](clients/windows/README.md) or
   [`clients/macos`](clients/macos/README.md) (VPS). The relay needs Node 22 or
   newer.
2. **iPhone app** — set your own `name`, `slug` and `ios.bundleIdentifier` in
   `app/app.json`, then follow [`app/README.md`](app/README.md). With a free Apple
   ID the signature lasts seven days; `IOS_TEAM=<team id> host/renew-ios-app.sh`
   rebuilds, re-signs and reinstalls in one command.
3. **Desktop client** — run `npm ci` in `app/` and in `desktop/`, then
   `npm run package` in `desktop/`. It builds for the platform you are on;
   `npm run package -- --platform=win32` cross-builds Windows from a Mac. See
   [`desktop/README.md`](desktop/README.md).

### Current state

| Component | State |
|-----------|-------|
| iPhone app | 2.0.0. 517 unit tests pass. Verified by hand on an iPhone 16 running iOS 27: install, launch, connecting through a relay, partial text selection, typeset math. Builds with Xcode 27.1 (Expo 57.0.31). |
| Android | The Expo project declares Android, but the iOS-specific pieces added in 1.2/2.0 (native text selection, WebView math) fall back there to plain selectable text and TeX source, and no Android build has been tested. |
| Desktop, macOS | 2.0.0, 44 tests pass. Used daily; packaging, tray, start at login, the todo board and error boxes verified on a real machine. Notification banners were not seen during testing because Do Not Disturb was on. |
| Desktop, Windows | 2.0.0, cross-built from macOS. The first version ran on Windows; notifications and the 2.0 features have not yet been confirmed on a real Windows machine. |
| Relay | 59 tests pass: the original suite plus the CORS and stream-teardown fixes. Supports both routes. |
| Tailnet host | macOS only. A Windows host (via WSL) is not implemented. |
| VPS launchers (`clients/windows`, `clients/macos`) | Unchanged from the original release. macOS tests: 6 of 7 pass; the seventh fails the same way on the original code, because it compares `/var/...` with the same path resolved as `/private/var/...`. The Windows Node contract test passes; the PowerShell tests were not run. |

History of the iOS 27 launch-crash work, the TestFlight releases and the
investigations behind several fixes is in [`docs/`](docs). What the cockpit line
added to the app is listed in
[`docs/differences-from-upstream.md`](docs/differences-from-upstream.md).

### Security notes

- The relay stores only SHA-256 hashes of device and machine credentials. Raw
  credentials are returned once and never written to disk.
- `tokens.json`, `passkeys.json`, `machine.json`, `frpc.toml`, and `*.env` hold
  live secrets. They are git-ignored here; keep them that way.
- Rotate any credential that has ever been committed, printed, or shared.
- The relay listens only on `127.0.0.1`. TLS belongs to the reverse proxy (VPS
  route) or to Tailscale (tailnet route).

### Layout

```
app/            OpenCode Mobile: Expo / React Native client (iPhone app, desktop web bundle)
desktop/        OpenCode Cockpit: Electron shell for macOS and Windows
relay/          relay service (Node), systemd unit, VPS deploy helper, reverse-proxy examples
clients/
  windows/      VPS route: relay-aware opencode wrapper (complete reference)
  macos/        VPS route: self-contained macOS launcher, installer, controller, and tests
  README.md     client machines that also run a third-party VPN (tailnet route)
host/           tailnet route: macOS host deployment, uninstall, iPhone re-signing
docs/           architecture, specs, release notes and investigations
```

### Credits and license

Created by [BB-84C](https://github.com/BB-84C). The tailnet route, the desktop
client OpenCode Cockpit, and the 1.2 / 2.0 client features were contributed from
the [cockpit line](https://github.com/hairen-org/opencode-mobile-solution).

MIT — see [LICENSE](LICENSE).

</details>

<a id="简体中文"></a>
<details>
<summary><b>简体中文</b></summary>

把你自己电脑上的 [OpenCode](https://github.com/anomalyco/opencode) 会话带到手机和另一台电脑上。这是一套自己搭的起步工具，不是托管服务：每个部分都由你自己运行，凭证都在你自己手里。

### 仓库里有什么

| 部分 | 是什么 | 版本 |
|------|--------|------|
| **`app/`**：OpenCode Mobile | Expo / React Native 客户端。编译成 iPhone 应用；同一份代码导出成网页，供桌面客户端加载。 | 2.0.0 |
| **`desktop/`**：OpenCode Cockpit | 包住这份网页的 Electron 壳，支持 macOS 和 Windows：和 TUI 一致的键位、常驻托盘、开机自启、系统通知。 | 2.0.0 |
| **`relay/`** | 只监听本机回环地址的小型 Node 服务。把每台设备的 Bearer 令牌换成后端的 Basic 认证，在多个后端之间分流，按设备限制可访问的目录，并提供用通行密钥（passkey）保护的控制台，用来配对手机和授权机器。 | — |
| **`clients/`** | VPS 路线：Windows 和 macOS 上的本机启动器，让工作站上的 `opencode` 挂到经中继连通的共享后端。另有一份说明，讲分机同时开着其他 VPN 时怎么连上 Tailscale。 | — |
| **`host/`** | Tailnet 路线：在一台常开的 Mac 上一条命令部署后端和中继；另有 `renew-ios-app.sh` 用于给 iPhone 应用续签。 | — |

仓库里没有写死任何服务器或身份信息：App 没有内置中继地址；中继和启动器的默认域名是占位用的 `opencode.example.com`；iPhone 的 bundle identifier 是 `com.example.opencodemobile`，部署时换成你自己的。

### 选一条部署路线

两条路线用的是同一份中继代码，客户端两条都支持，任选其一。

| | **VPS 路线** | **Tailnet 路线** |
|---|---|---|
| 中继跑在哪 | VPS 或其他常开的机器，前面放 Caddy / nginx | 跑后端的那台机器本身 |
| 后端怎么连到中继 | SSH 反向隧道或 FRP | 本机回环地址 |
| 客户端怎么连到中继 | 公网 HTTPS 域名 | [Tailscale](https://tailscale.com) 内网 |
| 怎么添加机器 | 在控制台里走 OAuth 设备授权注册 | 部署脚本写入静态目标 |
| 你需要准备 | 一台 VPS、一个域名、一个 TLS 反向代理 | 每台设备装 Tailscale |
| 从这里开始 | [`relay/README.md`](relay/README.md)、[`relay/deploy/`](relay/deploy)、[`clients/`](clients) | [`host/README.md`](host/README.md) |

两条路线的结构图见上方英文部分。无论哪条路线，中继都会先校验客户端的 Bearer 令牌，再换成 Basic 认证转发到客户端选定的后端，所以客户端始终拿不到后端密码。手机只需扫一次控制台给出的一次性二维码完成配对，之后在钥匙串里保存一个可随时吊销的凭证。详见 [`docs/architecture.md`](docs/architecture.md)。

### 客户端能做什么

- 浏览每台已配对机器上的会话，发送指令，选择 agent、模型和推理档位，回答权限请求和问题，发送照片和 PDF。
- **任意选中复制**：手机上可以只选几个字，也可以跨段落、跨代码块选；桌面上可以跨消息拖选；「Select text」会打开整段对话，用来跨消息选中。
- **公式**：`$…$`、`\(…\)`、`$$…$$`、`\[…\]` 用 KaTeX 排版；选中内容里有公式时，复制得到的是 TeX 源码。
- **Todo 看板**：和 TUI 侧栏一样，显示主 agent 的任务列表、进度和当前任务（桌面上按 `ctrl+x b` 展开或收起）。
- **报错看得见**：API 错误、网络错误、模型不存在等，都会在对话里和输入框上方显示红色报错框；服务端自动重试时会说明原因。会话不会再无声地停住。
- **不会漏掉待处理的请求**：子 agent 的权限申请可以在父会话里直接批准；会话列表会标出在等你处理或因报错停下的会话；桌面客户端会弹系统通知，并常驻托盘。

### 编译和运行

不提供现成的公开安装包：桌面包没有签名，iPhone 安装包又和签名用的 Apple 账号绑定，所以每个部分都要从源码编译。

1. **后端和中继**：按你选的路线来。Tailnet 路线看 [`host/README.md`](host/README.md)；VPS 路线看 [`relay/README.md`](relay/README.md)，再看 [`clients/windows`](clients/windows/README.md) 或 [`clients/macos`](clients/macos/README.md) 里启动器的说明。中继需要 Node 22 或更新版本。
2. **iPhone 应用**：在 `app/app.json` 里换成你自己的 `name`、`slug` 和 `ios.bundleIdentifier`，然后按 [`app/README.md`](app/README.md) 操作。免费 Apple ID 的签名只有 7 天有效；`IOS_TEAM=<你的团队号> host/renew-ios-app.sh` 一条命令完成重新编译、签名和安装。
3. **桌面客户端**：在 `app/` 和 `desktop/` 里分别运行 `npm ci`，再在 `desktop/` 里运行 `npm run package`，就会编出当前平台的安装包；在 Mac 上用 `npm run package -- --platform=win32` 可以交叉编译 Windows 版。见 [`desktop/README.md`](desktop/README.md)。

### 项目现状

| 部分 | 状态 |
|------|------|
| iPhone 应用 | 2.0.0，517 个单元测试通过。已在 iOS 27 的 iPhone 16 上手动验证：安装、启动、经中继连接、局部选中复制、公式排版。可用 Xcode 27.1 编译（Expo 57.0.31）。 |
| Android | Expo 工程里声明了 Android，但 1.2 / 2.0 新增的 iOS 专属部分（原生选字、WebView 公式）在 Android 上会退回普通的可选文字和 TeX 源码，而且还没有测过任何 Android 构建。 |
| 桌面端 macOS | 2.0.0，44 个测试通过。日常在用；打包、托盘、开机自启、todo 看板、红色报错框都在真机上验证过。测试时开着勿扰模式，没看到系统通知横幅弹出。 |
| 桌面端 Windows | 2.0.0，在 macOS 上交叉编译。第一版在 Windows 上跑过；通知和 2.0 的新功能还没在真实 Windows 机器上确认。 |
| 中继 | 59 个测试通过：原有测试，加上 CORS 和流中断这几项修复的测试。两条路线都支持。 |
| Tailnet 主机 | 只支持 macOS。Windows 主机（经 WSL）还没有实现。 |
| VPS 启动器（`clients/windows`、`clients/macos`） | 与原版相同。macOS 测试 7 个通过 6 个；剩下那个在原版代码上同样失败，原因是测试把 `/var/...` 和它解析后的 `/private/var/...` 当成了不同路径。Windows 的 Node 契约测试通过；PowerShell 测试没有运行。 |

iOS 27 启动闪退的排查、TestFlight 发布记录，以及几项修复背后的调查，都在 [`docs/`](docs) 里。cockpit 线给 App 加了哪些东西，见 [`docs/differences-from-upstream.md`](docs/differences-from-upstream.md)。

### 安全须知

- 中继只保存设备和机器凭证的 SHA-256 哈希。原始凭证只返回一次，从不写入磁盘。
- `tokens.json`、`passkeys.json`、`machine.json`、`frpc.toml` 和 `*.env` 里都是正在使用的密钥，已被 git 忽略，请保持这样。
- 只要某个凭证曾被提交、打印或分享过，就换掉它。
- 中继只监听 `127.0.0.1`。TLS 由反向代理（VPS 路线）或 Tailscale（Tailnet 路线）负责。

### 目录结构

```
app/            OpenCode Mobile：Expo / React Native 客户端（iPhone 应用、桌面端网页）
desktop/        OpenCode Cockpit：macOS 与 Windows 的 Electron 壳
relay/          中继服务（Node）、systemd 单元、VPS 部署脚本、反向代理示例
clients/
  windows/      VPS 路线：感知中继的 opencode 包装器（完整参考实现）
  macos/        VPS 路线：自包含的 macOS 启动器、安装器、控制器和测试
  README.md     分机同时运行其他 VPN 时的配置（Tailnet 路线）
host/           Tailnet 路线：macOS 主机部署、拆除、iPhone 续签
docs/           架构、规格、发布记录和问题调查
```

### 致谢与许可

项目由 [BB-84C](https://github.com/BB-84C) 创建。Tailnet 路线、桌面客户端 OpenCode Cockpit，以及 1.2 / 2.0 的客户端功能来自 [cockpit 分支](https://github.com/hairen-org/opencode-mobile-solution)。

MIT 许可，见 [LICENSE](LICENSE)。

</details>
