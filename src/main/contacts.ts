// 联系人：写信时用来自动补全收件人。
// 没有单独的通讯录，是从往来邮件里慢慢攒出来的：给谁发过信、谁给你发过信（机器发的通知不算）。
// 只存在本机的 contacts.json 里。

import { app } from 'electron'
import { join } from 'path'
import type { Contact } from '../shared/types'
import { readJsonSafe, writeJsonSafe } from './jsonfile'

interface Entry {
  name: string
  /** 分数越高排得越靠前：发过信的比只收过信的高 */
  score: number
  last: number
  /** 给这个人发过信 */
  sent?: boolean
  /** 见过的几封邮件的标识（最多记 3 个）。用来判断「是不是第一次来信」，也防止同一封信被反复计数 */
  ids?: string[]
}

let book: Record<string, Entry> | null = null
let timer: NodeJS.Timeout | null = null
const file = (): string => join(app.getPath('userData'), 'contacts.json')

function load(): Record<string, Entry> {
  if (!book) book = readJsonSafe<Record<string, Entry>>(file(), {})
  return book
}

function saveSoon(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      // 攒得太多时只留分数高的那些
      const b = load()
      const keys = Object.keys(b)
      if (keys.length > 5000) {
        const keep = keys.sort((x, y) => b[y].score - b[x].score || b[y].last - b[x].last).slice(0, 4000)
        book = Object.fromEntries(keep.map((k) => [k, b[k]]))
      }
      writeJsonSafe(file(), book)
    } catch (err) {
      console.warn('保存联系人失败', (err as Error).message)
    }
  }, 5000)
}

const VALID = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/
const ROBOT = /(^|[-_.+])(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer(-daemon)?|postmaster|bounces?|unsubscribe|unsub|leave)([-_.+]|@)/i

/**
 * 记下一批地址。kind：sent = 你给他们发过信；received = 他们给你发过信。
 * id 是那封邮件的标识：同一封邮件不管列表刷新多少次、程序重启多少次，都只算一次。不传就每次都算（用于刚发出的信）。
 */
export function noteContacts(list: { name?: string; address?: string }[], kind: 'sent' | 'received', id?: string): void {
  const b = load()
  let changed = false
  for (const a of list) {
    const address = (a.address || '').trim().toLowerCase()
    if (!VALID.test(address) || ROBOT.test(address)) continue
    const e = b[address] ?? { name: '', score: 0, last: 0 }
    if (id) {
      const ids = e.ids ?? []
      if (ids.includes(id)) continue
      // 只需要知道「是不是不止一封」，记满 3 个就不再往里加，分数也不再涨
      if (ids.length >= 3) {
        if (kind === 'sent' && !e.sent) {
          e.sent = true
          b[address] = e
          changed = true
        }
        continue
      }
      e.ids = [...ids, id]
    }
    const name = (a.name || '').trim().replace(/^['"]|['"]$/g, '')
    if (name && name.toLowerCase() !== address && (!e.name || kind === 'sent')) e.name = name
    e.score += kind === 'sent' ? 5 : 1
    if (kind === 'sent') e.sent = true
    e.last = Date.now()
    b[address] = e
    changed = true
  }
  if (changed) saveSoon()
}

/** 按输入的几个字找联系人：名字或地址里包含就算，开头匹配的排前面 */
export function searchContacts(query: string, limit = 8): Contact[] {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const b = load()
  const hits: { c: Contact; rank: number }[] = []
  for (const [address, e] of Object.entries(b)) {
    const name = e.name.toLowerCase()
    const starts = address.startsWith(q) || name.startsWith(q)
    if (!starts && !address.includes(q) && !name.includes(q)) continue
    hits.push({ c: { name: e.name, address }, rank: (starts ? 1000 : 0) + (e.sent ? 500 : 0) + Math.min(e.score, 400) })
  }
  return hits
    .sort((x, y) => y.rank - x.rank)
    .slice(0, limit)
    .map((h) => h.c)
}

/** 这个发件人是不是「认识的」：给他发过信，或者收到过他不止一封信 */
export function isKnownSender(address: string): boolean {
  const e = load()[String(address || '').toLowerCase()]
  return !!e && (!!e.sent || (e.ids?.length ?? 0) >= 2)
}
