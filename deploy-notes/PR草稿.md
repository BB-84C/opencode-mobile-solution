# PR 草稿（待你过目后再推）

**目标仓库**：`BB-84C/opencode-mobile-solution`
**分支**：`fix/relay-stream-teardown`（基于上游 `d89d493`）
**提交**：2 个，各自独立通过测试
**改动**：4 个文件，+168 / -3，全部在 `relay/`，不含任何个人配置

---

## 建议的 PR 标题

```
fix(relay): release aborted SSE streams and keep pairing scope bounded
```

## 建议的 PR 正文

```markdown
Two defects found while running this stack end to end from a real iPhone
over a week of use. Both are in `relay/`; no client or app changes.

### 1. A paired device escaped the scope it was granted

`clientFromDevice` replaced the device's stored `targetIDs` with whatever
targets the relay currently knows about:

```js
const targetIDs = dynamicTargets ?? [...device.targetIDs];
```

A phone paired against a source client authorized for one machine silently
gained access to every machine enrolled later. `GET /relay/targets` listed
them, and `resolveScope` accepted an `X-OpenCode-Target` for them. That
contradicts the README's promise that pairing never grants broader machine
access than its source.

Fixed by intersecting with the device's own grant rather than replacing it,
which keeps the parameter's original purpose (drop targets that no longer
exist) while making the grant an upper bound.

The existing test missed it because its pairing source was already
authorized for both targets, so replacement and intersection agreed.

**Reproduce:** configure two targets, give the pairing source only one,
pair a phone, then call `GET /relay/targets` as that phone.

### 2. Aborted client streams leaked their upstream connection

`clientRes.once('close', notifyClose)` only ran the bookkeeping callback and
never destroyed `proxyReq`. Every abandoned stream left one upstream
connection open. Phones abort SSE constantly — screen lock, network switch,
app backgrounded — and after roughly thirty reconnects the backend stopped
accepting new connections and `/event` answered 502 permanently.

Measured on a real device before the fix:

```
independent connections to the backend : 36
  of which held by the relay process   : 35
real clients on the relay's own port   :  1
```

`close()` already performed the correct teardown and is idempotent; it was
simply never called on this path. It is now called when the response did not
finish on its own, with the plain notification kept for a normal completion.

**Reproduce:** open an SSE stream through the relay, abort the client, repeat.
Upstream connections grow monotonically; `/event` starts returning 502.

### 3. The test harness hid defect 2

`fake-upstream` registered its cleanup with `request.on('close')` *after* the
handler had already drained the request with `for await`. The request stream
had ended, so the listener never fired and `eventClients` only ever grew.
That is also why `disconnectEvents()` has to clear the set by hand.

Any assertion that connections were released got a false negative — this cost
me three wrong conclusions before I noticed the instrument was broken.
Teardown is now tracked on `response`, which stays open for the life of the
stream.

### Verification

- `relay/test/stream-teardown.test.mjs` opens five streams, aborts them, and
  asserts the upstream releases all of them. It times out against the old
  behavior and passes in ~300 ms with the fix.
- Independently confirmed with the upstream server's own
  `server.getConnections()`: 5 → 0 after aborting.
- Full suite: 53 passing, 0 failing (52 before, +1 new).
- Soaked on the live deployment: 30 reconnects through
  Caddy → relay → `opencode serve`, upstream connections stayed at 2–3 with
  zero 502s. Before the fix the same pattern reached 36 connections and
  permanent 502s.
```

---

## 另外两项可能值得单独反馈（不在本 PR 内）

这两项我没有改，因为超出"修缺陷"的范围，交给作者判断：

**一、部署脚本的文件属主与 systemd 运行用户不匹配**
`deploy/deploy-relay.sh:92-97` 用 `sudo install -m 600` 创建 `tokens.json`，属主是 `root:root`，而 `opencode-relay.service:9` 以 `User=ubuntu` 运行，服务读不到自己的配置。照 README 一步步做会起不来。

**二、README 的 iOS 构建指引不足以装到真机**
`app/README.md` 给的是 `npm run ios`，而该脚本原本是 `expo start --ios`，只启动开发服务器。由于 `withOpenCodeAppIntents` 会生成 Swift 并改 Xcode 工程，完整功能必须 prebuild 后编译原生包。实际可用路径是 `npm install` → `npx expo prebuild --platform ios` → `npx expo run:ios --device`。

有意思的是，`expo prebuild` 自己就把 `package.json` 里的 `ios` 脚本改成了 `expo run:ios`，等于工具替作者修正了这个问题。

另外值得在 README 里写明：**当前所有 entitlements 都不需要付费 Apple Developer 账号**，免费 Apple ID 的 Personal Team 即可本地安装（7 天有效期）。这对个人使用者是关键信息。

完整的 18 项审计见同目录 `给作者的审计报告.md`。

---

## 推送方式（你确认后）

```bash
cd ~/Documents/Files.ai/2026-09-09-opencode-mobile-ios/source/opencode-mobile-solution
gh repo fork BB-84C/opencode-mobile-solution --remote=false --clone=false
git push <你的fork> fix/relay-stream-teardown
gh pr create --repo BB-84C/opencode-mobile-solution \
  --head <你的账号>:fix/relay-stream-teardown \
  --title "fix(relay): release aborted SSE streams and keep pairing scope bounded" \
  --body-file <上面的正文>
```

当前 `gh` 登录账号是 `XinHu-001`。
