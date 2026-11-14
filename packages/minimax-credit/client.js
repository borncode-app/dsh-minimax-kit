window.__ModuleLoader__.load({
  id: '@local/dsh-minimax-credit',
  factory: (require) => {
    const React = require('react')
    /** Must match the Host row's `statusPath`. */
    const ENDPOINT = '/plugins/minimax-credit/status'
    /**
     * Fallback readings, tried in order when the same-origin route answers
     * nothing: the proxy's own status route, which the Host serves with a
     * permissive CORS header, so the chip still works before the Host row has
     * been re-applied.
     */
    const FALLBACK_ENDPOINTS = [
      'http://127.0.0.1:45677/status',
      'http://127.0.0.1:45677/health',
    ]
    /** How often the browser re-reads the proxy state. */
    const POLL_MS = 30000

    /** Visible text. Kept beside the exported locale resources for the same keys. */
    const dictionaries = {
      en: {
        'credit.title': 'MiniMax credits',
        'credit.inUse': 'credits',
        'credit.unavailable': 'credits unavailable',
        'credit.remaining': 'Credits left',
        'credit.remainingShort': 'credits {value}',
        'credit.purchased': 'Purchased {value}',
        'credit.free': 'Free credits {value}',
        'credit.planTier': 'Plan: {tier}',
        'credit.wallet': 'Wallet credit {value}',
        'credit.fallbackOn': 'Credit fallback is on in MiniMax',
        'credit.fallbackOff': 'Credit fallback is off in MiniMax',
        'credit.tooltip': 'Plan quota is spent, so requests continue on MiniMax credits.',
        'credit.plan': 'Plan window',
        'credit.planRemaining': '{percent}% left',
        'credit.planSpent': 'spent',
        'credit.resets': 'Resets in',
        'credit.weeklyPlan': 'Weekly window',
        'credit.weeklyResets': 'Weekly resets in',
        'credit.zero': 'No credit balance: if the plan is also spent, requests will fail until you top up.',
        'credit.signIn': 'Open MiniMax Code and sign in again to keep credit fallback working.',
      },
      th: {
        'credit.title': 'เครดิต MiniMax',
        'credit.inUse': 'เครดิต',
        'credit.unavailable': 'เครดิตใช้ไม่ได้',
        'credit.remaining': 'เครดิตคงเหลือ',
        'credit.remainingShort': 'เครดิต {value}',
        'credit.purchased': 'ซื้อเพิ่ม {value}',
        'credit.free': 'เครดิตแถม {value}',
        'credit.planTier': 'แพ็กเกจ: {tier}',
        'credit.wallet': 'เครดิตในกระเป๋า {value}',
        'credit.fallbackOn': 'เปิดใช้เครดิตต่อจากแพ็กเกจแล้วใน MiniMax',
        'credit.fallbackOff': 'ปิดการใช้เครดิตต่อจากแพ็กเกจใน MiniMax',
        'credit.tooltip': 'โควตาแพ็กเกจหมดแล้ว คำขอจะใช้เครดิต MiniMax ต่อ',
        'credit.plan': 'หน้าต่างแพ็กเกจ',
        'credit.planRemaining': 'เหลือ {percent}%',
        'credit.planSpent': 'หมดแล้ว',
        'credit.resets': 'รีเซ็ตใน',
        'credit.weeklyPlan': 'หน้าต่างสัปดาห์',
        'credit.weeklyResets': 'รีเซ็ตรายสัปดาห์ใน',
        'credit.zero': 'เครดิตคงเหลือ 0 — ถ้าแพ็กเกจหมดด้วย คำขอจะไม่ผ่านจนกว่าจะเติมเครดิต',
        'credit.signIn': 'เปิด MiniMax Code แล้วลงชื่อเข้าใช้อีกครั้ง เพื่อให้ใช้เครดิตต่อได้',
      },
      zh: {
        'credit.title': 'MiniMax 额度',
        'credit.inUse': '额度',
        'credit.unavailable': '额度不可用',
        'credit.remaining': '剩余额度',
        'credit.remainingShort': '剩余 {value}',
        'credit.purchased': '已购买 {value}',
        'credit.free': '赠送额度 {value}',
        'credit.planTier': '套餐：{tier}',
        'credit.wallet': '钱包余额 {value}',
        'credit.fallbackOn': 'MiniMax 已开启额度回退',
        'credit.fallbackOff': 'MiniMax 已关闭额度回退',
        'credit.tooltip': '套餐额度已用完，请求将改用 MiniMax 额度继续。',
        'credit.plan': '套餐窗口',
        'credit.planRemaining': '剩余 {percent}%',
        'credit.planSpent': '已用完',
        'credit.resets': '重置',
        'credit.weeklyPlan': '每周窗口',
        'credit.weeklyResets': '每周重置',
        'credit.zero': '额度余额为 0：套餐也用完时将无法继续请求，需先充值。',
        'credit.signIn': '请打开 MiniMax Code 重新登录，以继续使用额度回退。',
      },
    }

    /** Fill `{name}` placeholders from one values object. */
    function format(text, values) {
      if (values === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (match, name) => (values[name] === undefined ? match : String(values[name])))
    }

    /** A credit count as compact display text, with thousands separators. */
    function amount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Number.isInteger(value)) return value.toLocaleString()
      return value.toFixed(2)
    }

    const styles = {
      anchor: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '20px',
        padding: '0 2px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-label-secondary)',
      },
      coin: {
        width: '9px',
        height: '9px',
        borderRadius: '50%',
        border: '1.5px solid currentColor',
        boxSizing: 'border-box',
      },
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

      /** The credit reading and fallback state for this account. */
      function CreditPill() {
        const [snapshot, setSnapshot] = React.useState(undefined)

        React.useEffect(() => {
          let cancelled = false
          let timer
          /** One reading from the first endpoint that answers with a status. */
          const read = async (endpoints) => {
            for (const endpoint of endpoints) {
              try {
                const response = await fetch(endpoint, { headers: { accept: 'application/json' } })
                if (!response.ok) continue
                const body = await response.json()
                if (body !== undefined && body !== null && typeof body === 'object') return body
              } catch {
                /* try the next endpoint */
              }
            }
            return undefined
          }
          const load = async () => {
            const body = await read([ENDPOINT])
            const fallback = body === undefined ? await read(FALLBACK_ENDPOINTS) : undefined
            const reading = body ?? fallback
            if (reading !== undefined && !cancelled) setSnapshot(reading)
            if (!cancelled) timer = setTimeout(() => void load(), POLL_MS)
          }
          void load()
          return () => {
            cancelled = true
            clearTimeout(timer)
          }
        }, [])

        if (snapshot === undefined || snapshot.enabled !== true) return null
        const tokenBad = snapshot.token?.ok !== true
        const creditMode = snapshot.mode === 'credits'
        const credits = snapshot.credits
        const known = credits !== undefined && credits !== null && credits.ok === true && typeof credits.remaining === 'number'

        // Always show the credit balance once MiniMax answers; otherwise keep the
        // old behaviour of showing only when the fallback is in use or broken.
        if (!tokenBad && !known && !creditMode) return null

        const lines = [t('credit.title')]
        const plan = snapshot.plan
        if (plan !== null && plan !== undefined) {
          lines.push(`${t('credit.plan')}: ${typeof plan.percent === 'number' ? t('credit.planRemaining', { percent: plan.percent }) : t('credit.planSpent')}`)
          if (plan.resetIn !== undefined) lines.push(`${t('credit.resets')}: ${plan.resetIn}`)
          // The weekly window is a second, independent cap: a 0% weekly reading
          // means the plan is spent even while the short window still shows
          // quota, so both numbers belong in the tooltip.
          if (typeof plan.weeklyPercent === 'number') {
            lines.push(`${t('credit.weeklyPlan')}: ${t('credit.planRemaining', { percent: plan.weeklyPercent })}`)
          }
          if (plan.weeklyResetIn !== undefined) lines.push(`${t('credit.weeklyResets')}: ${plan.weeklyResetIn}`)
        }
        if (creditMode) lines.push(t('credit.tooltip'))
        if (known) {
          lines.push(`${t('credit.remaining')}: ${amount(credits.remaining)}`)
          if (typeof credits.remainingExact === 'number' && credits.remainingExact !== credits.remaining) {
            lines.push(`(${credits.remainingExact.toFixed(2)})`)
          }
          if (typeof credits.purchasedRemaining === 'number' && credits.purchasedRemaining > 0) lines.push(t('credit.purchased', { value: amount(credits.purchasedRemaining) }))
          if (typeof credits.freeRemaining === 'number' && credits.freeRemaining > 0) lines.push(t('credit.free', { value: amount(credits.freeRemaining) }))
          if (credits.plan?.tier !== undefined) lines.push(t('credit.planTier', { tier: credits.plan.tier }))
          if (credits.wallet?.credit !== undefined) lines.push(t('credit.wallet', { value: credits.wallet.credit.toFixed(2) }))
          if (credits.fallbackEnabled !== undefined) lines.push(credits.fallbackEnabled ? t('credit.fallbackOn') : t('credit.fallbackOff'))
          if (credits.remaining <= 0) lines.push(t('credit.zero'))
        }
        if (tokenBad) lines.push(t('credit.signIn'))

        let label
        let tone = 'var(--dsw-alias-label-secondary)'
        if (tokenBad) {
          label = t('credit.unavailable')
          tone = 'var(--dsw-alias-state-error-primary)'
        } else if (known) {
          label = t('credit.remainingShort', { value: amount(credits.remaining) })
          if (creditMode || credits.remaining <= 0) tone = 'var(--dsw-alias-state-warn-primary)'
        } else {
          label = t('credit.inUse')
          tone = 'var(--dsw-alias-state-warn-primary)'
        }

        return React.createElement(
          'span',
          {
            style: { ...styles.anchor, color: tone },
            'data-composer-stat': 'minimax-credit',
            title: lines.join('\n'),
          },
          React.createElement('span', { style: styles.coin, 'aria-hidden': 'true' }),
          React.createElement('span', null, label),
        )
      }

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'minimax-credit', order: 3 }, CreditPill),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
