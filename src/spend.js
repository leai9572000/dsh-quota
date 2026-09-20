// dsh-quota — 本地花费核算（宿主侧）。
//
// 为什么需要它：OpenCode Go 的用量接口只返回三个窗口的**整数百分比**，既没有按天数据，
// 也没有金额（`/zen/go/v1/usage/daily`、`/billing`、`/credits`、`/spend` 均为 404，
// 查询参数 window/granularity/period 一律被忽略；实测响应体只有
// `usage.<window>.{status,percent,resetsAt}` 三个键）。
//
// 所以「今天花了多少美刀」和「5.7% 这种小数」都只能自己算。
//
// 数据来源：DSH 自己的会话日志 `~/.dsh/sessions/**/session.jsonl.zstd`。
// 每个请求在 `request/header` 事件里带 `config.provider` / `config.model`，
// 紧随其后的 `assistant/chunk`（`chunk.type === "usage"`）带 provider 上报的精确 token 数：
// `inputTokens`（未命中缓存的输入）、`outputTokens`、`cacheReadTokens`。
// 按路由归因后只统计 OpenCode Go 的流量，再按 DeepSeek V4.1 Flash 在 Go 上的单价计价。
//
// 计价（USD / 1M tokens，来源 https://opencode.ai/docs/go/ 的 DeepSeek V4.1 Flash 行）：
//   低谷（Off-Peak）输入 0.15 / 输出 0.60 / 缓存读 0.003
//   高峰（Peak）    输入 0.30 / 输出 1.20 / 缓存读 0.006
// 高峰时段：UTC 周一至周五 01:00–04:00 与 06:00–10:00，其余（含周末）为低谷。
//
// 日志是**多帧 zstd**（每批追加一个帧）：Node 的 `zstdDecompressSync` 只解第一帧
// （实测只拿到开头 212 字节），所以这里按帧魔数切分后逐帧解压。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 帧魔数（小端序的 0xFD2FB528）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 只统计这个路由：OpenCode Go 上的 DeepSeek V4.1 Flash。 */
export const TRACKED_PROVIDER = 'opencode-go-v41'
export const TRACKED_MODEL = 'deepseek-v4.1-flash'

/** 单价表（USD / 1M tokens）。 */
const RATES = {
  deepseekV41Flash: {
    offPeak: { input: 0.15, output: 0.6, cacheRead: 0.003 },
    peak: { input: 0.3, output: 1.2, cacheRead: 0.006 },
  },
}

/** Go 计划里 V4.1 Flash 的窗口预算（月 $60 促销价）。 */
export const V41_WINDOW_BUDGET_USD = { rolling: 12, weekly: 30, monthly: 60 }

/** Go 的窗口长度：rolling 5 小时、weekly 7 天、monthly 按上游重置时间走。 */
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 该时刻是否处于高峰计价时段。
 *
 * @param ms - epoch 毫秒。
 * @returns 高峰返回 true。
 */
export function isPeakHour(ms) {
  const date = new Date(ms)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * 按一次请求的 token 用量计价。
 *
 * @param usage - `{ inputTokens, outputTokens, cacheReadTokens }`（缺省字段按 0 计）。
 * @param peak - 是否高峰时段。
 * @returns 美元金额。
 */
export function priceUsage(usage, peak) {
  const rate = peak ? RATES.deepseekV41Flash.peak : RATES.deepseekV41Flash.offPeak
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  return (input * rate.input + output * rate.output + cacheRead * rate.cacheRead) / 1e6
}

/**
 * 把一份多帧 zstd 缓冲区解成完整文本。
 *
 * @param buffer - 压缩内容。
 * @returns 解压后的 UTF-8 文本；坏帧跳过而不是整体失败。
 */
function decodeSessionLog(buffer) {
  const starts = []
  let cursor = 0
  while (cursor <= buffer.length - ZSTD_MAGIC.length) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (at < 0) break
    starts.push(at)
    cursor = at + ZSTD_MAGIC.length
  }
  if (starts.length === 0) return ''

  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(from, to)).toString('utf8')
    } catch {
      /* 追加写入可能留下半个帧：跳过它，其余帧照常累计 */
    }
  }
  return text
}

/**
 * 递归收集会话日志文件。
 *
 * @param root - `~/.dsh/sessions`。
 * @returns 文件绝对路径数组。
 */
function collectSessionFiles(root) {
  const files = []
  /**
   * 递归查找会话目录，每个目录只取**一个**日志文件。
   *
   * 为什么要去重：DSH 从某个版本起改用 `session.v3.jsonl.zstd`，而它并非增量文件，
   * 而是同一会话的**全量重写版**——新旧两个文件的时间范围完全重叠。两个都读会把
   * 同一份用量算两遍（实测金额直接翻倍，周窗口因此高出约 1.5 倍）。
   *
   * 取舍：v3 更全（覆盖到更晚的时间），所以有 v3 就用 v3；只有完全没有 v3 的
   * 老会话才退回旧文件。
   *
   * @param root - `~/.dsh/sessions`。
   * @returns 文件绝对路径数组（每个会话目录最多一个）。
   */
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const v3 = path.join(dir, 'session.v3.jsonl.zstd')
    const legacy = path.join(dir, 'session.jsonl.zstd')
    const hasV3 = fs.existsSync(v3)
    const hasLegacy = fs.existsSync(legacy)
    if (hasV3 || hasLegacy) {
      // 这是一个会话目录：只取一个文件，不再往下递归。
      files.push(hasV3 ? v3 : legacy)
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name))
    }
  }
  walk(root)
  return files
}

/** 一个统计窗口：起算时间 + 美元/次数/token 累计。 */
function makeBucket(since) {
  return { since, costUsd: 0, attempts: 0, peakAttempts: 0, input: 0, output: 0, cacheRead: 0 }
}

/**
 * 把一次请求的用量累加进所有窗口。
 *
 * 抽出来是因为两种日志格式（旧 `assistant/chunk` 与 v3 `assistant/message`）
 * 都要用它，避免同一段累加逻辑写两遍而走样。
 *
 * @param buckets - 四个窗口的累加器。
 * @param at - 该次用量的时间（epoch 毫秒）。
 * @param cost - 已按高峰/低谷计价好的美元金额。
 * @param usage - `{ inputTokens, outputTokens, cacheReadTokens }`。
 */
function accumulate(buckets, at, cost, usage) {
  const peak = isPeakHour(at)
  for (const bucket of Object.values(buckets)) {
    if (at < bucket.since) continue
    bucket.costUsd += cost
    bucket.attempts += 1
    if (peak) bucket.peakAttempts += 1
    bucket.input += Number(usage.inputTokens) || 0
    bucket.output += Number(usage.outputTokens) || 0
    bucket.cacheRead += Number(usage.cacheReadTokens) || 0
  }
}

/**
 * 统计本机在若干时间窗口内的 OpenCode Go / V4.1 Flash 花费与 token 用量。
 *
 * 一次扫描同时算出四个窗口：今日（本地 00:00 起）、最近 5 小时、最近 7 天、本月。
 * 数值是**按单价表本地计价**的估算，不等于 OpenCode 控制台的账单口径；
 * 只覆盖本机 DSH 的流量，其它客户端（OpenCode CLI/TUI 等）不计入。
 *
 * @param options - `{ sessionsRoot, now }`。
 * @returns `{ now, today, rolling5h, weekly, monthly, scannedFiles }`。
 */
export function summarizeSpend(options) {
  const now = options && Number.isFinite(options.now) ? options.now : Date.now()
  const sessionsRoot =
    options && options.sessionsRoot
      ? options.sessionsRoot
      : path.join(process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), 'sessions')

  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)

  // 起算时间：今日是本地 00:00，其余按窗口长度回推。
  const buckets = {
    today: makeBucket(dayStart.getTime()),
    rolling5h: makeBucket(now - ROLLING_WINDOW_MS),
    weekly: makeBucket(now - WEEK_MS),
    monthly: makeBucket(dayStart.getTime()), // 与"本月"近似：对齐到本地月初
  }
  // monthly 单独对齐到本地本月 1 日 00:00，避免用 dayStart 冒充。
  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  buckets.monthly.since = monthStart.getTime()

  // 最早的起算点：早于它的文件一定没有任何窗口的数据，可以直接跳过。
  const earliest = Math.min(
    buckets.today.since,
    buckets.rolling5h.since,
    buckets.weekly.since,
    buckets.monthly.since,
  )

  // 统计到的最新用量事件时间（epoch 毫秒），0 表示没扫到任何用量。
  let latestEventAt = 0
  const files = collectSessionFiles(sessionsRoot)
  for (const file of files) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (stat.mtimeMs < earliest) continue

    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      continue
    }
    const text = decodeSessionLog(buffer)
    if (text === '') continue

    let route = null
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      // 旧格式：request/header 建立路由，随后的 assistant/chunk 带 usage。
      if (event.type === 'request/header') {
        const config = event.data && event.data.header ? event.data.header.config : null
        route = config ? { provider: config.provider, model: config.model } : null
        continue
      }

      // ── 新格式（session.v3.jsonl.zstd）──────────────────────────────────
      // v3 把 usage 提到了事件顶层 `data.usage`，路由信息则内联在
      // `data.message.source.{provider,model}`。注意：
      //   · 不能用 `data.stream[].chunk.usage` —— 那是同一份数据的副本，
      //     读它会让金额翻倍；
      //   · provider 取自事件自身，不依赖前面是否出现过 request/header
      //     （v3 里 request/header 极少）。
      if (event.type === 'assistant/message') {
        const usage = event.data ? event.data.usage : null
        if (!usage) continue
        if (typeof event.time !== 'number') continue
        const message = event.data ? event.data.message : null
        const source = message && message.source ? message.source : null
        if (!source || source.provider !== TRACKED_PROVIDER) continue
        if (event.time > latestEventAt) latestEventAt = event.time
        accumulate(buckets, event.time, priceUsage(usage, isPeakHour(event.time)), usage)
        continue
      }

      // 旧格式的 usage 载体。
      if (event.type !== 'assistant/chunk') continue
      const chunk = event.data ? event.data.chunk : null
      if (!chunk || chunk.type !== 'usage') continue
      if (route === null || route.provider !== TRACKED_PROVIDER) continue
      if (typeof event.time !== 'number') continue
      // 记录统计到的最新用量时间，供界面判断数据新鲜度。
      if (event.time > latestEventAt) latestEventAt = event.time

      accumulate(buckets, event.time, priceUsage(chunk.usage || {}, isPeakHour(event.time)), chunk.usage || {})
    }
  }

  const shape = (bucket) => ({
    since: new Date(bucket.since).toISOString(),
    costUsd: Number(bucket.costUsd.toFixed(6)),
    attempts: bucket.attempts,
    peakAttempts: bucket.peakAttempts,
    tokens: { input: bucket.input, output: bucket.output, cacheRead: bucket.cacheRead },
  })

  return {
    now: new Date(now).toISOString(),
    today: shape(buckets.today),
    rolling5h: shape(buckets.rolling5h),
    weekly: shape(buckets.weekly),
    monthly: shape(buckets.monthly),
    scannedFiles: files.length,
    /**
     * 统计到的最新一条用量事件的时间（epoch 毫秒）。
     *
     * 为什么需要它：DSH 是**攒批**写会话日志的，当前正在进行的会话最新数据
     * 可能落后几分钟到几十分钟。不了解这一点，就会把「本机数字比官方小」
     * 误当成插件算错。界面据此判断新鲜度，滞后的窗口不再冒充精确值。
     */
    latestEventAt,
  }
}

/**
 * 兼容入口：只要"今天"这一块时用它。
 *
 * @param options - 同 {@link summarizeSpend}。
 * @returns 今日统计（含 attempts/tokens），并附带各窗口以便复用同一次扫描。
 */
export function summarizeTodaySpend(options) {
  const all = summarizeSpend(options)
  return { ...all.today, windows: { rolling5h: all.rolling5h, weekly: all.weekly, monthly: all.monthly } }
}
