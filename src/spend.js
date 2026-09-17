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
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl.zstd')) files.push(full)
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
      if (event.type === 'request/header') {
        const config = event.data && event.data.header ? event.data.header.config : null
        route = config ? { provider: config.provider, model: config.model } : null
        continue
      }
      if (event.type !== 'assistant/chunk') continue
      const chunk = event.data ? event.data.chunk : null
      if (!chunk || chunk.type !== 'usage') continue
      if (route === null || route.provider !== TRACKED_PROVIDER) continue
      if (typeof event.time !== 'number') continue

      const usage = chunk.usage || {}
      const peak = isPeakHour(event.time)
      const cost = priceUsage(usage, peak)

      for (const bucket of Object.values(buckets)) {
        if (event.time < bucket.since) continue
        bucket.costUsd += cost
        bucket.attempts += 1
        if (peak) bucket.peakAttempts += 1
        bucket.input += Number(usage.inputTokens) || 0
        bucket.output += Number(usage.outputTokens) || 0
        bucket.cacheRead += Number(usage.cacheReadTokens) || 0
      }
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
