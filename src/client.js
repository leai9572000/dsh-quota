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
        openHint: '点击查看明细',
        localTitle: '本机今日花费',
        localHint: '按 OpenCode Go 的单价表估算，只统计本机 DSH 的流量。其它电脑上的 DSH 用量不在其中。',
        localToday: '今天',
        localOffline: '本机统计不可用',
        localStale: '本机统计滞后约 {n} 分钟（会话日志攒批落盘）',
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
        openHint: 'Click for details',
        localTitle: 'Today on this machine',
        localHint: 'Estimated with the OpenCode Go rate card. Counts DSH traffic on this machine only; usage from your other computers is not included.',
        localToday: 'Today',
        localOffline: 'Local stats unavailable',
        localStale: 'Local stats lag by ~{n} min (session logs flush in batches)',
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

    // 原先这里有一套「官方 / 本机」数据源切换（localStorage 记忆 + 自动判定 +
    // 百分比取本机小数）。v0.3.0 已移除，原因：
    //   1. 本机金额÷预算的预算基数与官方口径对不上（实测三窗口反推出的隐含预算
    //      相差 2~2.5 倍），除出来的小数看着精确但并不准；
    //   2. 百分比只有一个权威口径 —— 上游官方整数。
    // 本机数据由宿主端计算并随快照下发，v0.3.1 起在面板里以**金额**形式展示
    // （见 LocalSpendGroup）：比率用官方、绝对值用本机，两者不混算。

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
          // 业务层错误（HTTP 200 但 body 报错）带 detail，直接展示厂商原话，
          // 否则使用者只会看到「上游返回 200」而完全不知道发生了什么。
          if (section.detail) return section.detail
          return t('upstreamError', { code: section.httpStatus === undefined ? '?' : section.httpStatus })
        case 'bad-payload':
          return t('badPayload')
        default:
          return section.status
      }
    }

    /**
     * 百分比：**一律用官方整数**（如 "10%"）。
     *
     * 为什么不再用本机金额 ÷ 预算：那个预算基数（$12/$30/$60）与官方口径对不上，
     * 实测 rolling $0.89/12 = 7.4% 而官方 6%，weekly 更是差 50 多个百分点。
     * 既然基数不可信，就不该拿它除出一个看似精确的百分比。
     * 本机数据只在面板里以**金额**形式展示。
     *
     * @param window - 宿主返回的窗口对象。
     * @returns 形如 "10%"。
     */
    function fmtWindowPercent(window) {
      const raw = Number(window.percent)
      return `${Number.isFinite(raw) ? Math.round(raw) : 0}%`
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

    /**
     * 美元金额格式化（本机分组专用）。
     *
     * 为什么要分档：本机单窗口金额跨度很大 —— 5 小时窗口常见 $0.4，
     * 月度可能到十几刀。固定两位小数会让 $0.0012 显示成 $0.00（看着像没花钱），
     * 固定四位小数又让 $12.5871 显得过于精确。所以按量级选精度。
     *
     * @param value - 美元金额。
     * @returns 形如 `$0.43` / `$0.0012` / `$12.59`。
     */
    function fmtUsd(value) {
      // 显式挡掉 null/''/布尔：Number(null) === 0，不挡会让「没有数据」显示成 $0
      // （看着像「这窗口一分钱没花」，与真实语义「没算出来」完全不同）。
      if (typeof value !== 'number' && typeof value !== 'string') return '—'
      if (value === '') return '—'
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount < 0) return '—'
      if (amount === 0) return '$0'
      if (amount < 0.01) return `$${amount.toFixed(4)}`
      return `$${amount.toFixed(2)}`
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
      // 本机分组的「金额行」：标签左、金额右，中间用点线撑开，扫一眼就能对账。
      amountRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '2px 0',
      },
      amountLabel: { flex: 'none', opacity: 0.75 },
      amountDots: {
        flex: 1,
        borderBottom: '1px dotted var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
        transform: 'translateY(-3px)',
      },
      amount: {
        flex: 'none',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 600,
      },
    }

    /** 按用量着色：低用量中性，越高越警示。 */
    function fillColor(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #e5484d)'
      if (percent >= 70) return 'var(--dsw-alias-state-warning-primary, #e6a23c)'
      return 'var(--dsw-alias-state-business-primary, #4a7cff)'
    }

    /**
     * 进度条与着色用的数值：**一律用官方整数百分比**。
     *
     * 不再取本机金额 ÷ 预算：预算基数不可信（见 fmtWindowPercent 的说明），
     * 用它算出的宽度会误导。官方整数才是权威口径。
     *
     * @param window - 宿主返回的窗口对象。
     * @returns 用于宽度与配色的百分数。
     */
    function effectivePercent(window) {
      const raw = Number(window.percent)
      return Number.isFinite(raw) ? raw : 0
    }

    /**
     * 单个额度窗口行：进度条 + 官方百分比 + 重置倒计时。
     *
     * 不再接收 source 参数：百分比只有一个权威口径（上游官方整数），
     * 本机金额与金额÷预算的小数已从界面移除（见文件上方说明）。
     *
     * @param props - `{ label, window }`。
     */
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
          React.createElement('span', { style: styles.rowValue }, fmtWindowPercent(window)),
        ),
        React.createElement(
          'div',
          { style: styles.reset },
          fmtRemain(window.resetsAt) || '',
        ),
      )
    }

    /**
     * 一行「标签 ─── 金额」的对账行。
     *
     * @param props - `{ label, value }`。
     */
    function AmountRow({ label, value }) {
      return React.createElement(
        'div',
        { style: styles.amountRow },
        React.createElement('span', { style: styles.amountLabel }, label),
        React.createElement('span', { style: styles.amountDots }),
        React.createElement('span', { style: styles.amount }, value),
      )
    }

    /**
     * 「本机今日花费」分组：只用**美刀金额**展示本机今天的花费，不画进度条、不算百分比。
     *
     * 为什么只给金额、不给百分比：预算基数（$12 / $30 / $60）虽然取自官方文档，
     * 但实测把本机金额除以它得到的百分比与官方对不上（官方 rolling 6% 而本机
     * $0.89/12 = 7.4%，weekly 更差 50 多个百分点），说明本机统计口径与官方并不一致
     * （本机只覆盖 DSH 流量，且缓存读占绝对多数）。既然比率不可信，就只给绝对金额。
     *
     * 为什么单位用美刀：与上方 OpenCode Go 的额度口径统一（Go 的限额本身就是
     * 美元定义的 —— 5 小时 = 月限额 20%、周 = 50%、月 = 100%）。
     *
     * 为什么只有「今天」一个值：额度是本机局域网外的订阅总量，换一台电脑跑 DSH
     * 就无从得知那台机器花了多少，所以多窗口的本机金额没有可对照的意义；
     * 「今天花了多少」是使用者唯一真正关心的、且本机完全可知的绝对值。
     *
     * @param props - `{ spend }`，即宿主快照里的 `spend` 字段。
     */
    function LocalSpendGroup({ spend }) {
      // 三种异常都要各自成句，否则使用者看到空白会以为插件坏了：
      //   spend 为 null       → 宿主没算（统计失败或还没跑完）
      //   latestEventAt 为 0  → 跑了，但一条 Go 用量都没扫到
      //   滞后 > 10 分钟      → 数据是旧的（DSH 攒批落盘），必须明说
      let body
      if (!spend || typeof spend !== 'object') {
        body = React.createElement('div', { style: styles.muted }, t('localOffline'))
      } else {
        const lagMinutes = (() => {
          const at = Number(spend.latestEventAt)
          if (!Number.isFinite(at) || at <= 0) return null
          return Math.max(0, Math.round((Date.now() - at) / 60000))
        })()
        const bucket = spend.today
        body = React.createElement(
          'div',
          null,
          React.createElement(AmountRow, {
            label: t('localToday'),
            value: bucket && typeof bucket === 'object' ? fmtUsd(bucket.costUsd) : '—',
          }),
          // 滞后提示只在真的滞后时才出现，正常情况不占版面。
          lagMinutes !== null && lagMinutes > 10
            ? React.createElement(
                'div',
                { style: { ...styles.muted, fontSize: 11, marginTop: 4 } },
                t('localStale', { n: lagMinutes }),
              )
            : null,
        )
      }

      return React.createElement(
        'div',
        { style: styles.group },
        React.createElement('div', { style: styles.groupTitle }, t('localTitle')),
        body,
        React.createElement('div', { style: styles.hint }, t('localHint')),
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



      // 胶囊读数：三个窗口。
      let summary = null
      let tone = 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))'
      if (error !== null) {
        summary = React.createElement('span', { style: { ...styles.muted, ...styles.err } }, '!')
        tone = 'var(--dsw-alias-state-error-primary, #e5484d)'
      } else if (windows !== null) {
        // 胶囊颜色取**三个窗口里百分比最高**的那个：真正的风险信号是
        // 「哪个窗口最接近上限」，而不是固定的 monthly —— 周一刚重置时
        // monthly 很低但 rolling/weekly 可能已经满，旧写法会把危险显示成正常。
        const worstPercent = Math.max(
          0,
          ...['rolling', 'weekly', 'monthly'].map((key) =>
            windows[key] ? effectivePercent(windows[key]) : 0,
          ),
        )
        tone = fillColor(worstPercent)
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
              fmtWindowPercent(window),
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
            { style: { ...styles.muted, fontSize: 11 } },
            state ? fmtClock(state.fetchedAt) : '—',
          ),
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
                React.createElement(WindowRow, {
                  label: t('window5h'),
                  window: windows.rolling,
                }),
                React.createElement(WindowRow, {
                  label: t('weekly'),
                  window: windows.weekly,
                }),
                React.createElement(WindowRow, {
                  label: t('monthly'),
                  window: windows.monthly,
                }),
              )
            : React.createElement('div', { style: styles.muted }, go === null ? t('loading') : statusText(go)),
          React.createElement(
            'div',
            { style: styles.hint },
            t('goHint'),
          ),
        ),

        // 本机今日花费（美刀）：绝对值口径，与上方官方百分比并列但互不换算。
        React.createElement(LocalSpendGroup, { spend: state ? state.spend : null }),

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
