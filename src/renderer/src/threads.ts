// 邮件会话：把同一个话题来回的邮件串在一起。
// 依据是邮件头里的 Message-ID 和 References / In-Reply-To（回复时邮件程序会自动带上），
// 另外要求主题也相同（去掉「回复：」「Re:」这类前缀后），和 Gmail 的做法一样——
// 这样即使某个群发系统给不相干的邮件写了同一个引用，也不会被误并到一起。

import type { MessageSummary } from '../../shared/types'

const keyOf = (m: MessageSummary): string => `${m.accountId}|${m.folder}|${m.uid}`

const PREFIX = /^\s*((re|fwd?|fw|回复|答复|转发|回覆|轉寄)\s*(\[\d+\])?\s*[:：]\s*)+/i

/** 去掉回复、转发前缀后的主题 */
export function baseSubject(subject: string): string {
  return (subject || '').replace(PREFIX, '').trim().toLowerCase()
}

/**
 * 给每封邮件算出它所属会话的标识。两封邮件标识相同就是同一个会话。
 * 只在同一个账号的同一个文件夹里串。
 */
export function threadKeys(list: MessageSummary[]): Map<string, string> {
  const parent: number[] = list.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  // 每个 Message-ID 第一次是在哪封邮件上见到的
  const owner = new Map<string, number>()
  list.forEach((m, i) => {
    if (!m.messageId && !m.refs?.length) return
    const scope = `${m.accountId}|${m.folder}|`
    const ids = m.messageId ? [m.messageId, ...(m.refs || [])] : m.refs || []
    for (const id of ids) {
      const k = scope + id
      const seen = owner.get(k)
      if (seen === undefined) owner.set(k, i)
      else union(seen, i)
    }
  })
  const out = new Map<string, string>()
  list.forEach((m, i) => {
    out.set(keyOf(m), `${find(i)}|${baseSubject(m.subject)}`)
  })
  return out
}

/**
 * 按会话把列表分组。组的顺序、组内邮件的顺序都跟原列表一致（原列表是新的在前，所以每组第一封就是最新的那封）。
 * keys 里没有的邮件各自单独成组。
 */
export function groupByThread(list: MessageSummary[], keys: Map<string, string> | null): MessageSummary[][] {
  if (!keys) return list.map((m) => [m])
  const groups: MessageSummary[][] = []
  const index = new Map<string, MessageSummary[]>()
  for (const m of list) {
    const k = keys.get(keyOf(m))
    const g = k === undefined ? undefined : index.get(k)
    if (g) g.push(m)
    else {
      const fresh = [m]
      groups.push(fresh)
      if (k !== undefined) index.set(k, fresh)
    }
  }
  return groups
}
