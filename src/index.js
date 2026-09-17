// dsh-quota — 宿主端（Host half）。
//
// 目的：在 Web GUI 里显示"当前所用大模型的订阅额度"与"今天花了多少美刀"。
//
// 数据来源（每条都可缺失，缺失即优雅降级，不报错、不阻塞）：
//   OpenCode Go 额度 —— GET https://opencode.ai/zen/go/v1/usage
//                  返回 rolling(5h) / weekly / monthly 三个窗口的 **整数** percent + resetsAt
//                  鉴权：OPENCODE_API_KEY（Bearer）
//                  （实测响应体只有 usage.<window>.{status,percent,resetsAt}；
//                   没有按天数据：/usage/daily、/billing、/credits、/spend 均 404，
//                   查询参数 window/granularity/period 一律被忽略。）
//   DeepSeek 官方余额 —— GET https://api.deepseek.com/user/balance
//                  返回余额（CNY/USD），用于按量付费的 d1 / deepseek 路线
//                  鉴权：DEEPSEEK_API_KEY（Bearer）
//   本机花费 —— spend.js 从本地会话日志按 DeepSeek V4.1 Flash 在 Go 上的单价计价，
//              一次扫描同时给出今日 / 最近 5 小时 / 最近 7 天 / 本月四个窗口。
//
// 关于小数位：上游百分比是整数，所以"5.7%"不可能直接来自上游。
// 这里的做法是——用**本机实测金额 ÷ 窗口预算**得出真实小数（例如 $0.70/$12 = 5.9%），
// 同时保留上游整数百分比作为权威锚点，两者一起展示，不做无意义的补零。
//
// 本机端点（只有相对路径，浏览器同源访问，不涉及任何第三方跨域请求）：
//   GET  /__dsh-quota/state    读取缓存后的快照（必要时按 TTL 刷新）
//   POST /__dsh-quota/refresh  强制刷新（忽略额度 TTL；花费 TTL 单独控制）
//
// 安全边界：
//   * API key 只在宿主进程中解析与使用，绝不进入任何响应体、日志或客户端代码；
//   * 上游返回体只取出 percent / resetsAt / 余额字段，其余原样丢弃；
//   * 上游失败只暴露粗粒度原因（无 key / 鉴权失败 / 上游错误 / 超时 / 结构不符），
//     不回显上游响应正文。

import { V41_WINDOW_BUDGET_USD, summarizeSpend } from './spend.js'

export const name = 'dsh-quota'

// webServer 是软依赖：通过 ctx.get / ctx.inject 惰性获取，
// 这样即使服务缺失插件也只是空转，不会让整个 web 启动检查失败。
export const inject = []

const ROUTE_PREFIX = '/__dsh-quota'
const CACHE_TTL_MS = 60 * 1000
/** 花费统计要解压会话日志，比额度接口贵，单独用更长的 TTL。 */
const SPEND_TTL_MS = 5 * 60 * 1000
const UPSTREAM_TIMEOUT_MS = 12 * 1000

const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

// --- 小工具 ------------------------------------------------------------------

function logLine(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(message)
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 解析一个凭据引用：优先走 ctx.credentials（DSH 凭据服务，支持 env / 文件 / 项目层），
 * 拿不到再退回进程环境变量。只返回值本身，绝不写日志。
 *
 * @param ctx - cordis 上下文。
 * @param ref - 形如 `OPENCODE_API_KEY` 的引用名。
 * @returns 凭据值，或 undefined。
 */
async function resolveSecret(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved && typeof resolved.value === 'string' && resolved.value.trim().length > 0) {
        return resolved.value.trim()
      }
      // 凭据服务明确回答"没有"，就不再猜环境变量，避免绕过用户的凭据配置。
      return undefined
    } catch {
      /* 凭据服务不可用或引用非法：退回环境变量 */
    }
  }
  const fromEnv = process.env[ref]
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined
}

/** 只保留可解析的时间戳（ISO 字符串）。 */
function isoOrNull(value) {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function percentOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

/** 把上游错误统一成粗粒度状态，避免把响应正文带到客户端。 */
function classifyFailure(response) {
  if (response.status === 401 || response.status === 403) {
    return { status: 'unauthorized', httpStatus: response.status }
  }
  return { status: 'upstream-error', httpStatus: response.status }
}

function classifyThrow(error) {
  const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
  return { status: timedOut ? 'timeout' : 'unreachable' }
}

// --- 上游：OpenCode Go 额度 ---------------------------------------------------

/**
 * 把一个窗口归一化，并附上本地实测金额（上游只给整数百分比，金额来自 spend.js）。
 *
 * @param raw - 上游 `usage.<window>` 对象。
 * @param local - 该窗口的本机统计（可为 undefined）。
 * @returns 归一化窗口，或 null（结构不符）。
 */
function normalizeWindow(raw, local) {
  if (!raw || typeof raw !== 'object') return null
  const percent = percentOrNull(raw.percent)
  if (percent === null) return null

  const budgetUsd = typeof local === 'object' && local !== null ? local.budgetUsd : null
  const measuredUsd = typeof local === 'object' && local !== null ? local.costUsd : null
  return {
    /** 上游给的整数百分比：权威值。 */
    percent,
    resetsAt: isoOrNull(raw.resetsAt),
    status: typeof raw.status === 'string' ? raw.status : null,
    /** 本机实测金额（美元）。 */
    measuredUsd,
    budgetUsd,
    /**
     * 有本机实测金额时给出真实小数百分比（金额 ÷ 预算）；
     * 拿不到本机数据时为 null —— 此时界面只显示上游整数，不会补零假装精度。
     */
    measuredPercent:
      typeof measuredUsd === 'number' && typeof budgetUsd === 'number' && budgetUsd > 0
        ? Number(((measuredUsd / budgetUsd) * 100).toFixed(1))
        : null,
  }
}

/**
 * 读取 OpenCode Go 的订阅额度。没有 key 时返回 `no-credential`，不抛错。
 *
 * @param ctx - cordis 上下文。
 * @param spend - 本机花费统计（可能为 null）。
 * @returns 快照对象（永远带 `status` 字段）。
 */
async function readOpenCodeGo(ctx, spend) {
  const apiKey = await resolveSecret(ctx, 'OPENCODE_API_KEY')
  if (apiKey === undefined) {
    return { status: 'no-credential', credentialRef: 'OPENCODE_API_KEY' }
  }

  let response
  try {
    response = await fetch(OPENCODE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        // Go 官方要求编码代理流量带自己的会话标识（见 docs/go 的 "Where can I use it?"）。
        'x-opencode-session': 'dsh-quota/dsh',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    return classifyThrow(error)
  }

  if (!response.ok) return classifyFailure(response)

  let payload
  try {
    payload = await response.json()
  } catch {
    return { status: 'bad-payload' }
  }

  const usage = payload && typeof payload === 'object' ? payload.usage : undefined
  if (!usage || typeof usage !== 'object') return { status: 'bad-payload' }

  const measured = measureWindows(spend)
  const windows = {
    rolling: normalizeWindow(usage.rolling, measured.rolling),
    weekly: normalizeWindow(usage.weekly, measured.weekly),
    monthly: normalizeWindow(usage.monthly, measured.monthly),
  }
  if (windows.rolling === null && windows.weekly === null && windows.monthly === null) {
    return { status: 'bad-payload' }
  }

  return {
    status: 'ok',
    windows,
    // 金额与单价都只针对 V4.1 Flash，界面按这个口径展示。
    pricing: { model: 'deepseek-v4.1-flash', budgets: V41_WINDOW_BUDGET_USD, source: 'docs' },
  }
}

/**
 * 把本机四个窗口映射到上游的三个窗口名，并带上各自的预算。
 *
 * 本机的 weekly 用"最近 7 天"，monthly 用"本月 1 日至今"，
 * 与上游的重置口径不完全一致，所以只作为小数位的来源，整数百分比仍以上游为准。
 *
 * @param spend - summarizeSpend 的结果，或 null。
 * @returns `{ rolling, weekly, monthly }`，每项为 `{ costUsd, budgetUsd }` 或 null。
 */
function measureWindows(spend) {
  if (!spend || typeof spend !== 'object') return { rolling: null, weekly: null, monthly: null }
  const pick = (bucket, budget) =>
    bucket && typeof bucket.costUsd === 'number' ? { costUsd: bucket.costUsd, budgetUsd: budget } : null
  return {
    rolling: pick(spend.rolling5h, V41_WINDOW_BUDGET_USD.rolling),
    weekly: pick(spend.weekly, V41_WINDOW_BUDGET_USD.weekly),
    monthly: pick(spend.monthly, V41_WINDOW_BUDGET_USD.monthly),
  }
}

// --- 上游：DeepSeek 余额 ------------------------------------------------------

/**
 * 读取 DeepSeek 官方账号余额。注意这是按量付费余额，不是订阅额度。
 *
 * @param ctx - cordis 上下文。
 * @returns 快照对象（永远带 `status` 字段）。
 */
async function readDeepSeekBalance(ctx) {
  const apiKey = await resolveSecret(ctx, 'DEEPSEEK_API_KEY')
  if (apiKey === undefined) {
    return { status: 'no-credential', credentialRef: 'DEEPSEEK_API_KEY' }
  }

  let response
  try {
    response = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    return classifyThrow(error)
  }

  if (!response.ok) return classifyFailure(response)

  let payload
  try {
    payload = await response.json()
  } catch {
    return { status: 'bad-payload' }
  }

  const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : null
  if (infos === null) return { status: 'bad-payload' }

  return {
    status: 'ok',
    isAvailable: payload.is_available === true,
    // 只保留币种与余额字符串，丢弃上游其余字段。
    balances: infos
      .filter((row) => row && typeof row.currency === 'string')
      .map((row) => ({
        currency: row.currency,
        total: typeof row.total_balance === 'string' ? row.total_balance : null,
      })),
  }
}

// --- 快照缓存 ----------------------------------------------------------------

let cache = null // { at: number, body: object }
let inflight = null
let spendCache = null // { at: number, value: object }

/**
 * 取本机花费统计（带 5 分钟 TTL）。同步解压会话日志，靠 TTL 挡住绝大多数调用。
 *
 * @param force - 是否忽略 TTL。
 * @returns 统计结果，或 null。
 */
function readSpend(force) {
  if (!force && spendCache !== null && Date.now() - spendCache.at < SPEND_TTL_MS) {
    return spendCache.value
  }
  try {
    const value = summarizeSpend({})
    spendCache = { at: Date.now(), value }
    return value
  } catch {
    return null
  }
}

/**
 * 组装一次完整快照（上游两项并发，花费统计本地同步完成）。
 *
 * @param ctx - cordis 上下文。
 * @param route - 客户端报告的当前路由，仅用于回显排查。
 * @param forceSpend - 是否强制重算本机花费。
 * @returns 快照响应体。
 */
async function buildSnapshot(ctx, route, forceSpend) {
  const spend = readSpend(forceSpend === true)
  const [openCodeGo, deepseek] = await Promise.all([readOpenCodeGo(ctx, spend), readDeepSeekBalance(ctx)])
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    ttlMs: CACHE_TTL_MS,
    spendTtlMs: SPEND_TTL_MS,
    route: route && typeof route === 'object' ? { provider: route.provider ?? null, model: route.model ?? null } : null,
    opencodego: openCodeGo,
    deepseek,
    spend: spend === null ? { status: 'error' } : { status: 'ok', ...spend },
  }
}

/**
 * 取快照：额度按 60 秒 TTL；`force=true` 时同时重算本机花费。
 *
 * @param ctx - cordis 上下文。
 * @param options - `{ force, route }`。
 * @returns 快照响应体。
 */
async function getSnapshot(ctx, options) {
  const force = options !== undefined && options.force === true
  const route = options === undefined ? null : options.route
  const spendStale = spendCache === null || Date.now() - spendCache.at >= SPEND_TTL_MS

  if (!force && !spendStale && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    // 缓存命中时只回显调用方报告的路由，不触发任何上游请求。
    if (route && typeof route.provider === 'string') {
      cache.body.route = { provider: route.provider ?? null, model: route.model ?? null }
    }
    return cache.body
  }
  if (inflight !== null) return inflight

  inflight = buildSnapshot(ctx, route, force)
    .then((body) => {
      cache = { at: Date.now(), body }
      return body
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * 从查询串里取出 route 信息（客户端带上当前 provider/model，仅用于回显）。
 *
 * @param url - 请求 URL。
 * @returns `{ provider, model }`。
 */
function readRoute(url) {
  try {
    const parsed = new URL(url, 'http://127.0.0.1')
    return {
      provider: parsed.searchParams.get('provider') || null,
      model: parsed.searchParams.get('model') || null,
    }
  } catch {
    return { provider: null, model: null }
  }
}

// --- 插件入口 ----------------------------------------------------------------

export function apply(ctx) {
  async function handleState(req, res) {
    try {
      sendJson(res, 200, await getSnapshot(ctx, { force: false, route: readRoute(req.url) }))
    } catch (error) {
      logLine(ctx, `[dsh-quota] state 失败: ${error && error.message ? error.message : String(error)}`)
      sendJson(res, 500, { ok: false, error: 'quota-state-failed' })
    }
  }

  async function handleRefresh(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    try {
      sendJson(res, 200, await getSnapshot(ctx, { force: true, route: readRoute(req.url) }))
    } catch (error) {
      logLine(ctx, `[dsh-quota] refresh 失败: ${error && error.message ? error.message : String(error)}`)
      sendJson(res, 500, { ok: false, error: 'quota-refresh-failed' })
    }
  }

  function registerRoutes(host) {
    const disposers = []
    for (const route of [
      { kind: 'exact', path: `${ROUTE_PREFIX}/state`, handler: handleState },
      { kind: 'exact', path: `${ROUTE_PREFIX}/refresh`, handler: handleRefresh },
    ]) {
      const dispose = host.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    if (typeof ctx.cleanup === 'function') {
      ctx.cleanup(() => {
        for (const dispose of disposers) dispose()
      })
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => {
      registerRoutes(webServer)
      return () => {}
    })
  } else {
    ctx.inject(['webServer'], (sub) => {
      sub.effect(() => {
        registerRoutes(sub.webServer)
        return () => {}
      })
    })
  }

  logLine(ctx, '[dsh-quota] 已挂载 /__dsh-quota（Go 额度 + 今日花费 + DeepSeek 余额）')
}
