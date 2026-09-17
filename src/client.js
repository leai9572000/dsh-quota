// dsh-quota — 客户端（浏览器端）。
//
// 打包格式（client-modules 协议）：经典脚本，通过 window.__ModuleLoader__.load({id, factory})
// 注册工厂；factory 拿到 require 并返回插件导出。id 必须等于包名。
// 只用 React.createElement，不引入任何外部资源，也不访问任何外部域名：
// 所有请求都是本机同源相对路径 /__dsh-quota/*。
//
// 界面位置：composer 底部工具行右侧（`conversation.input.right`，list slot）——
// 也就是输入框下方、模型选择器/上下文表左侧的那一撮，属于官方支持的插槽。
// 额度与花费数据全部由宿主半侧抓取/计算，浏览器永远看不到 API key。
//
// 关于小数位：上游只给整数百分比，所以这里的小数来自**本机实测金额 ÷ 窗口预算**。
// 有实测值就显示真实小数（如 5.9%），没有就显示上游整数（如 5%），
// 不会把整数补零成 "5.0" 来假装精度。

window.__ModuleLoader__.load({
  id: 'dsh-quota',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'quota'
    const ROUTE = '/__dsh-quota'
    const POLL_MS = 60 * 1000

    // --- 文案（中英双语；locale 服务不可用时按浏览器语言兜底）-----------------------

    const dict = {
      zh: {
        label: '额度',
        title: '订阅额度',
        window5h: '5 小时',
        weekly: '本周',
        monthly: '本月',
        todayTitle: '今天',
        requests: '{n} 次请求',
        loading: '读取中…',
        refresh: '刷新',
        refreshing: '刷新中…',
        resetsIn: '{n} 后重置',
        resetsSoon: '即将重置',
        noCredential: '未配置 {ref}',
        unauthorized: '鉴权失败（key 失效或未订阅）',
        unreachable: '网络不可达',
        timeout: '请求超时',
        upstreamError: '上游返回 {code}',
        badPayload: '上游返回结构不符',
        goTitle: 'OpenCode Go（DeepSeek V4.1 Flash）',
        goHint: '百分比优先取本机实测（金额÷预算，一位小数）；无实测时显示上游整数。预算：5 小时 $12 / 本周 $30 / 本月 $60。',
        upstreamInteger: '上游整数 {percent}',
        percentOfBudget: '{percent} / {budget}',
        todayHint: '按 V4.1 Flash 单价对本机会话日志计价，只含本机 DSH 流量（不含 OpenCode CLI 等其它客户端），不是账单口径。',
        tokensLabel: '输入 {input} · 输出 {output} · 缓存读 {cache}',
        peakNote: '其中 {n} 次落在高峰时段（UTC 01-04 / 06-10，周一至周五），费率翻倍。',
        deepseekTitle: 'DeepSeek 余额',
        deepseekHint: '按量付费余额，不是订阅额度',
        balance: '余额 {value}',
        openHint: '点击查看明细',
      },
      en: {
        label: 'Quota',
        title: 'Subscription quota',
        window5h: '5-hour',
        weekly: 'Weekly',
        monthly: 'Monthly',
        todayTitle: 'Today',
        requests: '{n} requests',
        loading: 'Loading…',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        resetsIn: 'resets in {n}',
        resetsSoon: 'resetting soon',
        noCredential: 'No {ref} configured',
        unauthorized: 'Unauthorized (expired key or no subscription)',
        unreachable: 'Network unreachable',
        timeout: 'Request timed out',
        upstreamError: 'Upstream returned {code}',
        badPayload: 'Unexpected upstream payload',
        goTitle: 'OpenCode Go (DeepSeek V4.1 Flash)',
        goHint: 'Percentages use the local measurement (spend ÷ budget, one decimal); the upstream integer is shown when no measurement exists. Budgets: 5-hour $12 / weekly $30 / monthly $60.',
        upstreamInteger: 'upstream {percent}',
        percentOfBudget: '{percent} / {budget}',
        todayHint: "Priced locally from this machine's session logs at V4.1 Flash rates; DSH traffic only (no OpenCode CLI), not a billing figure.",
        tokensLabel: 'in {input} · out {output} · cache-read {cache}',
        peakNote: '{n} attempts fell in peak hours (UTC 01-04 / 06-10, Mon-Fri) at double rate.',
        deepseekTitle: 'DeepSeek balance',
        deepseekHint: 'Pay-as-you-go balance, not a subscription quota',
        balance: 'Balance {value}',
        openHint: 'Click for details',
      },
    }

    function langFallback() {
      try {
        const tags = (navigator.languages || []).concat([navigator.language])
        for (const tag of tags) {
          const primary = String(tag || '').toLowerCase().split('-')[0]
          if (primary === 'zh') return 'zh'
          if (primary === 'en') return 'en'
        }
      } catch {
        /* navigator 不可用 */
      }
      return 'zh'
    }

    let localeService = null

    function t(key, params) {
      let text
      if (localeService && typeof localeService.translate === 'function') {
        const fromService = localeService.translate(NS, key)
        if (typeof fromService === 'string' && fromService !== key) text = fromService
      }
      if (text === undefined) {
        const table = dict[langFallback()] || dict.zh
        text = table[key] !== undefined ? table[key] : dict.zh[key] !== undefined ? dict.zh[key] : key
      }
      if (params) {
        for (const name of Object.keys(params)) {
          text = text.split(`{${name}}`).join(String(params[name]))
        }
      }
      return text
    }

    // --- 数据 ------------------------------------------------------------------

    async function fetchState(force) {
      const response = await fetch(force ? `${ROUTE}/refresh` : `${ROUTE}/state`, {
        method: force ? 'POST' : 'GET',
        headers: { accept: 'application/json' },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function statusText(section) {
      switch (section.status) {
        case 'no-credential':
          return t('noCredential', { ref: section.credentialRef || '' })
        case 'unauthorized':
          return t('unauthorized')
        case 'unreachable':
          return t('unreachable')
        case 'timeout':
          return t('timeout')
        case 'upstream-error':
          return t('upstreamError', { code: section.httpStatus === undefined ? '?' : section.httpStatus })
        case 'bad-payload':
          return t('badPayload')
        default:
          return section.status
      }
    }

    /**
     * 百分比：优先本机实测小数（measuredPercent = 金额 ÷ 预算），否则退回上游整数。
     * 不会把整数补零成 "5.0"。
     *
     * @param window - 宿主返回的窗口对象。
     * @returns 形如 "5.9%" 或 "5%"。
     */
    function fmtWindowPercent(window) {
      const measured = window.measuredPercent
      if (typeof measured === 'number' && Number.isFinite(measured)) return `${measured.toFixed(1)}%`
      const raw = Number(window.percent)
      return `${Number.isFinite(raw) ? Math.round(raw) : 0}%`
    }

    /** 金额：两位小数。 */
    function fmtUsd(value) {
      const n = Number(value)
      return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`
    }

    function fmtTokens(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    /** 剩余时间的人类可读形式（分钟 / 小时 / 天三档）。 */
    function fmtRemain(iso) {
      if (typeof iso !== 'string') return null
      const until = Date.parse(iso)
      if (!Number.isFinite(until)) return null
      const left = until - Date.now()
      if (left <= 0) return t('resetsSoon')
      const minutes = Math.floor(left / 60000)
      if (minutes < 60) return t('resetsIn', { n: `${minutes}m` })
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return t('resetsIn', { n: `${hours}h` })
      return t('resetsIn', { n: `${Math.floor(hours / 24)}d` })
    }

    function fmtClock(iso) {
      if (typeof iso !== 'string') return '—'
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return '—'
      const d = new Date(at)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // --- 样式（只用主题变量，跟随明暗）--------------------------------------------

    const styles = {
      root: { position: 'relative', display: 'flex', alignItems: 'center', flex: 'none' },
      trigger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 8px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      busy: { opacity: 0.6, cursor: 'default' },
      dot: { width: 6, height: 6, borderRadius: 3, flex: 'none' },
      sep: { opacity: 0.3, margin: '0 1px' },
      muted: { opacity: 0.62 },
      strong: { fontWeight: 600 },
      panel: {
        position: 'absolute',
        right: 0,
        bottom: 'calc(100% + 8px)',
        zIndex: 40,
        width: 316,
        padding: '10px 12px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
        background: 'var(--dsw-specific-tip, #2b2b2b)',
        color: 'var(--dsw-alias-text-primary, inherit)',
        boxShadow: '0 8px 28px rgba(0,0,0,.28)',
        fontSize: 12,
        lineHeight: 1.5,
        textAlign: 'left',
      },
      panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
      panelTitle: { fontWeight: 600, fontSize: 12.5 },
      group: { marginTop: 10 },
      groupTitle: { fontWeight: 600, marginBottom: 6, opacity: 0.9 },
      hint: { opacity: 0.55, fontSize: 11, marginTop: 4 },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      rowLabel: { width: 52, flex: 'none', opacity: 0.75 },
      rowUsd: { width: 88, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      rowValue: { width: 52, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      track: {
        position: 'relative',
        flex: 1,
        height: 6,
        borderRadius: 3,
        overflow: 'hidden',
        background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      },
      fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3 },
      reset: { marginTop: 2, fontSize: 11, opacity: 0.55, textAlign: 'right' },
      todayRow: { display: 'flex', alignItems: 'baseline', gap: 8 },
      todayValue: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      foot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12 },
      btn: {
        padding: '3px 10px',
        fontSize: 12,
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
      },
      err: { color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
    }

    /** 按用量着色：低用量中性，越高越警示。用实测小数（有则用），否则用整数。 */
    function fillColor(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #e5484d)'
      if (percent >= 70) return 'var(--dsw-alias-state-warning-primary, #e6a23c)'
      return 'var(--dsw-alias-state-business-primary, #4a7cff)'
    }

    /** 进度条与着色用的数值：优先实测小数。 */
    function effectivePercent(window) {
      const measured = window.measuredPercent
      if (typeof measured === 'number' && Number.isFinite(measured)) return measured
      const raw = Number(window.percent)
      return Number.isFinite(raw) ? raw : 0
    }

    function WindowRow({ label, window }) {
      if (!window) {
        return React.createElement(
          'div',
          { style: { ...styles.row, marginBottom: 8 } },
          React.createElement('span', { style: styles.rowLabel }, label),
          React.createElement('span', { style: { ...styles.muted, flex: 1 } }, '—'),
        )
      }
      const percent = effectivePercent(window)
      const hasUsd = window.measuredUsd !== null && window.measuredUsd !== undefined
      return React.createElement(
        'div',
        { style: { marginBottom: 8 } },
        React.createElement(
          'div',
          { style: styles.row },
          React.createElement('span', { style: styles.rowLabel }, label),
          React.createElement(
            'div',
            { style: styles.track },
            React.createElement('div', {
              style: { ...styles.fill, width: `${Math.min(100, percent)}%`, background: fillColor(percent) },
            }),
          ),
          React.createElement(
            'span',
            { style: styles.rowUsd },
            hasUsd ? `${fmtUsd(window.measuredUsd)} / ${fmtUsd(window.budgetUsd)}` : '—',
          ),
          React.createElement('span', { style: styles.rowValue }, fmtWindowPercent(window)),
        ),
        React.createElement(
          'div',
          { style: styles.reset },
          [
            fmtRemain(window.resetsAt) || '',
            // 同时给出上游整数，便于和官方控制台对账。
            window.measuredPercent !== null && window.measuredPercent !== undefined
              ? `　${t('upstreamInteger', { percent: `${Math.round(Number(window.percent) || 0)}%` })}`
              : '',
          ].join(''),
        ),
      )
    }

    function QuotaBadge() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)

      const load = useCallback(async (force) => {
        try {
          setError(null)
          setBusy(true)
          setState(await fetchState(force === true))
        } catch (reason) {
          setError(reason && reason.message ? reason.message : String(reason))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        void load(false)
        const timer = setInterval(() => {
          if (!open) void load(false)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load, open])

      // 点面板外部 / Esc 收起：与官方 ContextMeter 相同的收敛方式。
      useEffect(() => {
        if (!open) return
        const onPointerDown = (event) => {
          if (event.target instanceof Node && rootRef.current && rootRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const go = state && state.opencodego ? state.opencodego : null
      const windows = go && go.status === 'ok' && go.windows ? go.windows : null
      const spend = state && state.spend && state.spend.status === 'ok' ? state.spend : null
      const today = spend ? spend.today : null
      const balance =
        state && state.deepseek && state.deepseek.status === 'ok' && Array.isArray(state.deepseek.balances)
          ? state.deepseek.balances[0]
          : null

      // 胶囊读数：三个窗口 + 今日花费。
      let summary = null
      let tone = 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))'
      if (error !== null) {
        summary = React.createElement('span', { style: { ...styles.muted, ...styles.err } }, '!')
        tone = 'var(--dsw-alias-state-error-primary, #e5484d)'
      } else if (windows !== null) {
        tone = fillColor(windows.monthly ? effectivePercent(windows.monthly) : 0)
        const parts = []
        for (const [key, label] of [
          ['rolling', t('window5h')],
          ['weekly', t('weekly')],
          ['monthly', t('monthly')],
        ]) {
          const window = windows[key]
          if (!window) continue
          if (parts.length > 0) parts.push(React.createElement('span', { key: `sep-${key}`, style: styles.sep }, '·'))
          parts.push(React.createElement('span', { key: `label-${key}`, style: styles.muted }, label))
          parts.push(React.createElement('span', { key }, fmtWindowPercent(window)))
        }
        if (today !== null) {
          parts.push(React.createElement('span', { key: 'sep-today', style: styles.sep }, '·'))
          parts.push(React.createElement('span', { key: 'label-today', style: styles.muted }, t('todayTitle')))
          parts.push(React.createElement('span', { key: 'today', style: styles.strong }, fmtUsd(today.costUsd)))
        }
        summary = parts
      } else if (state !== null && go !== null) {
        summary = React.createElement('span', { style: styles.muted }, statusText(go))
        tone = 'var(--dsw-alias-state-warning-primary, #e6a23c)'
      } else {
        summary = React.createElement('span', { style: styles.muted }, t('loading'))
      }

      const trigger = React.createElement(
        'button',
        {
          type: 'button',
          style: { ...styles.trigger, ...(busy ? styles.busy : {}) },
          onClick: () => setOpen((current) => !current),
          'aria-label': t('title'),
          'aria-expanded': open,
          title: t('openHint'),
        },
        React.createElement('span', { style: { ...styles.dot, background: tone } }),
        busy && state === null ? React.createElement('span', { style: styles.muted }, t('loading')) : summary,
      )

      if (!open) return React.createElement('div', { ref: rootRef, style: styles.root }, trigger)

      const panel = React.createElement(
        'div',
        { style: styles.panel, role: 'dialog', 'aria-label': t('title') },
        React.createElement(
          'div',
          { style: styles.panelHead },
          React.createElement('span', { style: styles.panelTitle }, t('title')),
          React.createElement(
            'span',
            { style: { ...styles.muted, fontSize: 11 } },
            state ? fmtClock(state.fetchedAt) : '—',
          ),
        ),

        // 今日花费（本机统计）
        React.createElement(
          'div',
          { style: styles.group },
          React.createElement('div', { style: styles.groupTitle }, t('todayTitle')),
          today !== null
            ? React.createElement(
                'div',
                null,
                React.createElement(
                  'div',
                  { style: styles.todayRow },
                  React.createElement('span', { style: styles.todayValue }, fmtUsd(today.costUsd)),
                  React.createElement('span', { style: styles.muted }, t('requests', { n: today.attempts })),
                ),
                React.createElement(
                  'div',
                  { style: styles.muted },
                  t('tokensLabel', {
                    input: fmtTokens(today.tokens ? today.tokens.input : 0),
                    output: fmtTokens(today.tokens ? today.tokens.output : 0),
                    cache: fmtTokens(today.tokens ? today.tokens.cacheRead : 0),
                  }),
                ),
                today.peakAttempts > 0
                  ? React.createElement(
                      'div',
                      { style: { ...styles.muted, fontSize: 11 } },
                      t('peakNote', { n: today.peakAttempts }),
                    )
                  : null,
              )
            : React.createElement('div', { style: styles.muted }, t('loading')),
          React.createElement('div', { style: styles.hint }, t('todayHint')),
        ),

        // Go 窗口额度
        React.createElement(
          'div',
          { style: styles.group },
          React.createElement('div', { style: styles.groupTitle }, t('goTitle')),
          windows !== null
            ? React.createElement(
                'div',
                null,
                React.createElement(WindowRow, { label: t('window5h'), window: windows.rolling }),
                React.createElement(WindowRow, { label: t('weekly'), window: windows.weekly }),
                React.createElement(WindowRow, { label: t('monthly'), window: windows.monthly }),
              )
            : React.createElement('div', { style: styles.muted }, go === null ? t('loading') : statusText(go)),
          React.createElement('div', { style: styles.hint }, t('goHint')),
        ),

        state && state.deepseek
          ? React.createElement(
              'div',
              { style: styles.group },
              React.createElement('div', { style: styles.groupTitle }, t('deepseekTitle')),
              balance !== null
                ? React.createElement(
                    'div',
                    { style: styles.muted },
                    t('balance', { value: `${balance.total === null ? '?' : balance.total} ${balance.currency}` }),
                  )
                : React.createElement('div', { style: styles.muted }, statusText(state.deepseek)),
              React.createElement('div', { style: styles.hint }, t('deepseekHint')),
            )
          : null,

        error !== null ? React.createElement('div', { style: { ...styles.err, marginTop: 10 } }, error) : null,
        React.createElement(
          'div',
          { style: styles.foot },
          React.createElement(
            'span',
            { style: { ...styles.muted, fontSize: 11 } },
            state ? `TTL ${Math.round((state.ttlMs || 0) / 1000)}s` : '',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.btn, ...(busy ? styles.busy : {}) },
              onClick: () => void load(true),
              disabled: busy,
            },
            busy ? t('refreshing') : t('refresh'),
          ),
        ),
      )

      return React.createElement('div', { ref: rootRef, style: styles.root }, trigger, panel)
    }

    // --- 插件入口 ------------------------------------------------------------------

    function apply(ctx) {
      const locale = ctx.get('locale')
      if (locale) {
        localeService = locale
        try {
          ctx.effect(() => locale.register(NS, { zh: dict.zh, en: dict.en }), 'dsh-quota: 文案')
        } catch {
          /* 命名空间已注册：沿用既有文案 */
        }
      } else {
        ctx.inject(['locale'], (sub) => {
          localeService = sub.locale
          try {
            sub.effect(() => sub.locale.register(NS, { zh: dict.zh, en: dict.en }), 'dsh-quota: 文案')
          } catch {
            /* ignore */
          }
        })
      }

      // conversation.input.right 是 list slot：节点直接落在 composer 底部工具行里，
      // 也就是输入框下方、模型选择器与上下文表左侧的右侧区域。
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-quota',
            order: 30,
            label: () => t('label'),
            locale: NS,
          },
          QuotaBadge,
        ),
      )
    }

    return { apply, inject: ['slots'] }
  },
})
