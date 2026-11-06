# cockpit 线给 app 带来的改动

这份文档记录 cockpit 线（`hairen-org/opencode-mobile-solution`，原 PR #3）合并进
`BB-84C/opencode-mobile-solution` 时，`app/` 相对合并前原版（`fa368d2`）多了什么。
数字以 `git diff fa368d2 -- app/` 实际算出。

一句话：**手机上的界面和上游基本一样，多出来的是一套为桌面端做的键盘与导航层、几处使用性修补，以及 1.2.0 加的任意选字、子 agent 权限、提醒、公式渲染，和 2.0.0 加的 todo 看板与报错显示。**
上游的功能我们一个都没删。

## 数字

`app/` 目录相对上游（2.0.0）：93 个文件改动，+7376 行 / −174 行。其中**新增 63 个文件**，
删除 0 个文件。那 173 行删除全部来自对既有文件的就地修改。上游的功能一个都没移除，
只有一处交互改了：消息菜单从长按改成常驻的「...」按钮（见第四节）。

## 我们多出来的东西

### 一、桌面键盘层（新增 14 个文件，手机上看不见）

`src/ux/desktop-*.ts` 这一组：把 opencode TUI 的键位表翻译成本应用的动作、决定
某个键该由 store 还是当前屏幕执行、把执行结果报给用户。手机端不加载这一层，
所以它对手机版的体积以外没有任何影响。

- `desktop-actions` / `desktop-router` / `desktop-perform` / `desktop-bridge`
- `desktop-screen-registry`：屏幕在挂载期间认领自己能做的动作，离开时交还
- `transcript-scroll-commands`：翻页、跳首条、跳最新

### 二、两个新屏幕与两个新组件

| 文件 | 手机上可见 | 作用 |
|---|---|---|
| `app/devices.tsx` | 是 | 开机第一屏：选机器。上游直接进会话列表 |
| `app/new-session.tsx` | 是 | 新建会话：选机器、目录、agent、模型 |
| `components/opencode/CommandPalette.tsx` | 是 | 全局命令面板，手机上由列表页顶部按钮打开 |
| `components/opencode/NoticeToast.tsx` | 是 | 操作反馈条 |

### 三、对上游文件的就地修改

- `session/[sessionKey].tsx`：会话菜单里多了「Changed files」和「Delete session」
  （删除带独立的二次确认框），转录多了「Top」按钮
- `(tabs)/two.tsx`：列表页顶部多了命令面板按钮
- `store/mobile-store.ts`：加了 `session.error` / `message.error` 事件处理、
  删除会话、提示条状态、命令面板开关
- `opencode/client.ts`：加了 `deleteSession`
- `diff-preview.tsx`：空状态文案改为中性表述
- `app.json`：bundle identifier 与版本号是我们自己的（见下）

### 四、1.2.0：选字、子 agent 权限、提醒、公式

- **任意选字**：iOS 上 RN 的 `Text` 只能整段复制。我们改成用 `@bsky.app/react-native-uitextview` 把一整条消息渲染成一个 UITextView（`SelectableText` / `SelectableMarkdown` / `markdown-spans.ts`），消息里任意几个字、跨段落都能选。「...」→「Select text」打开整段对话（`conversation-text.ts`），用来跨消息选中。消息菜单改由常驻的「...」按钮打开，不再用长按，长按留给选字。这是对上游交互的一处改变。
- **子 agent 的权限请求**：权限请求改为按目录保存，父会话里能看到并直接批准子会话的请求。
- **提醒**：监听 `/global/event`（`src/ux/attention.ts`、`use-attention.ts`、`AttentionBanner.tsx`），会话列表显示「N waiting for you」角标，手机前台出横幅，桌面端发系统通知。
- **公式**：`markdown-math.ts` 识别 `$..$`、`\(..\)`、`$$..$$`、`\[..\]`。桌面和网页端用 KaTeX 直接排版（`MathView.web.tsx`）。iOS 上带公式的消息改用 `react-native-webview` 渲染（`MathHtmlView.ios.tsx`、`math-html.ts`），KaTeX 字体内嵌在 `katex-inline-css.generated.ts` 里，升级 katex 后要运行 `npm run build:katex-css` 重新生成。复制时，选区里的公式会变回 `$...$` 源码（`math-copy.ts`）。
- 新增三个依赖：`@bsky.app/react-native-uitextview`、`react-native-webview`（原生模块，要重新构建原生工程）和 `katex`。

### 五、2.0.0：todo 看板与报错显示

- **todo 看板**（`TodoPanel.tsx`、`todo-board.ts`）：TUI 侧栏里的 todo 列表，在会话页顶部做成一条可展开的栏，显示「已完成/总数」和当前进行中的任务，展开后是完整列表（`[✓]` `[•]` `[ ]` `[✗]`）。数据来自 `GET /session/{id}/todo` 和 `todo.updated` 事件，实时更新。桌面默认展开，手机默认收起；桌面上 `ctrl+x b`（TUI 的切换侧栏）可以展开或收起，会话菜单里也有这一项。
- **报错显示**（`turn-error.ts`、`TurnErrorBox.tsx`）：一个回合失败时，主机不会把它当作输出，而是做两件事：把 `{ name, data: { message } }` 写进那条助手消息的 `info.error`，同时发出 `session.error` 事件。上游两样都没显示，工作停下了，界面上什么也看不到。现在：
  - 消息上的错误显示成红色框，打开旧会话也能看到；
  - 没有挂在消息上的错误（例如模型不存在）显示在输入框上方，可以手动关闭，新回合开始或发出新消息后自动消失；
  - 服务端自动重试时显示「Retrying · attempt N」和原因；
  - 用户自己点 Stop 只显示灰色的「Interrupted」；
  - 全局监听也接收 `session.error`，所以子 agent 或别的会话出错时，会话列表上显示红色「Stopped · …」，桌面端弹系统通知，手机端在前台弹横幅。

## 合并时的约定

1. **命名不变**：项目仍叫 OpenCode Remote，手机应用仍是 `opencode-mobile`，
   bundle identifier 仍是 `com.example.opencodemobile`（部署时换成你自己的）。
   只有新增的桌面客户端叫 OpenCode Cockpit。
2. **版本号**：`app.json` 与桌面客户端 `desktop/package.json` 都是 `2.0.0`，标明
   含 cockpit 线的增量。原版 `app.json` 是 `1.0.0`（TestFlight 的 1.0.1 / 1.0.3
   是发布编号，没有回写）。
3. **VPS 路线原样保留**：cockpit 线曾删掉 `clients/macos`、`clients/windows`、
   `relay/deploy` 和中继里的机器注册（OAuth 设备授权、FRP 传输）。合并时全部按原版
   恢复，中继代码等于原版加上三个修复（统一 CORS、浏览器来源的客户端能读转发响应、
   未被服务的客户端能读配对接口），PR #2 的两个修复也已合入。Tailnet 路线
   （`host/`）是新增的另一种部署方式，两条路线二选一。

## 上游有而我们照单全收的

iOS 27 相关的全部：Expo 57.0.23 与对齐的原生模块、`expo-build-properties` 的
`ios.enableSceneSupport`（Apple 要求用 iOS 27 SDK 构建的应用必须走 scene 生命周期）、
会话缓存上限与旧缓存清理、分页修复、权限请求卡片（`PermissionRequestCard`）与
`permission.asked` / `permission.replied` 事件、会话运行状态判定的修正。

一处值得记住的合并细节：上游在事件分发里新增权限处理的位置，正好是我们新增错误
处理的位置，合并冲突只有这一处，两块互补，都保留了。
