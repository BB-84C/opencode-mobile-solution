# 分机端：与第三方 VPN 共存

分机连不上主机，最常见的原因不在这套软件里，而在分机自己的路由表。

如果你的 Mac 或 Windows 上同时跑着 Shadowrocket、Clash 这类会建立自己隧道的客户端，
它们会接管默认路由，把本该走 Tailscale 的包吃掉。表现是连接超时，而不是被拒绝。

这份文档记录一次完整排查的结论，以及两个平台的具体配法。

## 先分清是哪一类

三种原因长得很像，都是「连不上」，但修法完全不同。在出问题的网络里、**关掉所有 VPN**
只连 Tailscale，跑一条命令就能分开：

```bash
ipconfig getifaddr en0          # macOS
ipconfig | findstr IPv4         # Windows
```

| 本机地址 | 关掉 VPN 后 | 结论 | 去哪修 |
|---|---|---|---|
| `100.64.x` ~ `100.127.x` | 仍然不通 | 网段冲突 | 只能改路由器，见最后一节 |
| 正常私有段 | 就通了 | VPN 抢路由 | 客户端规则，见下文 |
| 正常私有段 | 仍然不通 | 数据面建不起来 | 路由器 NAT/IPv6 设置 |

正常私有段指 `192.168.x`、`10.x`、`172.16-31.x`。

## Tailscale 借用了 CGNAT 网段

`100.64.0.0/10` 是 RFC 6598 划给运营商级 NAT 的共享地址空间，Tailscale 借用了它。
机场、酒店、以及部分家用路由器也用这一段给客户端分配地址，撞上了就是硬冲突：
系统无法判断 `100.x` 的目标该走物理网卡还是 Tailscale，通常本地直连网段优先，
包被扔进当地局域网。

这类情况**与 VPN 无关**，关掉 VPN 也不通，用一台没装 VPN 的手机去试同样不通。
判据就是上面那张表的第一行。

## macOS：Shadowrocket

Shadowrocket 走 NetworkExtension，会建 utun 隧道接管默认路由。

在配置的 `[Rule]` 段**最前面**加三条：

```
IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
IP-CIDR6,fd7a:115c:a1e0::/48,DIRECT,no-resolve
DOMAIN-SUFFIX,ts.net,DIRECT
```

三条缺一不可。前两条加了 `no-resolve` 就不会对域名做解析后匹配，所以用
`<主机>.<tailnet>.ts.net` 发起的请求要靠第三条才命中。顺序也重要，必须排在
`FINAL` 之前，放最前面最稳妥，否则会被上面的代理规则先吃掉。

改完**完全断开隧道再重连**。规则只在建立隧道时加载一次，光按保存不生效——
这一点导致过一次误判，规则明明是对的却测出不通。

### 不要用 tun-excluded-routes

这是排查中走的最大一段弯路，记在这里避免重犯。

`[General]` 段的 `tun-excluded-routes` 看名字像是「这段地址别接管」，实际语义是
「这段地址甩给物理网卡」。填 `100.64.0.0/10` 之后，路由表里会多出这么一条：

```
100.64/10          192.168.1.1        UGSc                  en0
```

它把 Tailscale 的流量送去了家用路由器，而路由器不认识 `100.101.50.67`，包就死在那儿。
更糟的是优先级：Tailscale 自己那条带 `I` 标志（`UCSI`），是 **scoped 路由**，
只对显式绑定该接口的 socket 生效；而这条没有 `I`，是全局路由，普通程序查表优先命中它。
于是它不但没帮上忙，还把唯一可能生效的路径压了下去。

任何名为「排除网段」「绕过路由」「bypass routes」的设置都属同一类，一律不要用。

## Windows：Clash Verge

先确认工作模式，两种要做的事不同，一起做也无妨。

**TUN 模式**会接管路由表，和 Shadowrocket 同类。用 Merge 类型的扩展配置注入规则，
这样订阅更新不会冲掉：

```yaml
prepend-rules:
  - IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
  - IP-CIDR6,fd7a:115c:a1e0::/48,DIRECT,no-resolve
  - DOMAIN-SUFFIX,ts.net,DIRECT
```

`prepend-rules` 会插到规则表最前面。改完在界面里重载配置。

**系统代理模式**不碰路由表，问题只在于程序把请求交给了代理服务器。
在「设置 → 系统代理 → 绕过规则」里加上：

```
*.ts.net;100.*
```

Windows 的绕过列表不认 CIDR，只认通配符，所以写 `100.*`。它比 `100.64.0.0/10`
略宽，但该段基本都是 CGNAT 保留地址，实际影响可以忽略。

同样不要碰 TUN 的 `route-exclude-address`，理由见上一节。

## 命令行工具要单独设

这一条极易遗漏，而且症状具有迷惑性：**图形客户端用得好好的，curl 却一直卡到超时。**

原因是 curl、wget 这类工具读的是环境变量，不看系统代理的绕过列表，也不受
Shadowrocket 规则影响。请求被交给代理服务器，而代理到不了 tailnet 地址。

```bash
export no_proxy="localhost,127.0.0.1,::1,.ts.net"
export NO_PROXY="$no_proxy"
```

两个注意事项：

**curl 的 `no_proxy` 不支持 CIDR。** 写 `100.64.0.0/10` 对它是无效条目，
要按 IP 绕过就写具体地址。域名后缀 `.ts.net` 是有效的，日常够用。

**改完要开新终端。** 已经开着的 shell 不会自动继承。排查时在旧终端里测出不通、
以为配置没生效，实际只是没重开而已。

临时验证可以直接绕开，不依赖环境变量：

```bash
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' --max-time 20 https://<主机>.<tailnet>.ts.net:8443/health
```

## 路由器：打开 IPv6

这一项的收益是实测出来的，值得单独说。

Tailscale 能直连时延迟约 **0.07 秒**；打不了洞退回 DERP 中继时，如果两端归属不同区域
（例如一端香港、一端旧金山），延迟会变成 **0.4 到 0.9 秒**，并且频繁超时，
`--max-time 10` 的请求几乎必然失败。

本次排查中，成功的直连是经 **IPv6** 建立的：

```
路径: 直连 [240e:359:e31:f100:8d97:a52f:ec9f:bb45]:41641
```

所以在路由器上打开 IPv6 是性价比最高的一步。其次是 UPnP / NAT-PMP（关闭会让
Tailscale 打不了洞），以及关掉 AP 隔离、过高的防火墙等级、和那些会干预 UDP 的
「安全防护」「游戏加速」类功能。

## 网段冲突：没有客户端侧的解法

如果判定为网段冲突，只能改路由器 LAN 网段：登录管理后台，把 `100.64.x.x` 改成
`192.168.31.x` 这类私有段，DHCP 地址池跟着改。代价是全家设备重新取 IP，
配过静态 IP 的打印机、NAS 要跟着调整。

如果是运营商光猫且网段锁死，可以在它后面接一台自己的路由器做二级 NAT。

如果那个网络不归你管（机场、酒店、别人家），这一类无解。**开手机热点**是可靠的规避手段:
iOS 热点固定发 `172.20.10.x`，和 Tailscale 网段没有交集，实测百分之百可用。

## 诊断速查

按顺序跑，每一条都能排掉一类可能：

```bash
# 1 本机地址：是否撞上 100.64.0.0/10
ipconfig getifaddr en0

# 2 路由归属：100 段被谁接管了
netstat -rn -f inet | grep -E '^(default|100)'

# 3 数据面是否真的建立。rx 为 0 表示一个字节都没收到
tailscale status --json | python3 -c "import sys,json;d=json.load(sys.stdin);[print(p['DNSName'],'rx=',p.get('RxBytes',0),'curaddr=',p.get('CurAddr')) for p in d['Peer'].values()]"

# 4 传输层（绕开代理，不需令牌）
curl --noproxy '*' -s -o /dev/null -w '%{http_code} %{time_total}s\n' --max-time 20 https://<主机>.<tailnet>.ts.net:8443/health
```

两个容易读错的信号：

**`tailscale ping` 通不代表 TCP 能通。** 它走的是 disco 控制通道，
WireGuard 数据面没建立时它照样 pong。判断数据面看 `rx`/`tx` 是不是 0。

**响应时间比状态码更能说明问题。** 0.07 秒是直连，0.4 秒以上是中继，
后者虽然能用但会频繁超时。
