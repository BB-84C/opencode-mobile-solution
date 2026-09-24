# 我们的 app 与上游 app 的区别

对照基准：`BB-84C/opencode-mobile-solution` 的 `main`（上游）与本仓库的 `main`。
以 `git diff upstream/main main -- app/` 实际算出，不是凭印象写的。

一句话：**手机上的界面和上游几乎一样，多出来的是一套为桌面端做的键盘与导航层，以及三个小的使用性修补。**
上游的功能我们一个都没删。

## 数字

`app/` 目录相对上游：41 个文件改动，+3598 行 / −50 行。其中**新增 27 个文件**，
删除 0 个文件。那 50 行删除全部来自对既有文件的就地修改，没有移除上游任何功能。

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

## 与上游刻意不同的三处

1. **bundle identifier**：我们是 `com.skylerhu.opencodemobile`，上游是
   `com.example.opencodemobile`。这一条必须保持，否则 iOS 会把新装的包当成另一个
   应用，已配对的主机和令牌全部清空。
2. **版本号**：我们走 `1.1.0`，上游 `app.json` 仍是 `1.0.0`（他们的 1.0.1 / 1.0.3
   是 TestFlight 发布编号，没有回写）。分开编号是为了一眼看出这条线含我们的增量。
3. **仓库范围**：我们删掉了 `clients/macos`、`clients/windows`、`relay/deploy`
   这些 VPS / 内网穿透时代的东西，换成 `host/deploy-macos.sh` 与 tailnet 直连。
   这与 app 无关，但解释了为什么两边仓库的文件数差很多。

## 上游有而我们照单全收的

iOS 27 相关的全部：Expo 57.0.23 与对齐的原生模块、`expo-build-properties` 的
`ios.enableSceneSupport`（Apple 要求用 iOS 27 SDK 构建的应用必须走 scene 生命周期）、
会话缓存上限与旧缓存清理、分页修复、权限请求卡片（`PermissionRequestCard`）与
`permission.asked` / `permission.replied` 事件、会话运行状态判定的修正。

一处值得记住的合并细节：上游在事件分发里新增权限处理的位置，正好是我们新增错误
处理的位置，合并冲突只有这一处，两块互补，都保留了。
