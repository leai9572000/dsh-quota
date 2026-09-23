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

/**
 * webServer 是软依赖：通过 ctx.get / ctx.inject 惰性获取，
 * 这样即使服务缺失插件也只是空转，不会让整个 web 启动检查失败。
 *
 * connection 是**信任栅栏**依赖：自 0.3.0 起自定义路由先用它的
 * requestRejection(req) 拒绝伪造 Host/Origin 与未认证请求。官方插件
 * （dsh-host-open-in-app）同样声明这个依赖，这里保持一致。
 * 注意：声明了不等于运行时一定有 —— rejected() 对缺失仍是 fail-open。
 */
export const inject = ['connection']

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

/**
 * 从响应体里提炼「业务层错误」（移植自 dsh-whale-widget 的 apiBusinessError）。
 *
 * 为什么必须看：有些额度/余额接口在鉴权失败或未订阅时**仍返回 HTTP 200**，
 * 真正的错误在 body 里（如智谱的「当前用户不存在 coding plan」）。
 * 只看 res.ok 会把这种情况当成成功，再把缺失的字段当成“结构不符”，
 * 使用者拿到的提示就完全跑偏了。
 *
 * 安全约束：只回显一小段厂商错误文本（截断到 120 字），不回显完整响应体。
 *
 * @param data - 已解析的响应体。
 * @returns 错误描述；无业务错误时返回空串。
 */
function businessError(data) {
  if (!data || typeof data !== 'object') return ''
  if (data.success === false || data.ok === false) {
    return String(data.msg || data.message || data.error || 'success=false').slice(0, 120)
  }
  const code = Number(data.code)
  if (Number.isFinite(code) && code !== 0 && code !== 200 && data.msg) {
    return String(data.msg).slice(0, 120)
  }
  if (typeof data.error === 'string' && data.error) return data.error.slice(0, 120)
  if (data.error && typeof data.error === 'object' && data.error.message) {
    return String(data.error.message).slice(0, 120)
  }
  return ''
}

// --- 上游：OpenCode Go 额度 ---------------------------------------------------

/**
 * 从官方 `usage.<window>` 里只抽出对齐本机统计所需的两样东西。
 *
 * 为什么不直接用整个 raw：后续代码会把它整个传给 normalizeWindow，
 * 这里只负责给 summarizeSpend 提供 { resetsAt } 用于反推窗口起点。
 *
 * @param raw - 上游 `usage.<window>` 对象。
 * @returns `{ resetsAt }`；结构不符时返回 null。
 */
function readOfficialWindow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const resetsAt = isoOrNull(raw.resetsAt)
  return resetsAt === null ? null : { resetsAt }
}

/**
 * 把一个窗口归一化，并附上本地实测金额（上游只给整数百分比，金额来自 spend.js）。
 *
 * @param raw - 上游 `usage.<window>` 对象。
 * @param local - 该窗口的本机统计（可为 undefined）。
 * @returns 归一化窗口，或 null（结构不符）。
 */
function normalizeWindow(raw, local, latestEventAt) {
  if (!raw || typeof raw !== 'object') return null
  const percent = percentOrNull(raw.percent)
  if (percent === null) return null

  const budgetUsd = typeof local === 'object' && local !== null ? local.budgetUsd : null
  const measuredUsd = typeof local === 'object' && local !== null ? local.costUsd : null

  // 本机统计的数据滞后分钟数：会话日志是攒批落盘的，正在进行中的会话
  // 最新数据可能落后几分钟到几十分钟。滞后明显时，本机金额只能当参考，
  // 不能拿来质疑官方百分比。
  const lagMinutes =
    typeof latestEventAt === 'number' && latestEventAt > 0
      ? Math.max(0, Math.round((Date.now() - latestEventAt) / 60000))
      : null
  // 滞后超过 10 分钟就认为本机数字已经不可靠（滚动 5 小时窗口尤其敏感）。
  const localStale = lagMinutes !== null && lagMinutes > 10
  return {
    /** 上游给的整数百分比：权威值。 */
    percent,
    resetsAt: isoOrNull(raw.resetsAt),
    status: typeof raw.status === 'string' ? raw.status : null,
    /** 本机实测金额（美元）。 */
    measuredUsd,
    budgetUsd,
    /**
     * 本机实测金额÷预算得出的参考百分比（仅用于 autoPickSource 的同口径比较）。
     *
     * ⚠️ 不用于界面展示：预算基数（$12/$30/$60）与官方口径对不上，这个数字
     * 看着精确但并不准。界面百分比一律用上游官方整数，金额另外单独展示。
     */
    measuredPercent:
      typeof measuredUsd === 'number' && typeof budgetUsd === 'number' && budgetUsd > 0
        ? Number(((measuredUsd / budgetUsd) * 100).toFixed(1))
        : null,
    /** 本机统计窗口的起算时间（ISO）；用于向使用者解释口径对齐到哪一天。 */
    sinceAt: typeof local === 'object' && local !== null && typeof local.since === 'string'
      ? local.since
      : null,
    /** 本机统计相对当前时刻滞后多少分钟；null 表示没有本机数据。 */
    lagMinutes,
    /** 本机数据是否已滞后到不宜作为精确值展示。 */
    localStale,
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

  // HTTP 200 也可能是业务错误（key 失效 / 未订阅），先把它识别出来。
  const bizError = businessError(payload)
  if (bizError) return { status: 'upstream-error', httpStatus: 200, detail: bizError }

  const usage = payload && typeof payload === 'object' ? payload.usage : undefined
  if (!usage || typeof usage !== 'object') return { status: 'bad-payload' }

  // 先抽出官方的三个窗口（含 resetsAt），再用它们去对齐本机统计的起算时间。
  // 顺序很关键：官方 weekly 是自然周、monthly 是自然月，而本机原先用滑动 7 天 /
  // 本地月初 —— 口径不同导致本机 weekly 多算了 6.6 天（对官方 3% 报 56.4%）。
  const officialWindows = {
    rolling: readOfficialWindow(usage.rolling),
    weekly: readOfficialWindow(usage.weekly),
    monthly: readOfficialWindow(usage.monthly),
  }

  // 本机统计需要按官方起算点重算，所以这里传入 officialWindows。
  // 注意：调用方传进来的 spend 是按旧阈值算的，必须重算而不是复用，
  // 否则 weekly 对齐到自然周后金额仍然是旧口径的值。
  const measured = measureWindows(
    summarizeSpend({ officialWindows }),
  )
  const latestEventAt = spend && typeof spend.latestEventAt === 'number' ? spend.latestEventAt : null
  const windows = {
    rolling: normalizeWindow(usage.rolling, measured.rolling, latestEventAt),
    weekly: normalizeWindow(usage.weekly, measured.weekly, latestEventAt),
    monthly: normalizeWindow(usage.monthly, measured.monthly, latestEventAt),
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
    bucket && typeof bucket.costUsd === 'number'
      ? { costUsd: bucket.costUsd, budgetUsd: budget, since: bucket.since }
      : null
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

  // 同上：HTTP 200 也可能是业务错误（如 key 无效但接口仍回 200）。
  const bizError = businessError(payload)
  if (bizError) return { status: 'upstream-error', httpStatus: 200, detail: bizError }

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
 * 取本机花费统计（带 5 分钟 TTL）。
 *
 * ⚠️ v0.3.0 曾默认关闭（界面不展示本机金额），v0.3.1 起重新启用：
 * 面板新增「本机今日花费」一行，用美刀展示本机今天的实际花费。
 *
 * 单次要同步解压约 50 个会话日志，实测阻塞约 800ms，所以靠 5 分钟 TTL
 * 挡住绝大多数调用，只有 TTL 过期或用户点「刷新」才会重算。
 *
 * 只回传「今天」一个窗口：面板只需要今日金额（多窗口的本机值其它电脑无从得知，
 * 没有对照意义），少传三个窗口也省一点序列化开销。
 *
 * @param force - 是否忽略 TTL。
 * @returns `{ today, latestEventAt }`；失败或没有数据时返回 null。
 */
function readSpend(force) {
  if (!force && spendCache !== null && Date.now() - spendCache.at < SPEND_TTL_MS) {
    return spendCache.value
  }

  try {
    const all = summarizeSpend({})
    const value = { today: all.today, latestEventAt: all.latestEventAt }
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
  // 本机今日花费：带 5 分钟 TTL，只有 TTL 过期或用户点刷新才会重算（约 800ms）。
  const spend = readSpend(forceSpend === true)
  const openCodeGo = await readOpenCodeGo(ctx, spend)
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    ttlMs: CACHE_TTL_MS,
    route: route && typeof route === 'object' ? { provider: route.provider ?? null, model: route.model ?? null } : null,
    opencodego: openCodeGo,
    spend,
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
  /**
   * 浏览器信任栅栏（移植自 dsh-whale-widget 的做法）。
   *
   * 为什么需要：dsh 的 connection 服务提供 requestRejection(req)，用来拒绝
   * 伪造 Host/Origin（DNS 重绑定）或未认证的请求。我插件路由如果不走这道
   * 判断，任意网页都能借本机同源的服务器读写 /__dsh-quota/*，把余额与额度
   * 读走。官方插件（如 dsh-host-open-in-app）都会先调一次。
   *
   * 取舍：connection 不可用时选 fail-open（只 warn 一次后放行），
   * 而不是把整个额度面板打死 —— 但会打一条 warn 以便发现“栅栏实际失效”。
   *
   * @param req - 请求对象。
   * @param res - 响应对象。
   * @returns 已拦截返回 true（响应已结束）。
   */
  function rejected(req, res) {
    try {
      // 注意取法：官方插件用 Reflect.get(ctx, 'connection')，而不是
      // ctx.get('connection') —— 后者是惰性查找，与 cordis 注册进 ctx 的服务
      // 不是同一个通道。照搬官方写法才能真的拿到栅栏。
      const connection = ctx.get('connection') || Reflect.get(ctx, 'connection')
      if (!connection || typeof connection.requestRejection !== 'function') {
        if (!rejected.warned) {
          rejected.warned = true
          logLine(ctx, '[dsh-quota] 信任栅栏不可用：connection 服务缺失，自定义路由将放行处理')
        }
        return false
      }
      const code = connection.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      // 栅栏自身报错时不要连带把接口打挂，放行并让下游自行判断。
      return false
    }
  }

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
      // 统一在这里套上信任栅栏，避免以后新增路由忘了加。
      const inner = route.handler
      const guarded = {
        ...route,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          return inner(req, res)
        },
      }
      const dispose = host.register(guarded)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
    // 卸载清理：把 disposer 交给 ctx.effect 收集，而不是 ctx.cleanup。
    // cordis 没有 ctx.cleanup —— 它的上下文是严格白名单代理，读一个未声明的属性
    // 会直接抛 `cannot get property "cleanup" without inject`，把整棵插件树打挂
    // （0.3.0 的启动失败就死在这一行）。注册类副作用的官方写法是
    // `ctx.effect(() => host.register(...))`，由 effect 统一收集返回值。
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => registerRoutes(webServer))
  } else {
    ctx.inject(['webServer'], (sub) => {
      sub.effect(() => registerRoutes(sub.webServer))
    })
  }

  logLine(ctx, '[dsh-quota] 已挂载 /__dsh-quota（Go 额度 + 今日花费 + DeepSeek 余额）')
}
