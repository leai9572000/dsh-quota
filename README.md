# dsh-quota

> v0.3.0

在 DeepSeek Harness Web GUI 的输入框右下角显示 **OpenCode Go 订阅额度**。

## 显示什么
胶囊（收起态）：`5 小时 2% · 本周 4% · 本月 10%`
点击展开明细面板。

面板只展示一件事：**OpenCode Go 的三个额度窗口**。

| 窗口 | 含义 |
|---|---|
| 5 小时 | rolling 滚动窗口 |
| 本周 | 自然周（周一 00:00 重置） |
| 本月 | 自然月 |

每行一条进度条 + **官方整数百分比** + 重置倒计时。

数据来自 `GET https://opencode.ai/zen/go/v1/usage`（Bearer `OPENCODE_API_KEY`），
返回体只有 `usage.<window>.{status, percent, resetsAt}`，**没有任何美元字段**
（`/usage/daily`、`/billing`、`/credits`、`/spend` 均 404）。所以百分比就是官方值，
与官方控制台一致。口径只针对 **DeepSeek V4.1 Flash**。

> v0.3.0 精简了面板：移除了「官方 / 本机」数据源切换、本机金额、
> 「今天」分组与 DeepSeek 余额分组，只留 OCGo 三个窗口。
> 理由见下方「为什么只有一个数据源」。

## 为什么只有一个数据源

上游 `/zen/go/v1/usage` 只返回**整数百分比**（实测响应体只有
`usage.<window>.{status, percent, resetsAt}`；`?window=day`、`?granularity=day`、
`?period=today` 全部被忽略），也没有按天数据、没有任何美元字段
（`/usage/daily`、`/billing`、`/credits`、`/spend` 均 404）。

v0.2.x 曾提供第二个「本机」数据源：用本机会话日志的 token 量按单价表估算金额，
再除以窗口预算得出小数百分比。**v0.3.0 已移除**，原因是实测对不上：

| 窗口 | 本机金额 | 官方% | 反推出的隐含预算 |
|---|---|---|---|
| 5 小时 | $1.17 | 6% | $19.4 |
| 本周 | $1.23 | 3% | $40.9 |
| 本月 | $17.30 | 17% | $101.8 |

同一个订阅计划不可能有三个相差 2~2.5 倍的预算 —— 说明**本地单价表与 OCGo 的实际
计费口径不一致**（本机统计里缓存读占绝对多数，如月度 1765M vs 输入 9.1M，
约 194:1，金额几乎全由缓存读单价决定）。

拿一个不可信的预算除出一个带小数的百分比，看着比官方整数「更精确」，
实际是错的，而且界面没有任何参照物能发现它错。所以：

- **百分比只看官方**：它是唯一权威且一致的口径；
- **本机金额不再展示**：宁可不给，也不给一个系统性偏差的数。

宿主端的本机统计代码（`src/spend.js`）**仍保留**，默认关闭
（`src/index.js` 的 `readSpend()` 里 `SHOW_LOCAL_SPEND = false`）。
理由是它单次要同步解压几十个会话日志、实测阻塞约 670ms，而结果没人用。
若日后要恢复展示，把开关置回 `true` 并补回前端 UI 即可。
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
其中后三者对应上游的三个窗口，且**起算时间对齐官方口径**（用官方 `resetsAt` 反推：
rolling −5h、weekly −7d、monthly −1 自然月，含月末夹取）。

> 历史教训：早期版本 weekly 用「最近 7 天」滑动窗口，而官方 weekly 是**自然周**
> （周一 00:00 UTC 重置），实测多算了 6.6 天，导致本机 56.4% 对官方 3%。
> 修正后三者满足 `rolling ≤ weekly ≤ monthly`。

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
- **浏览器信任栅栏**（v0.3.0 起）：两条路由都先调 `connection.requestRejection(req)`，
  拒绝伪造 Host/Origin（DNS 重绑定）与未认证请求 —— 否则任意网页都能借本机同源的
  服务器把余额与额度读走。`connection` 服务缺失时 fail-open（只 warn 一次后放行）。
- **业务层错误识别**（v0.3.0 起）：有些接口鉴权失败仍返回 HTTP 200，真正的错误在 body 里。
  插件会提取厂商错误文本（截断 120 字）展示，而不是笼统报「上游返回 200」。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__dsh-quota/state` | 读取快照（额度 TTL 60 秒） |
| POST | `/__dsh-quota/refresh` | 强制刷新（忽略额度 TTL） |

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
- 界面百分比**只有官方整数**：面板不展示本机估算（理由见「为什么只有一个数据源」）。
- 百分比不保留小数 —— 上游就是整数，没有小数可用（不做无意义的补零）。
- 本机统计代码保留但默认关闭；若要恢复，除打开 `SHOW_LOCAL_SPEND` 外，
  还需先校准 `src/spend.js` 的单价表，否则金额仍会系统性偏差。
