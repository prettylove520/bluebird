// 列表怎么排：未读的集中在最上面，然后是置顶的，再往下按时间；
// 通知、订阅类里同一个发件人（GitHub 还要分到具体仓库）的已读邮件 3 封起折叠成一组。
// 只依赖传进来的数据，不碰界面状态，从 App.tsx 里拆出来

import type { MessageSummary } from '../../../shared/types'
import type { CategoryTab, Stack } from '../components/MessageList'
import { displayName } from '../utils'
import { keyOf } from './model'

export interface ArrangeOptions {
  /** 搜索结果、「稍后处理」「已置顶」里保持原来的顺序，不置顶也不折叠 */
  keepOrder: boolean
  /** 智能收件箱开着、而且不是「全部」页 */
  stackOn: boolean
  tab: CategoryTab
  pinnedKeys: Set<string>
  /** 刚点开的那封：读了以后先留在「未读」那一段 */
  stickTop: string | null
  /** 正在看的那封：所在的折叠组保持展开 */
  selectedKey: string | null
  /** 用户点开了的折叠组 */
  openStacks: Set<string>
}

export interface Arranged {
  /** 排在最上面「未读」那一段里的行（用每行第一封邮件的 key） */
  unreadTop: Set<string>
  /** 排好的行（每行是一个会话，会话里新的在前） */
  ordered: MessageSummary[][]
  /** 折叠组，以及每组显示在哪一行前面 */
  stacks: Stack[]
}

export function arrangeGroups(groups: MessageSummary[][], o: ArrangeOptions): Arranged {
  const groupPinned = (g: MessageSummary[]): boolean => g.some((m) => o.pinnedKeys.has(keyOf(m)))
  // 刚点开的那封虽然已经变成已读，也先留在上面不动，等点开别的邮件再回到按时间的位置，免得一点它就从眼前跳走
  const groupOnTop = (g: MessageSummary[]): boolean => g.some((m) => !m.seen || keyOf(m) === o.stickTop)
  const topGroups = o.keepOrder ? [] : groups.filter(groupOnTop)
  const unreadTop = new Set(topGroups.map((g) => keyOf(g[0])))
  const restGroups = groups.filter((g) => !unreadTop.has(keyOf(g[0])))
  const orderedAll = o.keepOrder ? groups : [...topGroups, ...restGroups.filter(groupPinned), ...restGroups.filter((g) => !groupPinned(g))]

  // 收件箱（聚焦）里只有通知、订阅类的才折叠，真人来信永远单独一行；没读的邮件不折叠
  const canStack = (g: MessageSummary[]): boolean =>
    !groupPinned(g) &&
    !unreadTop.has(keyOf(g[0])) &&
    g.every((x) => x.seen || keyOf(x) === o.selectedKey) &&
    (o.tab !== 'focus' || g[0].category !== 'personal')
  const stackKeyOf = (m: MessageSummary): string => {
    const addr = (m.from[0]?.address || '').toLowerCase()
    const repo = /^\s*(?:(?:re|fwd?)\s*:\s*)?\[([^\]]{2,60})\]/i.exec(m.subject || '')
    return `${o.tab}|${addr}|${repo ? repo[1].toLowerCase() : ''}`
  }

  const stacks: Stack[] = []
  const ordered: MessageSummary[][] = []
  const byKey = new Map<string, MessageSummary[][]>()
  if (o.stackOn)
    for (const g of orderedAll) {
      if (!canStack(g)) continue
      const k = stackKeyOf(g[0])
      const l = byKey.get(k)
      if (l) l.push(g)
      else byKey.set(k, [g])
    }
  const pend: Stack[] = []
  const put = (g: MessageSummary[]): void => {
    for (const s of pend) {
      s.beforeKey = keyOf(g[0])
      stacks.push(s)
    }
    pend.length = 0
    ordered.push(g)
  }
  const done = new Set<string>()
  for (const g of orderedAll) {
    const k = o.stackOn && canStack(g) ? stackKeyOf(g[0]) : ''
    const members = k ? byKey.get(k) : undefined
    if (!members || members.length < 3) {
      put(g)
      continue
    }
    if (done.has(k)) continue
    done.add(k)
    const msgs = members.flat()
    // 正在看的那封所在的组保持展开，免得把当前选中的邮件藏起来
    const open = o.openStacks.has(k) || (o.selectedKey != null && msgs.some((x) => keyOf(x) === o.selectedKey))
    const first = msgs[0]
    const repo = /\[([^\]]{2,60})\]/.exec(first.subject || '')
    pend.push({
      id: k,
      beforeKey: '',
      label: repo ? repo[1] : displayName(first.from[0]),
      sub: msgs.find((x) => !x.seen)?.subject || first.from[0]?.address || '',
      seed: first.from[0]?.address || '',
      date: first.date,
      count: msgs.length,
      unread: msgs.filter((x) => !x.seen).length,
      open,
      members: msgs
    })
    if (open) for (const mg of members) put(mg)
  }
  for (const s of pend) stacks.push(s)
  return { unreadTop, ordered, stacks }
}
