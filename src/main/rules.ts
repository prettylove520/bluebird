// 邮件规则：新邮件到达（或用户点「现在运行」）时，按规则自动处理。规则在本机执行，不会存到邮箱服务器上
import type { Account, MailRule, MessageSummary, RuleAction, RuleCondition } from '../shared/types'
import { getData } from './userdata'
import { archiveMessage, deleteMessage, listMessages, moveMessage, setFlag } from './mail/service'

/** 规则要比对的内容 */
export interface RuleTarget {
  uid: number
  /** 发件人的名字和邮箱地址，小写 */
  from: string
  /** 收件人的名字和邮箱地址，小写 */
  to: string
  subject: string
}

const MAX_RULES = 100
const MAX_CONDITIONS = 10
const MAX_ACTIONS = 6
const FIELDS = ['from', 'to', 'subject']
const ACTIONS = ['markRead', 'star', 'move', 'archive', 'trash', 'silent']

const clip = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')

/** 界面传来的规则不可信：只留下认识的字段，数量和长度都限制一下 */
export function cleanRules(input: unknown): MailRule[] {
  if (!Array.isArray(input)) return []
  const out: MailRule[] = []
  for (const r of input.slice(0, MAX_RULES) as Partial<MailRule>[]) {
    if (!r || typeof r !== 'object') continue
    const conditions: RuleCondition[] = []
    for (const c of (Array.isArray(r.conditions) ? r.conditions : []).slice(0, MAX_CONDITIONS)) {
      if (!c || !FIELDS.includes(c.field)) continue
      conditions.push({ field: c.field, value: clip(c.value, 200) })
    }
    const actions: RuleAction[] = []
    for (const a of (Array.isArray(r.actions) ? r.actions : []).slice(0, MAX_ACTIONS)) {
      if (!a || !ACTIONS.includes(a.type)) continue
      if (actions.some((x) => x.type === a.type)) continue
      actions.push(a.type === 'move' ? { type: 'move', target: clip(a.target, 500) } : { type: a.type })
    }
    out.push({
      id: clip(r.id, 80) || Math.random().toString(36).slice(2),
      name: clip(r.name, 60),
      enabled: r.enabled !== false,
      accountId: clip(r.accountId, 80),
      match: r.match === 'any' ? 'any' : 'all',
      conditions,
      actions
    })
  }
  return out
}

/** 条件有没有写完整（空条件不算，避免一条空规则把所有邮件都处理了） */
function usable(r: MailRule): boolean {
  return r.enabled && r.conditions.length > 0 && r.conditions.every((c) => c.value.trim()) && r.actions.length > 0 && r.actions.every((a) => a.type !== 'move' || !!a.target)
}

export function ruleMatches(rule: MailRule, t: RuleTarget): boolean {
  const test = (c: RuleCondition): boolean => {
    const hay = c.field === 'from' ? t.from : c.field === 'to' ? t.to : t.subject.toLowerCase()
    return hay.includes(c.value.trim().toLowerCase())
  }
  return rule.match === 'any' ? rule.conditions.some(test) : rule.conditions.every(test)
}

export interface RuleOutcome {
  /** 已经离开收件箱的（移动、归档、删除） */
  gone: Set<number>
  /** 不用再弹通知的（已读、不弹通知，以及离开收件箱的） */
  quiet: Set<number>
  /** 实际处理了多少封 */
  handled: number
}

/** 对一批邮件执行规则。某条规则失败（比如目标文件夹没了）不影响其余的 */
export async function applyRules(account: Account, folder: string, targets: RuleTarget[]): Promise<RuleOutcome> {
  const outcome: RuleOutcome = { gone: new Set(), quiet: new Set(), handled: 0 }
  const rules = (getData().rules || []).filter((r) => usable(r) && (!r.accountId || r.accountId === account.id))
  if (!rules.length || !targets.length) return outcome

  // 先算出每封邮件要做什么，再按动作分组一次做完，少发几次请求
  const seen: number[] = []
  const star: number[] = []
  const moves = new Map<string, number[]>()
  const archive: number[] = []
  const trash: number[] = []
  const handled = new Set<number>()
  for (const t of targets) {
    for (const rule of rules) {
      if (!ruleMatches(rule, t)) continue
      handled.add(t.uid)
      let left = false
      for (const a of rule.actions) {
        if (a.type === 'markRead') {
          seen.push(t.uid)
          outcome.quiet.add(t.uid)
        } else if (a.type === 'silent') outcome.quiet.add(t.uid)
        else if (a.type === 'star') star.push(t.uid)
        else if (a.type === 'move' && a.target && !left) {
          moves.set(a.target, [...(moves.get(a.target) || []), t.uid])
          left = true
        } else if (a.type === 'archive' && !left) {
          archive.push(t.uid)
          left = true
        } else if (a.type === 'trash' && !left) {
          trash.push(t.uid)
          left = true
        }
      }
      // 邮件已经被移走，后面的规则不用再看了
      if (left) {
        outcome.gone.add(t.uid)
        break
      }
    }
  }

  const run = async (what: string, fn: () => Promise<unknown>, uids: number[]): Promise<void> => {
    if (!uids.length) return
    try {
      await fn()
    } catch (err) {
      console.warn(`[规则 ${account.email}] ${what}失败：`, (err as Error).message)
      // 没做成的，邮件还在收件箱里
      for (const u of uids) outcome.gone.delete(u)
    }
  }
  // 先做标记，再做移动（移走以后原来的编号就不在这个文件夹里了）
  await run('标为已读', () => setFlag(account, folder, seen, 'seen', true), seen)
  await run('加星标', () => setFlag(account, folder, star, 'flagged', true), star)
  for (const [target, uids] of moves) await run('移动', () => moveMessage(account, folder, uids, target), uids)
  await run('归档', async () => {
    const ok = await archiveMessage(account, folder, archive)
    if (!ok) throw new Error('这个邮箱没有归档文件夹')
  }, archive)
  await run('删除', () => deleteMessage(account, folder, trash), trash)

  // 被移走的邮件不用再提醒；没移成功的还在收件箱里，照常提醒
  for (const u of outcome.gone) outcome.quiet.add(u)
  outcome.handled = handled.size
  if (outcome.handled) console.warn(`[规则 ${account.email}] 处理了 ${outcome.handled} 封新邮件`)
  return outcome
}

const summaryTarget = (m: MessageSummary): RuleTarget => ({
  uid: m.uid,
  from: m.from.map((a) => `${a.name || ''} ${a.address || ''}`.trim()).join(' ').toLowerCase(),
  to: m.to.map((a) => `${a.name || ''} ${a.address || ''}`.trim()).join(' ').toLowerCase(),
  subject: m.subject || ''
})

/** 对收件箱里现有的邮件（最新的一页）运行一次规则，返回处理的数量 */
export async function runOnInbox(account: Account): Promise<number> {
  const page = await listMessages(account, 'INBOX')
  const out = await applyRules(account, 'INBOX', page.messages.map(summaryTarget))
  return out.handled
}
