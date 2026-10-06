import { useEffect, useState } from 'react'
import type { Account, Folder, MailRule, RuleActionType, RuleField } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'

const FIELD_LABEL: Record<RuleField, string> = { from: '发件人', to: '收件人', subject: '主题' }
const ACTION_LABEL: Record<RuleActionType, string> = {
  markRead: '标为已读',
  star: '加星标',
  move: '移到文件夹',
  archive: '归档',
  trash: '移到已删除',
  silent: '不弹通知'
}

const newRule = (): MailRule => ({
  id: Math.random().toString(36).slice(2) + Date.now().toString(36),
  name: '',
  enabled: true,
  accountId: '',
  match: 'all',
  conditions: [{ field: 'from', value: '' }],
  actions: [{ type: 'markRead' }]
})

/** 一句话说明这条规则做什么（折叠时显示） */
function summary(r: MailRule, accounts: Account[]): string {
  const who = r.accountId ? accounts.find((a) => a.id === r.accountId)?.email || '某个邮箱' : '所有邮箱'
  const cond = r.conditions
    .filter((c) => c.value.trim())
    .map((c) => `${FIELD_LABEL[c.field]}含「${c.value.trim()}」`)
    .join(r.match === 'any' ? ' 或 ' : ' 且 ')
  const act = r.actions.map((a) => ACTION_LABEL[a.type]).join('、')
  return `${who}：${cond || '（还没写条件）'} → ${act || '（还没选动作）'}`
}

/** 设置里的「邮件规则」：新邮件到达时自动标已读、加星、归档或移到文件夹 */
export function RulesPanel(props: {
  rules: MailRule[]
  accounts: Account[]
  onChange: (rules: MailRule[]) => void
  notify: (msg: string, kind?: 'ok' | 'error') => void
}) {
  const { rules, accounts } = props
  const [open, setOpen] = useState<string>('')
  const [folders, setFolders] = useState<Record<string, Folder[]>>({})
  const [running, setRunning] = useState(false)

  // 要选「移到文件夹」的规则，需要知道那个邮箱有哪些文件夹
  useEffect(() => {
    const want = new Set(rules.filter((r) => r.accountId && r.actions.some((a) => a.type === 'move')).map((r) => r.accountId))
    for (const id of want) {
      if (folders[id]) continue
      api
        .folders(id)
        .then((f) => setFolders((prev) => ({ ...prev, [id]: f })))
        .catch(() => undefined)
    }
  }, [rules, folders])

  const update = (id: string, patch: Partial<MailRule>): void => props.onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const move = (id: string, dir: -1 | 1): void => {
    const i = rules.findIndex((r) => r.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= rules.length) return
    const next = [...rules]
    ;[next[i], next[j]] = [next[j], next[i]]
    props.onChange(next)
  }
  const add = (): void => {
    const r = newRule()
    props.onChange([...rules, r])
    setOpen(r.id)
  }
  const runNow = async (): Promise<void> => {
    setRunning(true)
    try {
      const n = await api.runRules()
      props.notify(n ? `处理了收件箱里的 ${n} 封邮件` : '收件箱里最新的邮件没有符合规则的', 'ok')
    } catch (err) {
      props.notify((err as Error).message, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="form-stack rules-panel">
      <section className="addr-block">
        <h3>邮件规则</h3>
        <p className="muted small">
          新邮件到达收件箱时，按下面的规则自动处理，从上到下依次看。邮件被移走、归档或删除以后，后面的规则就不再处理它。规则在这台电脑上执行：Bluebird Mail 没开着的时候不会处理，开着以后到达的邮件才会处理。
        </p>
        {!rules.length && <p className="muted small">还没有规则。比如：「发件人含 newsletter → 标为已读并归档」。</p>}
        {rules.map((r, i) => {
          const isOpen = open === r.id
          const list = folders[r.accountId] || []
          return (
            <div key={r.id} className={`rule-card ${r.enabled ? '' : 'off'}`}>
              <div className="rule-head">
                <button type="button" className={`switch ${r.enabled ? 'on' : ''}`} role="switch" aria-checked={r.enabled} aria-label="启用" onClick={() => update(r.id, { enabled: !r.enabled })}>
                  <span />
                </button>
                <button type="button" className="rule-title" onClick={() => setOpen(isOpen ? '' : r.id)}>
                  <strong>{r.name || `规则 ${i + 1}`}</strong>
                  <span className="muted small">{summary(r, accounts)}</span>
                </button>
                <button type="button" className="icon-btn" title="上移" disabled={i === 0} onClick={() => move(r.id, -1)}>
                  <Icon name="arrowUp" size={14} />
                </button>
                <button type="button" className="icon-btn" title="下移" disabled={i === rules.length - 1} onClick={() => move(r.id, 1)}>
                  <Icon name="arrowDown" size={14} />
                </button>
                <button type="button" className="icon-btn" title="删除这条规则" onClick={() => props.onChange(rules.filter((x) => x.id !== r.id))}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
              {isOpen && (
                <div className="rule-body">
                  <label className="rule-line">
                    <span>名称</span>
                    <input value={r.name} placeholder="随便起个名字（可以不填）" maxLength={60} onChange={(e) => update(r.id, { name: e.target.value })} />
                  </label>
                  <label className="rule-line">
                    <span>用在</span>
                    <select
                      value={r.accountId}
                      onChange={(e) => {
                        // 换了邮箱，原来选的文件夹就不对了
                        const accountId = e.target.value
                        update(r.id, { accountId, actions: r.actions.map((a) => (a.type === 'move' ? { ...a, target: '' } : a)) })
                      }}
                    >
                      <option value="">所有邮箱</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="rule-line">
                    <span>当邮件</span>
                    <select value={r.match} onChange={(e) => update(r.id, { match: e.target.value === 'any' ? 'any' : 'all' })}>
                      <option value="all">符合下面全部条件</option>
                      <option value="any">符合下面任意一个条件</option>
                    </select>
                  </div>
                  {r.conditions.map((c, ci) => (
                    <div key={ci} className="rule-line sub">
                      <select value={c.field} onChange={(e) => update(r.id, { conditions: r.conditions.map((x, k) => (k === ci ? { ...x, field: e.target.value as RuleField } : x)) })}>
                        {(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABEL[f]}包含
                          </option>
                        ))}
                      </select>
                      <input
                        value={c.value}
                        placeholder={c.field === 'subject' ? '主题里的字' : '名字或邮箱地址，例如 newsletter@'}
                        maxLength={200}
                        onChange={(e) => update(r.id, { conditions: r.conditions.map((x, k) => (k === ci ? { ...x, value: e.target.value } : x)) })}
                      />
                      <button type="button" className="icon-btn" title="删除这个条件" disabled={r.conditions.length < 2} onClick={() => update(r.id, { conditions: r.conditions.filter((_, k) => k !== ci) })}>
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                  {r.conditions.length < 10 && (
                    <button type="button" className="link-btn" onClick={() => update(r.id, { conditions: [...r.conditions, { field: 'from', value: '' }] })}>
                      + 加一个条件
                    </button>
                  )}
                  <div className="rule-line">
                    <span>就自动</span>
                  </div>
                  {r.actions.map((a, ai) => (
                    <div key={ai} className="rule-line sub">
                      <select
                        value={a.type}
                        onChange={(e) => update(r.id, { actions: r.actions.map((x, k) => (k === ai ? (e.target.value === 'move' ? { type: 'move', target: '' } : { type: e.target.value as RuleActionType }) : x)) })}
                      >
                        {(Object.keys(ACTION_LABEL) as RuleActionType[])
                          .filter((t) => t === a.type || !r.actions.some((x) => x.type === t))
                          .map((t) => (
                            <option key={t} value={t}>
                              {ACTION_LABEL[t]}
                            </option>
                          ))}
                      </select>
                      {a.type === 'move' &&
                        (r.accountId ? (
                          <select value={a.target || ''} onChange={(e) => update(r.id, { actions: r.actions.map((x, k) => (k === ai ? { ...x, target: e.target.value } : x)) })}>
                            <option value="">选一个文件夹…</option>
                            {list
                              .filter((f) => f.path.toUpperCase() !== 'INBOX')
                              .map((f) => (
                                <option key={f.path} value={f.path}>
                                  {f.displayName}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <span className="muted small">先在上面选一个具体的邮箱，才能选文件夹</span>
                        ))}
                      <button type="button" className="icon-btn" title="删除这个动作" disabled={r.actions.length < 2} onClick={() => update(r.id, { actions: r.actions.filter((_, k) => k !== ai) })}>
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                  {r.actions.length < Object.keys(ACTION_LABEL).length && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        const free = (Object.keys(ACTION_LABEL) as RuleActionType[]).find((t) => !r.actions.some((x) => x.type === t))
                        if (free) update(r.id, { actions: [...r.actions, free === 'move' ? { type: 'move', target: '' } : { type: free }] })
                      }}
                    >
                      + 再加一个动作
                    </button>
                  )}
                  {r.actions.some((a) => a.type === 'move' && !a.target) && <p className="muted small">还没选文件夹的「移到文件夹」不会执行。</p>}
                </div>
              )}
            </div>
          )
        })}
        <div className="rule-foot">
          <button type="button" className="ghost-btn bordered" onClick={add}>
            + 新建规则
          </button>
          <button type="button" className="ghost-btn bordered" disabled={running || !rules.length} onClick={() => void runNow()} title="对各邮箱收件箱里最新的一页邮件运行一次">
            {running ? '正在处理…' : '现在对收件箱运行一次'}
          </button>
        </div>
      </section>
    </div>
  )
}
