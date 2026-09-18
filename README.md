# dsh-quota

> v0.2.0

在 DeepSeek Harness Web GUI 的输入框右下角显示 **OpenCode Go 订阅额度**与 **DeepSeek 余额**。

## 显示什么

胶囊（收起态）：`5 小时 2% · 本周 4% · 本月 10%`
点击展开明细面板。

面板顶部有一个 **[官方 / 本机]** 切换按钮，决定百分比的来源：

| 数据源 | 含义 |
|---|---|
| **官方** | 上游返回的整数百分比，与官方控制台一致 |
| **本机** | 按本机会话日志实测金额 ÷ 窗口预算计算，含一位小数 |

两个来源的差异与选择方式见下一节。

面板内容：

- **OpenCode Go 额度**：5 小时 / 本周 / 本月三个窗口，各带进度条、百分比、重置倒计时。
  数据来自 `GET https://opencode.ai/zen/go/v1/usage`（Bearer `OPENCODE_API_KEY`）。
- **DeepSeek 余额**：`GET https://api.deepseek.com/user/balance`（Bearer `DEEPSEEK_API_KEY`）。
  按量付费余额，不是订阅额度；没配 key 就整块不显示。

口径只针对 **DeepSeek V4.1 Flash**。

## 数据源：官方 vs 本机

**这两个来源天然对不上**，所以做成可切换，而不是强行二选一。

上游 `/zen/go/v1/usage` **只返回整数百分比**（实测响应体只有
`usage.<window>.{status, percent, resetsAt}`，`percent` 是 `6` 这种整数；
`?window=day`、`?granularity=day`、`?period=today` 全部被忽略），也**没有按天数据**
（`/usage/daily`、`/billing`、`/credits`、`/spend` 均 404）。

所以「本机」小数是用本机实测金额算出来的：

```
measuredPercent = 本机实测金额 ÷ 窗口预算 × 100
```

例如本机 5 小时窗口花了 $0.73，预算 $12 → `0.73 / 12 = 6.1%`。

**但本机统计只覆盖 DSH 自身流量**——如果你还用 Claude Code、OpenCode CLI、
网页版等其它客户端，本机值必然偏低（实测遇到过官方 10.9%、本机 9.9% 的情况，
相差 1 个百分点）。**这就是要切换的原因**：

- 只在 DSH 里用 → 本机值更精细（能看到小数）
- 别处也用过 → 只有官方值准确

### 自动判定

首次打开时自动判定一次，结果记入 `localStorage`（键 `dsh-quota:source`），
之后不再自动变更：

```
取三个窗口中「官方 − 本机」的最大差额

差额 > 1 个百分点  →  用官方（说明本机漏算了其它客户端流量）
差额 ≤ 1 个百分点  →  用本机
任一侧数据缺失      →  用官方（官方永远权威）
```

之后随时可以点面板顶部的按钮手动切换。

## 本机统计是怎么算的

由 `src/spend.js` 在本机算：

1. 扫描 `~/.dsh/sessions/**/session.jsonl.zstd`（只看有数据落入窗口的文件）；
2. 按 `request/header` 事件的 `config.provider` / `config.model` 给每次请求归因；
3. 取 `assistant/chunk`（`chunk.type === "usage"`）里 provider 上报的精确 token 数；
4. 只统计 `opencode-go-v41` + `deepseek-v4.1-flash`；
5. 按单价计价（USD / 1M tokens）：
   - 低谷（Off-Peak）输入 0.15 / 输出 0.60 / 缓存读 0.003
   - 高峰（Peak）输入 0.30 / 输出 1.20 / 缓存读 0.006
   - 高峰时段：UTC 周一至周五 01:00–04:00 与 06:00–10:00，其余含周末为低谷

一次扫描同时给出四个窗口：今日（本地 00:00 起）、最近 5 小时、最近 7 天、本月，
其中后三者对应上游的三个窗口。

**这是本机估算，不是账单口径**：只含本机 DSH 的流量，不含 OpenCode CLI/TUI 等其它客户端。

### 两个实现要点

- 会话日志是**多帧 zstd**（每批追加一帧）。Node 的 `zstdDecompressSync` 只解第一帧
  （实测只拿到开头 212 字节），必须按帧魔数 `0x28 0xB5 0x2F 0xFD` 切分后逐帧解压。
- 解压用 Node 24 内置 `zlib` 的 zstd，**不引入任何依赖**。

## 界面位置

`conversation.input.right` 插槽——composer 底部工具行右侧，即输入框下方、
模型选择器与上下文占用表左侧的位置（官方支持的插槽）。

## 安全边界

- API key 只在**宿主进程**中解析（优先 `ctx.credentials`，退回环境变量），
  绝不进入任何 HTTP 响应、日志或浏览器代码。
- 浏览器只访问本机同源端点 `/__dsh-quota/*`，不直连任何第三方域名。
- 上游失败只暴露粗粒度状态（无 key / 鉴权失败 / 网络不可达 / 超时 / 上游错误 / 结构不符），
  不回显上游响应正文。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__dsh-quota/state` | 读取快照（额度 TTL 60 秒；本机花费 TTL 5 分钟） |
| POST | `/__dsh-quota/refresh` | 强制刷新（同时重算本机花费） |

## 安装

> 详细的安装、更新与排查步骤见随附的《DSH 插件安装指南》。

```bash
dsh plugin --profile web add github:leai9572000/dsh-quota
```

`dsh plugin` 会转发给 pnpm，在 profile 目录完成安装。装完后把包名登记进
`~/.dsh/profiles/web/package.json` 的 bundle 列表（DSH 0.1.2-rc.1 需要手工登记）：

```json
{
  "dsh": { "profile": { "bundles": ["…已有 bundle…", "dsh-quota"] } }
}
```

然后重启 `dsh web`。

### ⚠️ 改了源码却不生效？先看这里

`nodeLinker: hoisted` 模式下，pnpm 把 `file:` 依赖**拷贝**进
`~/.dsh/profiles/web/node_modules/<name>`，不是软链。所以直接改源码目录后重启服务，
跑的还是那份旧拷贝。

处理方式（二选一）：

1. 在 `~/.dsh/profiles/web` 重新跑 `pnpm install`，让拷贝刷新；
2. 把安装位置换成指向源码的软链（推荐，之后改源码即生效）：

```bash
cd ~/.dsh/profiles/web/node_modules/dsh-quota
rm -rf src && ln -s /绝对路径/dsh-quota/src src
```

注意：后续再次 `pnpm install` 可能把软链改回拷贝，到时重做一次。

另外，纯改源码**不会**热重载：DSH 启动时 HMR 用的是空监听根（`root: []`），
且 Node 已缓存该模块；touch 被监听的 `cordis.patch.yml` 也不会重新 import。
必须重启 `dsh web`。

## 已知边界

- 上游 `/zen/go/v1/usage` 不是 OpenCode 的公开文档 API，上游改动会让面板显示失败状态
  （不会报错或拖慢界面）。
- 接口返回的百分比是"整计划"还是"当前模型"未经验证（文档说限额按模型），
  换模型跑一段时间后对比即可判断。
- 本机窗口与上游窗口的起算口径不同（本机 weekly 用"最近 7 天"、monthly 用"本月 1 日起"），
  因此「本机」值会与官方值有出入；**需要与官方一致时请切换到「官方」数据源**。
- 「本机」值只覆盖本机 DSH 流量，与官方百分比（含所有客户端）不可直接对比。
