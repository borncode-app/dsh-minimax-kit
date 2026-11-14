window.__ModuleLoader__.load({
  id: '@local/dsh-minimax-checkin',
  factory: (require) => {
    const React = require('react')
    /** Must match the Host row's `statusPath`. */
    const STATUS_ENDPOINT = '/plugins/minimax-checkin/status'
    /** Must match the Host row's `claimPath`. */
    const CLAIM_ENDPOINT = '/plugins/minimax-checkin/claim'
    /** How often the browser re-reads the check-in panel. */
    const POLL_MS = 60000

    /** Visible text. Kept beside the exported locale resources for the same keys. */
    const dictionaries = {
      en: {
        'checkin.title': 'MiniMax daily check-in',
        'checkin.streak': '{value}-day streak this cycle',
        'checkin.claim': 'Check in for {value}',
        'checkin.claimed': 'Checked in today',
        'checkin.upcoming': 'Not claimable yet',
        'checkin.unavailable': 'Check-in unavailable',
        'checkin.signIn': 'Open MiniMax Code and sign in again so the daily check-in can run.',
        'checkin.claiming': 'Claiming…',
        'checkin.failed': 'The daily check-in failed: {message}',
        'checkin.done': 'Claimed {value} credits for day {day}.',
        'checkin.already': 'Today\'s reward was already claimed.',
      },
      th: {
        'checkin.title': 'เช็กอินประจำวันของ MiniMax',
        'checkin.streak': 'ต่อเนื่อง {value} วันในรอบนี้',
        'checkin.claim': 'เช็กอินรับ {value}',
        'checkin.claimed': 'เช็กอินวันนี้แล้ว',
        'checkin.upcoming': 'ยังรับไม่ได้',
        'checkin.unavailable': 'ใช้เช็กอินไม่ได้',
        'checkin.signIn': 'เปิด MiniMax Code แล้วลงชื่อเข้าใช้อีกครั้ง เพื่อให้เช็กอินประจำวันทำงานได้',
        'checkin.claiming': 'กำลังรับ…',
        'checkin.failed': 'เช็กอินประจำวันล้มเหลว: {message}',
        'checkin.done': 'รับเครดิต {value} สำหรับวันที่ {day} แล้ว',
        'checkin.already': 'รับของวันนี้ไปแล้ว',
      },
      zh: {
        'checkin.title': 'MiniMax 每日签到',
        'checkin.streak': '本轮已连续 {value} 天',
        'checkin.claim': '签到领取 {value}',
        'checkin.claimed': '今日已签到',
        'checkin.upcoming': '暂不可领取',
        'checkin.unavailable': '签到不可用',
        'checkin.signIn': '请打开 MiniMax Code 重新登录，签到才能继续运行。',
        'checkin.claiming': '领取中…',
        'checkin.failed': '每日签到失败：{message}',
        'checkin.done': '已为第 {day} 天领取 {value} 额度。',
        'checkin.already': '今天的奖励已经领取过了。',
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
      return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2)
    }

    const styles = {
      anchor: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
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
      button: {
        height: '20px',
        padding: '0 8px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-fill-quaternary)',
        color: 'var(--dsw-alias-label-primary)',
      },
      buttonBusy: {
        opacity: 0.6,
        cursor: 'default',
      },
      buttonDone: {
        color: 'var(--dsw-alias-state-success-primary)',
        borderColor: 'var(--dsw-alias-state-success-primary)',
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

      /** The check-in chip and its claim button. */
      function CheckinPill() {
        const [snapshot, setSnapshot] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)
        const [note, setNote] = React.useState(undefined)

        React.useEffect(() => {
          let cancelled = false
          let timer
          const load = async () => {
            try {
              const response = await fetch(STATUS_ENDPOINT, { headers: { accept: 'application/json' } })
              if (response.ok) {
                const body = await response.json()
                if (!cancelled && body !== null && typeof body === 'object') setSnapshot(body)
              }
            } catch {
              /* the host route is not reachable right now */
            }
            if (!cancelled) timer = setTimeout(() => void load(), POLL_MS)
          }
          void load()
          return () => {
            cancelled = true
            clearTimeout(timer)
          }
        }, [])

        /** Claim today's reward once, then refresh the panel. */
        const claim = async () => {
          setBusy(true)
          setNote(undefined)
          try {
            const response = await fetch(CLAIM_ENDPOINT, { method: 'POST', headers: { accept: 'application/json' } })
            const body = await response.json().catch(() => undefined)
            if (!response.ok || body?.ok !== true) {
              setNote(t('checkin.failed', { message: String(body?.message ?? response.status) }))
              return
            }
            if (body.alreadyClaimed === true) {
              setNote(t('checkin.already'))
            } else {
              setNote(t('checkin.done', { value: amount(body.points), day: String(body.dayNo ?? '') }))
            }
            setSnapshot(current => (current === undefined
              ? current
              : { ...current, panel: body.panel ?? current.panel, lastClaim: { at: new Date().toISOString(), day: body.dayNo, points: body.points, claimed: body.claimed === true } }))
          } catch (error) {
            setNote(t('checkin.failed', { message: error instanceof Error ? error.message : String(error) }))
          } finally {
            setBusy(false)
          }
        }

        if (snapshot === undefined || snapshot.enabled !== true) return null
        const panel = snapshot.panel
        if (panel === null || panel === undefined) return null
        const tokenBad = snapshot.token?.ok !== true
        const today = panel.today
        const claimable = panel.claimableNow === true
        const done = panel.claimedToday === true
        const points = panel.claimable?.points ?? today?.points ?? 0

        const lines = [t('checkin.title')]
        lines.push(t('checkin.streak', { value: String(panel.streak ?? 0) }))
        if (tokenBad) lines.push(t('checkin.signIn'))
        if (note !== undefined) lines.push(note)

        let label
        let tone = 'var(--dsw-alias-label-secondary)'
        if (done) {
          label = t('checkin.claimed')
          tone = 'var(--dsw-alias-state-success-primary)'
        } else if (claimable) {
          label = t('checkin.claim', { value: amount(points) })
        } else {
          label = t('checkin.upcoming')
        }

        return React.createElement(
          'span',
          {
            style: { ...styles.anchor, color: tone },
            'data-composer-stat': 'minimax-checkin',
            title: lines.join('\n'),
          },
          React.createElement('span', { style: styles.coin, 'aria-hidden': 'true' }),
          React.createElement('span', null, t('checkin.streak', { value: String(panel.streak ?? 0) })),
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.button, ...(busy ? styles.buttonBusy : {}), ...(done ? styles.buttonDone : {}) },
              disabled: busy || done || !claimable || tokenBad,
              onClick: () => void claim(),
            },
            busy ? t('checkin.claiming') : label,
          ),
        )
      }

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'minimax-checkin', order: 4 }, CheckinPill),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
