// dsh-quota — 客户端（浏览器端）。
//
// 打包格式（client-modules 协议）：经典脚本，通过 window.__ModuleLoader__.load({id, factory})
// 注册工厂；factory 拿到 require 并返回插件导出。id 必须等于包名。
// 只用 React.createElement，不引入任何外部资源，也不访问任何外部域名：
// 所有请求都是本机同源相对路径 /__dsh-quota/*。
//
// 界面位置：composer 底部工具行右侧（`conversation.input.right`，list slot）——
// 也就是输入框下方、模型选择器/上下文表左侧的那一撮，属于官方支持的插槽。
// 额度数据全部由宿主半侧抓取，浏览器永远看不到 API key。
//
// 关于百分比：直接展示 **上游官方整数**（如 10%），与官方控制台完全一致。
// 不再使用本机估算的小数——本机统计只覆盖 DSH 自身流量，不含 Claude Code 等
// 其它客户端，且单价可能随上游调整，两者天然对不上。

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
        goHint: '百分比取自上游官方数据，与官方控制台一致。',
        srcOfficial: '官方',
        srcLocal: '本机',
        srcOfficialHint: '百分比取自上游官方数据，与官方控制台一致，但不含小数。',
        srcLocalHint: '百分比按本机会话日志实测金额 ÷ 预算计算，含一位小数；只统计本机 DSH 流量，不含 Claude Code 等其它客户端，因此通常低于官方值。',
        srcSwitchHint: '数据源：{current}（点击切换）',
        localStaleHint: '本机统计滞后约 {n} 分钟（会话日志攒批落盘），已改用官方百分比。',
        localStaleShort: '本机统计滞后 {n} 分钟',
        todayTitle: '今天',
        requests: '{n} 次请求',
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
        goHint: 'Percentages come from the upstream API and match the official console.',
        srcOfficial: 'Official',
        srcLocal: 'Local',
        srcOfficialHint: 'Percentages come from the upstream API and match the official console, but are integers only.',
        srcLocalHint: 'Percentages are measured locally (spend ÷ budget, one decimal); DSH traffic only, so usually lower than the official value.',
        srcSwitchHint: 'Source: {current} (click to switch)',
        localStaleHint: 'Local stats lag by ~{n} min (logs flush in batches), so the official percentage is shown.',
        localStaleShort: 'Local stats {n} min behind',
        todayTitle: 'Today',
        requests: '{n} requests',
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

    // --- 数据源（官方 / 本机）-----------------------------------------------------

    /** 数据源标识。 */
    const SOURCE_OFFICIAL = 'official'
    const SOURCE_LOCAL = 'local'

    /** localStorage 键：记住用户（或自动判定）选定的数据源。 */
    const SOURCE_KEY = 'dsh-quota:source'

    /** 默认判定阈值：两个来源的百分比差额超过它就选官方（百分点）。 */
    const AUTO_SWITCH_GAP = 1

    /**
     * 读取已保存的数据源。
     *
     * @returns `'official'` / `'local'`；未保存过返回 null。
     */
    function readSavedSource() {
      try {
        const raw = window.localStorage.getItem(SOURCE_KEY)
        if (raw === SOURCE_OFFICIAL || raw === SOURCE_LOCAL) return raw
      } catch {
        /* localStorage 不可用（隐私模式等） */
      }
      return null
    }

    /** 保存数据源选择。 */
    function saveSource(source) {
      try {
        window.localStorage.setItem(SOURCE_KEY, source)
      } catch {
        /* 忽略写入失败 */
      }
    }

    /**
     * 首次使用时自动判定数据源。
     *
     * 规则：任一侧数据缺失时用官方（官方永远权威）；
     * 两边都有数据时，取三个窗口里「官方 − 本机」的最大差额，
     * 超过 {@link AUTO_SWITCH_GAP} 个百分点就用官方
     * —— 说明本机统计漏掉了其它客户端的流量，本机值不可信。
     *
     * @param windows - 宿主返回的三个窗口。
     * @returns `'official'` 或 `'local'`。
     */
    function autoPickSource(windows) {
      if (!windows) return SOURCE_OFFICIAL

      // 先看数据新鲜度：会话日志是攒批落盘的，正在进行中的会话最新用量
      // 可能还没写进日志。此时本机数字天然偏小，不能据此认为官方"不准"，
      // 直接以官方为准（官方是权威来源，本机金额只作补充）。
      let maxLag = 0
      let anyStale = false
      for (const key of ['rolling', 'weekly', 'monthly']) {
        const w = windows[key]
        if (!w) continue
        if (w.localStale === true) anyStale = true
        const lag = Number(w.lagMinutes)
        if (Number.isFinite(lag) && lag > maxLag) maxLag = lag
      }
      if (anyStale) return SOURCE_OFFICIAL

      let maxGap = 0
      let compared = 0
      for (const key of ['rolling', 'weekly', 'monthly']) {
        const w = windows[key]
        if (!w) continue
        const official = Number(w.percent)
        const local = Number(w.measuredPercent)
        if (!Number.isFinite(official) || !Number.isFinite(local)) continue
        compared += 1
        const gap = Math.abs(official - local)
        if (gap > maxGap) maxGap = gap
      }
      // 一个可比较的窗口都没有（缺上游或缺本机数据）→ 用官方。
      if (compared === 0) return SOURCE_OFFICIAL
      return maxGap > AUTO_SWITCH_GAP ? SOURCE_OFFICIAL : SOURCE_LOCAL
    }

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
     * 百分比：按当前数据源格式化。
     *
     * - 官方：上游整数（如 "10%"），与官方控制台一致；
     * - 本机：实测金额 ÷ 预算（如 "9.9%"），含一位小数；
     *   本机值缺失时退回上游整数，不补零假装精度。
     *
     * @param window - 宿主返回的窗口对象。
     * @param source - 当前数据源。
     * @returns 形如 "10%" 或 "9.9%"。
     */
    function fmtWindowPercent(window, source) {
      if (source === SOURCE_LOCAL) {
        const measured = Number(window.measuredPercent)
        if (Number.isFinite(measured)) return `${measured.toFixed(1)}%`
      }
      const raw = Number(window.percent)
      return `${Number.isFinite(raw) ? Math.round(raw) : 0}%`
    }

    function fmtTokens(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(n)
    }

    function fmtUsd(value) {
      const n = Number(value)
      return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`
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
      rowValue: { width: 52, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      rowUsd: { width: 84, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 11, opacity: 0.75 },
      todayRow: { display: 'flex', alignItems: 'baseline', gap: 8 },
      todayValue: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
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
      srcBtn: {
        padding: '1px 8px',
        fontSize: 11,
        borderRadius: 999,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        lineHeight: 1.6,
      },
    }

    /** 按用量着色：低用量中性，越高越警示。 */
    function fillColor(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #e5484d)'
      if (percent >= 70) return 'var(--dsw-alias-state-warning-primary, #e6a23c)'
      return 'var(--dsw-alias-state-business-primary, #4a7cff)'
    }

    /**
     * 进度条与着色用的数值。按数据源取值，本机源缺值时退回官方整数。
     *
     * @param window - 宿主返回的窗口对象。
     * @param source - 当前数据源。
     * @returns 用于宽度与配色的百分数。
     */
    function effectivePercent(window, source) {
      if (source === SOURCE_LOCAL) {
        const measured = Number(window.measuredPercent)
        if (Number.isFinite(measured)) return measured
      }
      const raw = Number(window.percent)
      return Number.isFinite(raw) ? raw : 0
    }

    function WindowRow({ label, window, source }) {
      if (!window) {
        return React.createElement(
          'div',
          { style: { ...styles.row, marginBottom: 8 } },
          React.createElement('span', { style: styles.rowLabel }, label),
          React.createElement('span', { style: { ...styles.muted, flex: 1 } }, '—'),
        )
      }
      const percent = effectivePercent(window, source)
      // 金额只有本机模式才有：上游只返回整数百分比，不提供任何美元信息。
      const hasUsd =
        source === SOURCE_LOCAL &&
        typeof window.measuredUsd === 'number' &&
        typeof window.budgetUsd === 'number'
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
          hasUsd
            ? React.createElement(
                'span',
                { style: styles.rowUsd },
                `${fmtUsd(window.measuredUsd)} / ${fmtUsd(window.budgetUsd)}`,
              )
            : null,
          React.createElement('span', { style: styles.rowValue }, fmtWindowPercent(window, source)),
        ),
        React.createElement(
          'div',
          { style: styles.reset },
          fmtRemain(window.resetsAt) || '',
        ),
      )
    }

    /**
     * 错误边界：插件渲染或运行时抛错时兜底，避免拖垮 composer 整棵子树。
     *
     * 为什么需要：本插件注册在 `conversation.input.right` 插槽，该插槽位于输入框
     * （composer）区域。React 中一个组件抛错会卸载整棵父树，导致输入框与工作区
     * 面板一起消失、必须刷新页面才能恢复。包一层 error boundary 后，插件自身
     * 出错只显示一个小标记，界面其余部分不受影响。
     */
    class QuotaBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        // 只记录到控制台，不打扰用户。
        try {
          console.error('[dsh-quota] 渲染失败，已降级显示：', error)
        } catch {
          /* console 不可用 */
        }
      }

      render() {
        if (this.state.failed) {
          return React.createElement(
            'span',
            {
              style: styles.muted,
              title: 'dsh-quota 渲染失败，刷新页面可重试',
            },
            '!',
          )
        }
        return this.props.children
      }
    }

    function QuotaBadge() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [open, setOpen] = useState(false)
      /** 当前数据源；null 表示尚未判定（首次拿到数据后自动选一次）。 */
      const [source, setSource] = useState(() => readSavedSource())
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

      // 三个窗口里最大的数据滞后分钟数（后端按每个窗口给出 lagMinutes）。
      // 用来在界面上解释「本机金额为什么偏小」，避免被误读成统计错误。
      const maxLagMinutes = (() => {
        if (windows === null) return null
        let max = 0
        for (const key of ['rolling', 'weekly', 'monthly']) {
          const w = windows[key]
          if (!w) continue
          const lag = Number(w.lagMinutes)
          if (Number.isFinite(lag) && lag > max) max = lag
        }
        return max > 0 ? max : null
      })()

      // 首次拿到窗口数据时自动判定数据源，并记住结果（之后不再自动改）。
      useEffect(() => {
        if (source !== null || windows === null) return
        const picked = autoPickSource(windows)
        saveSource(picked)
        setSource(picked)
      }, [source, windows])
      const balance =
        state && state.deepseek && state.deepseek.status === 'ok' && Array.isArray(state.deepseek.balances)
          ? state.deepseek.balances[0]
          : null
      // 本机花费（仅本机模式展示）：上游不提供金额，这部分完全来自本机统计。
      const spend = state && state.spend && state.spend.status === 'ok' ? state.spend : null
      const today = spend !== null && spend.today ? spend.today : null

      // 胶囊读数：三个窗口。
      let summary = null
      let tone = 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))'
      if (error !== null) {
        summary = React.createElement('span', { style: { ...styles.muted, ...styles.err } }, '!')
        tone = 'var(--dsw-alias-state-error-primary, #e5484d)'
      } else if (windows !== null) {
        const activeSource = source === null ? SOURCE_OFFICIAL : source
        tone = fillColor(windows.monthly ? effectivePercent(windows.monthly, activeSource) : 0)
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
          parts.push(
            React.createElement(
              'span',
              { key },
              fmtWindowPercent(window, source === null ? SOURCE_OFFICIAL : source),
            ),
          )
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
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement(
              'button',
              {
                type: 'button',
                style: styles.srcBtn,
                title: t('srcSwitchHint', {
                  current: (source === null ? SOURCE_OFFICIAL : source) === SOURCE_OFFICIAL
                    ? t('srcOfficial')
                    : t('srcLocal'),
                }),
                onClick: () => {
                  const next = (source === null ? SOURCE_OFFICIAL : source) === SOURCE_OFFICIAL
                    ? SOURCE_LOCAL
                    : SOURCE_OFFICIAL
                  saveSource(next)
                  setSource(next)
                },
              },
              (source === null ? SOURCE_OFFICIAL : source) === SOURCE_OFFICIAL
                ? t('srcOfficial')
                : t('srcLocal'),
            ),
            React.createElement(
              'span',
              { style: { ...styles.muted, fontSize: 11 } },
              state ? fmtClock(state.fetchedAt) : '—',
            ),
          ),
        ),

        // 今日花费（仅本机模式：上游不提供金额）
        (source === null ? SOURCE_OFFICIAL : source) === SOURCE_LOCAL
          ? React.createElement(
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
            )
          : null,

        // Go 窗口额度
        React.createElement(
          'div',
          { style: styles.group },
          React.createElement('div', { style: styles.groupTitle }, t('goTitle')),
          // 数据滞后提示：会话日志攒批落盘，正在进行的会话最新用量还没写进日志。
          // 此时本机金额天然偏小，必须解释清楚，否则会被误读成「统计算错了」。
          maxLagMinutes !== null && maxLagMinutes > 10
            ? React.createElement(
                'div',
                { style: { ...styles.muted, fontSize: 11, marginBottom: 6 } },
                t('localStaleHint', { n: maxLagMinutes }),
              )
            : null,
          windows !== null
            ? React.createElement(
                'div',
                null,
                React.createElement(WindowRow, {
                  label: t('window5h'),
                  window: windows.rolling,
                  source: source === null ? SOURCE_OFFICIAL : source,
                }),
                React.createElement(WindowRow, {
                  label: t('weekly'),
                  window: windows.weekly,
                  source: source === null ? SOURCE_OFFICIAL : source,
                }),
                React.createElement(WindowRow, {
                  label: t('monthly'),
                  window: windows.monthly,
                  source: source === null ? SOURCE_OFFICIAL : source,
                }),
              )
            : React.createElement('div', { style: styles.muted }, go === null ? t('loading') : statusText(go)),
          React.createElement(
            'div',
            { style: styles.hint },
            (source === null ? SOURCE_OFFICIAL : source) === SOURCE_OFFICIAL
              ? t('srcOfficialHint')
              : t('srcLocalHint'),
          ),
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

    /** 带错误边界的插件根组件。 */
    function QuotaGuard() {
      return React.createElement(QuotaBoundary, null, React.createElement(QuotaBadge, null))
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
          QuotaGuard,
        ),
      )
    }

    return { apply, inject: ['slots'] }
  },
})
