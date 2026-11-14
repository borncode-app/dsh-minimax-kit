window.__ModuleLoader__.load({
  id: '@local/dsh-model-quota',
  factory: (require) => {
    const React = require('react')
    const NS = '@local/dsh-model-quota'
    /** Must match the Host row's `endpoint`. */
    const ENDPOINT = '/plugins/model-quota'
    /** How often the browser re-reads the cached snapshot. */
    const POLL_MS = 60000

    /** Visible text. Kept beside the exported locale resources for the same keys. */
    const dictionaries = {
      en: {
        'quota.title': 'Rate limit',
        'quota.window': '{percent}% left',
        'quota.weekly': 'wk {percent}%',
        'quota.windowLabel': '5-hour window',
        'quota.weeklyLabel': 'Weekly',
        'quota.weeklySonnetLabel': 'Weekly (Sonnet)',
        'quota.resetIn': 'Resets in',
        'quota.weeklyResetIn': 'Week resets in',
        'quota.extra': 'Extra usage',
        'quota.balance': 'Balance',
        'quota.bonus': 'Bonus credit',
      },
      th: {
        'quota.title': 'โควตาคงเหลือ',
        'quota.window': 'เหลือ {percent}%',
        'quota.weekly': 'สัปดาห์ {percent}%',
        'quota.windowLabel': 'หน้าต่าง 5 ชั่วโมง',
        'quota.weeklyLabel': 'รายสัปดาห์',
        'quota.weeklySonnetLabel': 'รายสัปดาห์ (Sonnet)',
        'quota.resetIn': 'รีเซ็ตใน',
        'quota.weeklyResetIn': 'สัปดาห์รีเซ็ตใน',
        'quota.extra': 'การใช้งานเพิ่มเติม',
        'quota.balance': 'ยอดคงเหลือ',
        'quota.bonus': 'เครดิตโบนัส',
      },
      zh: {
        'quota.title': '剩余额度',
        'quota.window': '剩余 {percent}%',
        'quota.weekly': '每周 {percent}%',
        'quota.windowLabel': '5 小时窗口',
        'quota.weeklyLabel': '每周',
        'quota.weeklySonnetLabel': '每周（Sonnet）',
        'quota.resetIn': '重置',
        'quota.weeklyResetIn': '每周重置',
        'quota.extra': '额外用量',
        'quota.balance': '余额',
        'quota.bonus': '赠送额度',
      },
    }

    /** Detail keys the Host reports, and the label each one reads. */
    const DETAIL_LABELS = {
      window: 'windowLabel',
      weekly: 'weeklyLabel',
      weeklySonnet: 'weeklySonnetLabel',
      resetIn: 'resetIn',
      weeklyResetIn: 'weeklyResetIn',
      extra: 'extra',
      balance: 'balance',
      bonus: 'bonus',
    }

    /** Our Free Model's account-quota route; the browser's own session authenticates it. */
    const OFM_SUBSCRIPTIONS = '/api/our-free-model/subscriptions'

    /** Compact "1h 20m" text for a reset time. */
    function untilText(iso) {
      const ms = typeof iso === 'string' ? Date.parse(iso) - Date.now() : Number.NaN
      if (!Number.isFinite(ms) || ms <= 0) return undefined
      const minutes = Math.round(ms / 60000)
      const days = Math.floor(minutes / 1440)
      const hours = Math.floor((minutes % 1440) / 60)
      const rest = minutes % 60
      if (days > 0) return `${days}d ${hours}h`
      return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`
    }

    /**
     * Map the Host snapshot's provider/model onto an Our Free Model channel id.
     * A model id reads `subscription:magpie/<channel>/<model>` or `<channel>/<model>`.
     */
    function channelOf(host) {
      const model = String(host?.model ?? '')
      const hit = /^(?:subscription:magpie\/)?([^/]+)\//u.exec(model)
      const channel = (hit?.[1] ?? '').toLowerCase()
      if (channel.length > 0 && channel !== 'our-free-model') return channel
      const provider = String(host?.provider ?? '').toLowerCase()
      if (provider === 'anthropic') return 'claude'
      if (provider === 'minimax-api') return 'minimax'
      return provider
    }

    /** One quota reading from Our Free Model for the selected model, or nothing. */
    async function ofmSnapshot(host) {
      if (host === undefined || host === null || host.reason === 'no-model-yet') return undefined
      let accounts
      try {
        const response = await fetch(OFM_SUBSCRIPTIONS, { headers: { accept: 'application/json' } })
        if (!response.ok) return undefined
        accounts = (await response.json())?.accounts
      } catch {
        return undefined
      }
      if (!Array.isArray(accounts)) return undefined
      const channel = channelOf(host)
      const account = accounts.find(row => row?.enabled !== false
        && (String(row?.provider ?? '').toLowerCase() === channel
          || String(row?.provider ?? '').toLowerCase().startsWith(channel)
          || channel.startsWith(String(row?.provider ?? '').toLowerCase()))
        && row?.quota?.status === 'ok')
      if (account === undefined) return undefined
      const quota = account.quota
      const windows = Array.isArray(quota.windows) ? quota.windows : []
      const five = quota.fiveHour ?? windows.find(row => row.kind === 'five_hour')
      const week = quota.weekly ?? windows.find(row => row.kind === 'weekly')
      const percent = typeof five?.remainingPercent === 'number' ? Math.round(five.remainingPercent) : undefined
      const weeklyPercent = typeof week?.remainingPercent === 'number' ? Math.round(week.remainingPercent) : undefined
      const details = []
      if (percent !== undefined) details.push({ key: 'window', value: `${percent}%` })
      const resetIn = untilText(five?.resetsAt)
      if (resetIn !== undefined) details.push({ key: 'resetIn', value: resetIn })
      if (weeklyPercent !== undefined) details.push({ key: 'weekly', value: `${weeklyPercent}%` })
      const weekResetIn = untilText(week?.resetsAt)
      if (weekResetIn !== undefined) details.push({ key: 'weeklyResetIn', value: weekResetIn })
      if (quota.balance?.amount != null && quota.balance.unlimited !== true) {
        details.push({ key: 'balance', value: `${String(quota.balance.amount)} ${String(quota.balance.unit ?? '')}`.trim() })
      }
      if (percent === undefined && weeklyPercent === undefined && details.length === 0) return undefined
      return {
        ok: true,
        kind: 'ofm-subscription',
        provider: host.provider,
        model: host.model,
        source: 'our-free-model',
        percent: percent ?? weeklyPercent,
        weeklyPercent: percent === undefined ? undefined : weeklyPercent,
        details,
        primary: percent === undefined && weeklyPercent === undefined ? details[0] : undefined,
      }
    }

    /** Fill `{name}` placeholders from one values object. */
    function format(text, values) {
      if (values === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (match, name) => (values[name] === undefined ? match : String(values[name])))
    }

    const styles = {
      anchor: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '20px',
        padding: '0 2px',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        border: 'none',
        background: 'none',
      },
      label: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
      },
      separator: {
        opacity: 0.5,
        padding: '0 1px',
      },
    }

    /** A small gauge glyph whose ring shows how much of the quota remains. */
    function GaugeIcon({ percent }) {
      const remains = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 100
      return React.createElement(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        React.createElement('circle', {
          cx: 12, cy: 12, r: 9,
          fill: 'none', stroke: 'currentColor', strokeOpacity: 0.3, strokeWidth: 2.5,
        }),
        React.createElement('circle', {
          cx: 12, cy: 12, r: 9,
          fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round',
          strokeDasharray: `${String((remains / 100) * 56.55)} 56.55`,
          transform: 'rotate(-90 12 12)',
        }),
      )
    }

    /** The reading color for a remaining percentage. */
    function toneColor(percent) {
      if (typeof percent !== 'number') return 'var(--dsw-alias-label-secondary)'
      if (percent <= 10) return 'var(--dsw-alias-state-error-primary)'
      if (percent <= 25) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-label-secondary)'
    }

    const apply = (ctx) => {
      /** Translate through this plugin's own dictionaries, following the locale service. */
      const t = (key, values) => {
        let id = 'en'
        try {
          const snapshot = ctx.locale.getSnapshot()
          id = String(snapshot?.id ?? 'en')
        } catch {
          id = 'en'
        }
        const dict = dictionaries[id] ?? dictionaries[id.split('-')[0]] ?? dictionaries.en
        return format(dict[key] ?? dictionaries.en[key] ?? key, values)
      }

      /** The quota reading for this session, or nothing while none applies. */
      function QuotaPill(props) {
        const sessionId = props.sessionId
        const [snapshot, setSnapshot] = React.useState(undefined)

        React.useEffect(() => {
          if (sessionId === undefined) return undefined
          let cancelled = false
          let timer
          const load = async () => {
            try {
              const response = await fetch(`${ENDPOINT}?session=${encodeURIComponent(String(sessionId))}`, {
                headers: { accept: 'application/json' },
              })
              let body = await response.json()
              // The Host probe needs a direct MiniMax/Claude credential. When it has
              // none, the model may be served by Our Free Model, which already meters
              // the account: read that reading through the signed-in browser.
              if (body?.ok !== true) body = (await ofmSnapshot(body)) ?? body
              if (!cancelled) setSnapshot(body)
            } catch {
              /* a transient failure keeps the previous reading */
            }
            if (!cancelled) timer = setTimeout(() => void load(), POLL_MS)
          }
          void load()
          return () => {
            cancelled = true
            clearTimeout(timer)
          }
        }, [sessionId])

        if (snapshot === undefined || snapshot.ok !== true) return null

        const details = Array.isArray(snapshot.details) ? snapshot.details : []
        const tooltip = details
          .map(detail => `${t(`quota.${DETAIL_LABELS[detail.key] ?? detail.key}`)}: ${detail.value}`)
          .join('\n')

        let primary
        let secondary
        if (typeof snapshot.percent === 'number') {
          primary = t('quota.window', { percent: snapshot.percent })
          if (typeof snapshot.weeklyPercent === 'number') secondary = t('quota.weekly', { percent: snapshot.weeklyPercent })
        } else if (snapshot.primary !== undefined) {
          primary = String(snapshot.primary.value)
        }
        if (primary === undefined) return null

        return React.createElement(
          'span',
          {
            style: { ...styles.anchor, color: toneColor(snapshot.percent) },
            'data-composer-stat': 'quota',
            title: tooltip.length === 0 ? t('quota.title') : `${t('quota.title')}\n${tooltip}`,
          },
          React.createElement(GaugeIcon, { percent: snapshot.percent }),
          React.createElement(
            'span',
            { style: styles.label },
            React.createElement('span', null, primary),
            secondary === undefined
              ? null
              : React.createElement('span', { style: styles.separator, 'aria-hidden': 'true' }, '·'),
            secondary === undefined ? null : React.createElement('span', null, secondary),
          ),
        )
      }

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'quota', order: 2 }, QuotaPill),
      )
      void NS
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
