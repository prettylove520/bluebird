import { useEffect, useMemo, useState } from 'react'
import type { Contact } from '../../../shared/types'
import { api } from '../api'
import { avatarColor } from '../utils'

type Item = Contact & { sent: boolean; last: number }

/** 设置里的「联系人」：写信时自动提示的人都存在这里，只存在本机 */
export function ContactsPanel(props: { notify: (msg: string, kind?: 'ok' | 'error') => void }) {
  const [list, setList] = useState<Item[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(100)

  const load = (): void => {
    api
      .contactList()
      .then(setList)
      .catch(() => setList([]))
  }
  useEffect(load, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = list || []
    return q ? all.filter((c) => c.address.includes(q) || c.name.toLowerCase().includes(q)) : all
  }, [list, query])

  const scan = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.contactScan()
      props.notify(`看了 ${r.scanned} 封已发送的邮件，现在共有 ${r.total} 个联系人`, 'ok')
      load()
    } catch (err) {
      props.notify((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = (c: Item): void => {
    setList((l) => (l || []).filter((x) => x.address !== c.address))
    api.contactRemove(c.address).catch(() => load())
  }

  return (
    <div>
      <div className="set-hint" style={{ marginBottom: 12 }}>
        你发过信的人会自动记在这里，写信时输入几个字（名字或邮箱的一部分都行）就会提示，回车或点一下填入。
        只存在这台电脑上。删掉的人不会再被自动收集回来。
      </div>
      <div className="contact-tools">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索联系人" spellCheck={false} />
        <button className="ghost-btn bordered" disabled={busy} onClick={() => void scan()}>
          {busy ? '正在收集…' : '从已发送邮件重新收集'}
        </button>
      </div>
      {list === null ? (
        <div className="muted">读取中…</div>
      ) : rows.length === 0 ? (
        <div className="muted">{list.length ? '没有符合的联系人' : '还没有联系人。点上面的「重新收集」，会从各邮箱的已发送里找。'}</div>
      ) : (
        <>
          <div className="muted" style={{ margin: '4px 0 8px' }}>
            共 {rows.length} 个
          </div>
          <ul className="contact-list">
            {rows.slice(0, shown).map((c) => (
              <li key={c.address}>
                <i style={{ background: avatarColor(c.address) }}>{(c.name || c.address).trim()[0]?.toUpperCase() || '?'}</i>
                <span className="contact-name">{c.name || c.address.split('@')[0]}</span>
                <span className="contact-addr">{c.address}</span>
                <button className="contact-del" title="删除" onClick={() => remove(c)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {rows.length > shown && (
            <button className="ghost-btn bordered" style={{ marginTop: 8 }} onClick={() => setShown((n) => n + 200)}>
              再显示 200 个
            </button>
          )}
        </>
      )}
    </div>
  )
}
