// 邮件操作：文件夹、列表、读信、标记、删除、搜索、附件

import type { ImapFlow } from 'imapflow'
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser'
import type {
  Account,
  Address,
  AttachmentInfo,
  Folder,
  MessageDetail,
  MessagePage,
  MessageSummary,
  SpecialUse
} from '../../shared/types'
import { dropBackground, withClient, withMailbox, type Lane } from './imap'
import { isConnectionError } from './errors'
import { classify, CLASSIFY_HEADERS, parseHeaders } from './classify'
import { noteContacts } from '../contacts'
import { getData } from '../userdata'
import { loadPreviews, savePreviews } from '../cache'

const PAGE_SIZE = 50

const SPECIAL_MAP: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged'
}

const SPECIAL_LABEL: Record<SpecialUse, string> = {
  inbox: '收件箱',
  drafts: '草稿箱',
  sent: '已发送',
  archive: '归档',
  all: '所有邮件',
  flagged: '已加星标',
  junk: '垃圾邮件',
  trash: '已删除'
}

const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'drafts', 'sent', 'archive', 'flagged', 'all', 'junk', 'trash']

/** 按文件夹名称兜底识别（有些服务器不报告 special-use） */
function guessSpecial(path: string): SpecialUse | undefined {
  const p = path.toLowerCase()
  if (p === 'inbox') return 'inbox'
  if (/^(sent|sent messages|sent items|已发送|已发送邮件)$/.test(p)) return 'sent'
  if (/^(drafts|draft|草稿箱|草稿)$/.test(p)) return 'drafts'
  if (/^(trash|deleted|deleted messages|deleted items|已删除|垃圾箱)$/.test(p)) return 'trash'
  if (/^(junk|spam|junk e-mail|垃圾邮件)$/.test(p)) return 'junk'
  if (/^(archive|归档)$/.test(p)) return 'archive'
  return undefined
}

// 每个账号的文件夹缓存，用来找「已删除」「已发送」的路径
const folderCache = new Map<string, Folder[]>()

export async function listFolders(account: Account): Promise<Folder[]> {
  const list = await withClient(account, (c) => c.list({ statusQuery: { messages: true, unseen: true } }))
  const used = new Set<SpecialUse>()
  const folders: Folder[] = []

  for (const f of list) {
    if (f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')) continue
    let special: SpecialUse | undefined = f.specialUse ? SPECIAL_MAP[f.specialUse] : undefined
    if (!special) special = guessSpecial(f.path)
    // 同一种特殊文件夹只认第一个
    if (special && used.has(special)) special = undefined
    if (special) used.add(special)

    const parts = f.delimiter ? f.path.split(f.delimiter) : [f.path]
    folders.push({
      path: f.path,
      name: f.name,
      displayName: special ? SPECIAL_LABEL[special] : f.name,
      specialUse: special,
      unseen: f.status?.unseen ?? 0,
      total: f.status?.messages ?? 0,
      depth: special ? 0 : Math.max(0, parts.length - 1),
      delimiter: f.delimiter || undefined
    })
  }

  folders.sort((a, b) => {
    const ia = a.specialUse ? SPECIAL_ORDER.indexOf(a.specialUse) : 99
    const ib = b.specialUse ? SPECIAL_ORDER.indexOf(b.specialUse) : 99
    if (ia !== ib) return ia - ib
    return a.path.localeCompare(b.path, 'zh-CN')
  })

  folderCache.set(account.id, folders)
  return folders
}

async function findSpecial(account: Account, use: SpecialUse): Promise<string | undefined> {
  let folders = folderCache.get(account.id)
  if (!folders) folders = await listFolders(account)
  return folders.find((f) => f.specialUse === use)?.path
}

export function findSpecialPath(account: Account, use: SpecialUse): Promise<string | undefined> {
  return findSpecial(account, use)
}

// ---------------- 邮件列表 ----------------

interface BodyNode {
  type?: string
  disposition?: string
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
  childNodes?: BodyNode[]
}

function hasAttachment(node?: BodyNode): boolean {
  if (!node) return false
  if (node.disposition?.toLowerCase() === 'attachment') return true
  if (node.childNodes?.length) return node.childNodes.some(hasAttachment)
  const type = node.type?.toLowerCase() || ''
  const named = !!(node.dispositionParameters?.filename || node.parameters?.name)
  return named && !type.startsWith('text/') && node.disposition?.toLowerCase() !== 'inline'
}

function toAddr(list?: { name?: string; address?: string }[]): Address[] {
  return (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }))
}

const SUMMARY_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  internalDate: true,
  size: true,
  bodyStructure: true,
  // 多取几个邮件头，用来判断是真人来信、系统通知还是订阅邮件
  headers: CLASSIFY_HEADERS
}

// imapflow 的 fetch 结果，这里只用到其中几个字段
interface FetchedMessage {
  uid: number
  seq: number
  flags?: Set<string>
  size?: number
  internalDate?: Date | string
  bodyStructure?: unknown
  headers?: Buffer
  envelope?: {
    date?: Date | string
    subject?: string
    messageId?: string
    inReplyTo?: string
    from?: { name?: string; address?: string }[]
    to?: { name?: string; address?: string }[]
  }
}

/** 从邮件头里取出所有 <...> 形式的 Message-ID */
function messageIds(text?: string): string[] {
  return (text || '').match(/<[^<>\s]+>/g) || []
}

/** 引用链特别长时只留最早的一个（话题的第一封）和最近的 29 个 */
function trimRefs(ids: string[]): string[] {
  return ids.length > 30 ? [ids[0], ...ids.slice(-29)] : ids
}

function toSummary(m: FetchedMessage, accountId: string, folder: string): MessageSummary {
  const date = m.envelope?.date || m.internalDate
  const sender = (m.envelope?.from?.[0]?.address || '').toLowerCase()
  return {
    category: getData().priority.includes(sender) ? 'personal' : classify(sender, m.headers, m.envelope?.from?.[0]?.name || '', m.envelope?.subject || ''),
    accountId,
    folder,
    uid: m.uid,
    seq: m.seq,
    subject: m.envelope?.subject || '',
    from: toAddr(m.envelope?.from),
    to: toAddr(m.envelope?.to),
    date: date ? new Date(date).toISOString() : new Date(0).toISOString(),
    seen: !!m.flags?.has('\\Seen'),
    flagged: !!m.flags?.has('\\Flagged'),
    answered: !!m.flags?.has('\\Answered'),
    hasAttachments: hasAttachment(m.bodyStructure as BodyNode),
    size: m.size || 0,
    messageId: messageIds(m.envelope?.messageId)[0],
    // 回复的是哪封、引用过哪些：串会话用。个别邮件引用链特别长，留最后 30 个就够了
    refs: trimRefs([...new Set([...messageIds(m.headers ? parseHeaders(m.headers)['references'] : ''), ...messageIds(m.envelope?.inReplyTo)])])
  }
}

// 个别邮件服务器不支持只取部分邮件头；遇到过一次就记住，之后不再请求（那个账号的邮件都算「个人」）
const noHeaderFetch = new Set<string>()

async function collect(
  client: ImapFlow,
  account: Account,
  path: string,
  range: string | number[],
  byUid: boolean
): Promise<MessageSummary[]> {
  const run = async (query: object): Promise<MessageSummary[]> => {
    const out: MessageSummary[] = []
    for await (const msg of client.fetch(range, query, { uid: byUid })) {
      out.push(toSummary(msg as unknown as FetchedMessage, account.id, path))
    }
    return out
  }
  const { headers: _headers, ...plain } = SUMMARY_QUERY
  if (noHeaderFetch.has(account.id)) return run(plain)
  try {
    return await run(SUMMARY_QUERY)
  } catch (err) {
    if (!client.usable) throw err
    console.warn(`[${account.email}] 取邮件头失败，改用不带分类的方式`, (err as Error).message)
    noHeaderFetch.add(account.id)
    return run(plain)
  }
}

/** 按 UID 取指定的几封邮件（置顶和推迟的邮件不一定在最新一页里） */
export async function listByUids(account: Account, path: string, uids: number[]): Promise<MessageSummary[]> {
  if (!uids.length) return []
  return withMailbox(account, path, (client) => collect(client, account, path, uids, true))
}

/**
 * 取一页邮件。before 是上一页里最小的序号，不传则取最新一页。
 */
export async function listMessages(account: Account, path: string, before?: number, lane: Lane = 'main'): Promise<MessagePage> {
  return withMailbox(account, path, async (client) => {
    const mb = client.mailbox
    const exists = mb ? mb.exists : 0
    const end = before ? Math.min(before - 1, exists) : exists
    if (end < 1) return { messages: [], total: exists, hasMore: false }
    const start = Math.max(1, end - PAGE_SIZE + 1)
    const messages = await collect(client, account, path, `${start}:${end}`, false)
    messages.sort((a, b) => b.seq - a.seq)
    harvestContacts(account, path, messages)
    return { messages, total: exists, hasMore: start > 1 }
  }, lane)
}

/** 从列表里顺手攒联系人：「已发送」里的收件人，以及给你来过信的真人 */
function harvestContacts(account: Account, path: string, messages: MessageSummary[]): void {
  try {
    const folders = folderCache.get(account.id)
    // 还不知道这是什么文件夹（文件夹列表没取回来）就先不记，免得把垃圾邮件的发件人记成联系人
    if (!folders) return
    const use = folders.find((f) => f.path === path)?.specialUse
    if (use === 'drafts' || use === 'junk' || use === 'trash') return
    const me = account.email.toLowerCase()
    for (const m of messages) {
      // 同一封信在几个文件夹里各有一份（比如 Gmail 的收件箱和「所有邮件」）时只算一次
      const id = m.messageId ? `${account.id}|${m.messageId}` : `${account.id}|${path}|${m.uid}`
      if (use === 'sent') noteContacts(m.to, 'sent', id)
      else if (m.category === 'personal' && m.from[0] && m.from[0].address.toLowerCase() !== me) {
        // 回复过的来信：等于给这个人发过信
        noteContacts([m.from[0]], m.answered ? 'sent' : 'received', id)
      }
    }
  } catch {
    // 攒联系人失败不影响看邮件
  }
}

/** 启动后在后台看一眼「已发送」：把最近通过信的人记成联系人，写信时能补全，来信时也不会被当成陌生人 */
export async function warmContacts(account: Account): Promise<void> {
  const folders = folderCache.get(account.id) ?? (await listFolders(account))
  const sent = folders.find((f) => f.specialUse === 'sent')
  if (sent) await listMessages(account, sent.path, undefined, 'bg')
}

/**
 * 在一个账号的所有文件夹里搜索（垃圾邮件、已删除、草稿除外）。
 * Gmail 的「所有邮件」已经包含了全部，所以只搜它一个。
 */
export async function searchEverywhere(account: Account, query: string): Promise<MessagePage> {
  const q = query.trim()
  if (!q) return { messages: [], total: 0, hasMore: false }
  const folders = folderCache.get(account.id) ?? (await listFolders(account))
  const all = folders.find((f) => f.specialUse === 'all')
  let targets = all
    ? [all]
    : folders.filter((f) => f.specialUse !== 'trash' && f.specialUse !== 'junk' && f.specialUse !== 'drafts' && f.total > 0)
  // 文件夹特别多的邮箱：收件箱、已发送、归档优先，其余按邮件多少排，最多搜 20 个
  const rank = (f: Folder): number => (f.specialUse === 'inbox' ? 0 : f.specialUse === 'sent' ? 1 : f.specialUse === 'archive' ? 2 : 3)
  targets = [...targets].sort((a, b) => rank(a) - rank(b) || b.total - a.total).slice(0, 20)
  const messages: MessageSummary[] = []
  const seen = new Set<string>()
  let firstError = ''
  let ok = 0
  for (const [i, f] of targets.entries()) {
    try {
      // 要一个文件夹一个文件夹地搜，比较慢：走后台那条连接，搜索期间照样能打开邮件
      const page = await searchMessages(account, f.path, q, 'bg', i < 2)
      // 每个文件夹最多取最近的 40 封，免得一个大文件夹把结果占满
      for (const m of page.messages.slice(0, 40)) {
        // 同一封信在几个文件夹里各有一份时只列一次
        if (m.messageId) {
          if (seen.has(m.messageId)) continue
          seen.add(m.messageId)
        }
        messages.push(m)
      }
      ok++
    } catch (err) {
      const text = (err as Error).message
      firstError ||= text
      // 服务器连不上：后面的文件夹也一样连不上，不用一个个去等超时
      if (/连接服务器失败|找不到服务器|超时|登录失败|授权/.test(text)) break
    }
  }
  if (!ok && firstError) throw new Error(firstError)
  messages.sort((a, b) => b.date.localeCompare(a.date))
  const top = messages.slice(0, 200)
  return { messages: top, total: top.length, hasMore: false }
}

// 有的邮箱（QQ、网易）的服务器搜索不完整：不认「几个条件任选其一」、不认中文、或者干脆搜不到正文。
// 所以搜索分几步：先一次问服务器；没结果或服务器报错，就一个条件一个条件地问；
// 还是没有，就把最近的邮件头取下来，在本地比对主题、发件人、收件人。记住哪个账号用了哪一步，日志里能看到。
const LOCAL_SCAN = 500

/**
 * 文字里是否有这个词。服务器是按「包含这几个字母」来找的：搜 MUSE 会连 museum、amused 一起返回。
 * 英文、数字按整词比对（前后不能紧挨着别的字母数字）；中文等没有空格分词的文字，包含就算。
 */
function containsTerm(text: string, q: string): boolean {
  const t = (text || '').toLowerCase()
  const needle = q.trim().toLowerCase()
  if (!needle) return false
  if (!/[\p{L}\p{N}]/u.test(needle[0]) || !/[\p{L}\p{N}]/u.test(needle[needle.length - 1])) return t.includes(needle)
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const cjk = /[㐀-鿿぀-ヿ가-힯]/
  const lead = cjk.test(needle[0]) ? '' : '(?<![\\p{L}\\p{N}])'
  const tail = cjk.test(needle[needle.length - 1]) ? '' : '(?![\\p{L}\\p{N}])'
  try {
    return new RegExp(lead + esc + tail, 'u').test(t)
  } catch {
    return t.includes(needle)
  }
}

function matchesLocal(m: MessageSummary, q: string): boolean {
  const hay = [m.subject, ...m.from.flatMap((a) => [a.name, a.address]), ...m.to.flatMap((a) => [a.name, a.address])]
  return hay.some((t) => containsTerm(t || '', q))
}

/** 邮件头对不上的，再下载正文开头一段核对（服务器的正文搜索只是「包含」，不一定真是这个词） */
const BODY_CHECK = 40
async function bodyHas(client: ImapFlow, uids: number[], q: string): Promise<Set<number>> {
  const ok = new Set<number>()
  if (!uids.length) return ok
  const raws: { uid: number; source: Buffer }[] = []
  for await (const m of client.fetch(uids, { uid: true, source: { maxLength: 65536 } }, { uid: true })) {
    if (m.source) raws.push({ uid: m.uid, source: m.source })
  }
  for (const r of raws) {
    try {
      const parsed = await simpleParser(r.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true })
      const text = [parsed.text || '', parsed.html ? htmlToText(parsed.html) : ''].join('\n')
      if (containsTerm(text, q)) ok.add(r.uid)
    } catch {
      // 解析不了的不算命中
    }
  }
  return ok
}

export async function searchMessages(
  account: Account,
  path: string,
  query: string,
  lane: Lane = 'main',
  deep = true
): Promise<MessagePage> {
  const q = query.trim()
  if (!q) return listMessages(account, path, undefined, lane)
  return withMailbox(
    account,
    path,
    async (client) => {
      const isGmail = account.imap.host === 'imap.gmail.com'
      // 一次服务器搜索；服务器不认这个条件时返回 null（断线才算真出错）
      const ask = async (criteria: object): Promise<number[] | null> => {
        try {
          return (await client.search(criteria, { uid: true })) || []
        } catch (err) {
          if (!client.usable || isConnectionError(err)) throw err
          console.warn(`[搜索 ${account.email}] 服务器不接受这个搜索条件：`, (err as Error).message)
          return null
        }
      }
      const finish = async (uids: number[]): Promise<MessagePage> => {
        const latest = [...uids].sort((a, b) => b - a).slice(0, 100)
        if (!latest.length) return { messages: [], total: 0, hasMore: false }
        let messages = await collect(client, account, path, latest, true)
        messages.sort((a, b) => b.uid - a.uid)
        // 服务器按「包含」来找，会带出不相干的邮件（MUSE → museum）：这里再严格核对一遍。
        // Gmail 的搜索自己是按词来的，不再核对
        if (!isGmail) {
          const hit = messages.filter((m) => matchesLocal(m, q))
          const rest = messages.filter((m) => !matchesLocal(m, q)).slice(0, BODY_CHECK)
          let inBody = new Set<number>()
          try {
            inBody = await bodyHas(client, rest.map((m) => m.uid), q)
          } catch (err) {
            if (!client.usable || isConnectionError(err)) throw err
            console.warn(`[搜索 ${account.email}] 核对正文失败：`, (err as Error).message)
          }
          const before = messages.length
          messages = messages.filter((m) => hit.includes(m) || inBody.has(m.uid))
          if (messages.length < before) console.warn(`[搜索 ${account.email}] 服务器返回 ${before} 封，核对后留下 ${messages.length} 封`)
        }
        return { messages, total: messages.length, hasMore: false }
      }

      // 第一步：一次问完
      const first = await ask(isGmail ? { gmraw: q } : { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] })
      if (isGmail) return finish(first || [])
      if (first?.length) {
        const page = await finish(first)
        // 服务器返回的全是不相干的邮件（有的邮箱不认搜索条件，直接返回一大堆）：核对后没有留下，就继续往下找
        if (page.messages.length || !deep) return page
      }

      // 全部邮箱搜索时，只有收件箱和已发送这两个主要文件夹才往下找，其余的问一次就算了，免得搜索拖太久
      if (!deep) return { messages: [], total: 0, hasMore: false }

      // 第二步：一个条件一个条件地问，结果合起来
      const found = new Set<number>()
      for (const criteria of [{ subject: q }, { from: q }, { to: q }, { text: q }]) {
        for (const uid of (await ask(criteria)) || []) found.add(uid)
      }
      if (found.size) {
        console.warn(`[搜索 ${account.email}] 一次问完没有结果，分开问找到了 ${found.size} 封`)
        return finish([...found])
      }

      // 第三步：服务器怎么问都没有。取最近的邮件头在本地比对（只比对主题、发件人、收件人）
      const exists = client.mailbox ? client.mailbox.exists : 0
      if (exists < 1) return { messages: [], total: 0, hasMore: false }
      const start = Math.max(1, exists - LOCAL_SCAN + 1)
      const recent = await collect(client, account, path, `${start}:${exists}`, false)
      const hit = recent.filter((m) => matchesLocal(m, q)).sort((a, b) => b.uid - a.uid)
      if (hit.length) console.warn(`[搜索 ${account.email}] 服务器没有结果，在最近 ${recent.length} 封里本地比对找到了 ${hit.length} 封`)
      return { messages: hit.slice(0, 100), total: hit.length, hasMore: false }
    },
    lane
  )
}

/**
 * 找出「已发送」里属于某个会话的邮件：也就是你回复这几封邮件时发出去的信。
 * ids 是会话里各封邮件的 Message-ID，最早的排在前面。
 */
// 有的邮箱按邮件头搜索特别慢（要把整个「已发送」翻一遍），甚至干脆不支持。
// 慢过一次、失败过一次的账号，接下来半小时不再去找，免得白白占着连接
const sentLookupOff = new Map<string, number>()
const SENT_LOOKUP_LIMIT = 10000

export async function findSentReplies(account: Account, ids: string[]): Promise<MessageSummary[]> {
  const clean = [...new Set((ids || []).filter((id) => typeof id === 'string' && /^<[^<>\s]{3,300}>$/.test(id)))]
  if (!clean.length) return []
  if ((sentLookupOff.get(account.id) ?? 0) > Date.now()) return []
  const sent = await findSpecial(account, 'sent')
  if (!sent) return []
  // 一次问的条件不能太多：第一封（话题的起点）加上最近的十来封
  const asked = clean.length > 12 ? [clean[0], ...clean.slice(-11)] : clean
  const pause = (): void => void sentLookupOff.set(account.id, Date.now() + 30 * 60 * 1000)
  let started = Date.now()
  let timer: NodeJS.Timeout | undefined
  let reject: (err: Error) => void = () => undefined
  const giveUp = new Promise<never>((_, r) => {
    reject = r
  })
  // 从真正开始找的那一刻算时间（前面排队等连接的时间不算）。等太久就不等了：
  // 把后台那条连接断掉（让服务器别再找了），这个账号先歇半小时
  const arm = (): void => {
    clearTimeout(timer)
    started = Date.now()
    timer = setTimeout(() => {
      pause()
      dropBackground(account.id)
      reject(new Error('在「已发送」里找回复用的时间太长，先不找了'))
    }, SENT_LOOKUP_LIMIT)
  }
  const work = withMailbox(
    account,
    sent,
    async (client) => {
      arm()
      const or: Record<string, unknown>[] = asked.map((id) => ({ header: { 'in-reply-to': id } }))
      or.push({ header: { references: asked[0] } })
      const uids = (await client.search(or.length > 1 ? { or } : or[0], { uid: true })) || []
      const latest = uids.sort((a, b) => b - a).slice(0, 30)
      if (!latest.length) return []
      const found = await collect(client, account, sent, latest, true)
      // 服务器是按「包含这段文字」来找的，这里再严格核对一遍
      const want = new Set(clean)
      return found.filter((m) => m.refs?.some((r) => want.has(r)))
    },
    'bg'
  )
  try {
    const list = await Promise.race([work, giveUp])
    if (Date.now() - started > 5000) pause()
    return list
  } catch (err) {
    pause()
    // 上面超时以后，原来那次查找迟早会报错，接住它，别让它变成没人管的报错
    work.catch(() => undefined)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ---------------- 文件夹管理 ----------------

function checkFolderName(name: string, delimiter?: string): string {
  const n = String(name || '').trim()
  if (!n) throw new Error('请填写文件夹名称')
  if (n.length > 60) throw new Error('文件夹名称太长了')
  if (/[\x00-\x1f\\/%*"]/.test(n) || (delimiter && n.includes(delimiter))) throw new Error('文件夹名称里不能有 / \\ % * " 这些符号')
  return n
}

function plainFolder(account: Account, path: string): Folder {
  const f = folderCache.get(account.id)?.find((x) => x.path === path)
  if (!f) throw new Error('找不到这个文件夹，请刷新后再试')
  if (f.specialUse) throw new Error('收件箱、已发送这类系统文件夹不能改名或删除')
  return f
}

/** 新建文件夹。parent 是上一级文件夹的路径，不传就建在最外层 */
export async function createFolder(account: Account, name: string, parent?: string): Promise<Folder[]> {
  const folders = folderCache.get(account.id) ?? (await listFolders(account))
  const up = parent ? folders.find((f) => f.path === parent) : undefined
  if (parent && !up) throw new Error('找不到上一级文件夹，请刷新后再试')
  const n = checkFolderName(name, up?.delimiter ?? folders.find((f) => f.delimiter)?.delimiter)
  // 建在某个文件夹下面时，路径用那个文件夹自己的分隔符来拼
  await withClient(account, (c) => c.mailboxCreate(up && up.delimiter ? up.path + up.delimiter + n : up ? [up.path, n] : n))
  return listFolders(account)
}

export async function renameFolder(account: Account, path: string, name: string): Promise<Folder[]> {
  const f = plainFolder(account, path)
  const n = checkFolderName(name, f.delimiter)
  const cut = f.delimiter ? path.lastIndexOf(f.delimiter) : -1
  const next = cut >= 0 ? path.slice(0, cut + 1) + n : n
  if (next === path) return folderCache.get(account.id) ?? listFolders(account)
  // 改名会连带改掉下一级文件夹的路径，它们的置顶、推迟记录就全对不上了，所以先不让改
  const kids = folderCache.get(account.id)?.some((x) => f.delimiter && x.path.startsWith(path + f.delimiter))
  if (kids) throw new Error('这个文件夹里还有下一级文件夹，暂时不能改名。可以先把下一级文件夹移走或删除')
  await withClient(account, (c) => c.mailboxRename(path, next))
  forgetFolder(account.id, path)
  return listFolders(account)
}

/**
 * 删除文件夹，里面的邮件会一起删掉。
 * expectedTotal 是用户在确认框里看到的邮件数：动手之前向服务器再问一遍，对不上（比如刚有邮件被移进来）就不删，让用户重新确认
 */
export async function deleteFolder(account: Account, path: string, expectedTotal: number): Promise<Folder[]> {
  const f = plainFolder(account, path)
  const kids = folderCache.get(account.id)?.some((x) => f.delimiter && x.path.startsWith(path + f.delimiter))
  if (kids) throw new Error('这个文件夹里还有下一级文件夹，请先删除或移走它们')
  await withClient(account, async (c) => {
    const now = (await c.status(path, { messages: true })).messages ?? 0
    if (now !== expectedTotal) {
      throw new Error(`这个文件夹里现在有 ${now} 封邮件，和刚才看到的 ${expectedTotal} 封不一样，所以没有删除。请再确认一次`)
    }
    await c.mailboxDelete(path)
  })
  forgetFolder(account.id, path)
  return listFolders(account)
}

/** 文件夹没了（删除或改名）：内存里记着的它的附件、摘要都清掉，免得以后同名的新文件夹里的邮件拿到旧内容 */
function forgetFolder(accountId: string, path: string): void {
  const prefix = cacheKey(accountId, path, 0).replace(/0$/, '')
  for (const key of [...attachmentCache.keys()]) if (key.startsWith(prefix)) attachmentCache.delete(key)
  for (const key of [...emptyTried]) if (key.startsWith(prefix)) emptyTried.delete(key)
  ensurePreviews()
  let changed = false
  for (const key of [...previewCache.keys()]) {
    if (key.startsWith(prefix)) {
      previewCache.delete(key)
      changed = true
    }
  }
  if (changed) savePreviews(previewCache)
}

// ---------------- 列表摘要 ----------------

// 启动时把上次存在磁盘上的摘要读回来，列表就不用重新向服务器要
let previewCache = new Map<string, string>()
let previewsLoaded = false
function ensurePreviews(): void {
  if (previewsLoaded) return
  previewsLoaded = true
  previewCache = new Map(Object.entries(loadPreviews()))
}

/** 去掉摘要里没法读的东西：方括号里的链接、裸链接、零宽字符、成串的分隔符 */
function cleanSnippetText(text: string): string {
  return text
    .replace(/\[(?:https?:|cid:|data:)[^\]\s]*\]/gi, ' ')
    .replace(/<?https?:\/\/[^\s<>"'）)\]]+>?/gi, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\u2060\ufeff\u00ad\u034f]/g, '')
    .replace(/[-_=*~·•|]{3,}/g, ' ')
}

/** 没有纯文本正文时，从 HTML 里把文字抠出来 */
function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // 邮件被截断时，没闭合的 style/script 一直删到结尾
    .replace(/<(style|script)\b[\s\S]*$/i, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/<[^>]*$/, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&[a-z]{2,8};/gi, ' ')
}

function safeChar(code: number): string {
  try {
    return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' '
  } catch {
    return ' '
  }
}

/** 从正文里提取一行摘要：去掉引用的原文、链接、多余空白 */
function makeSnippet(text: string): string {
  const lines: string[] = []
  for (const raw of cleanSnippetText(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (/^(>|＞)/.test(line)) continue
    // 遇到常见的引用原文分隔线就停止
    if (/^(-{2,}\s*(原始邮件|Original Message|Forwarded message|转发的邮件)|在.{4,60}写道[:：]?$|On .{4,80}wrote:?$|发件人[:：]|From:\s)/i.test(line)) break
    if (line) lines.push(line)
    if (lines.join(' ').length > 200) break
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 180)
}

// 这次运行里已经确认取不到摘要的邮件，避免反复下载
const emptyTried = new Set<string>()

/** 批量取邮件摘要。只下载每封邮件开头一小段，不会把邮件标为已读 */
export async function getPreviews(account: Account, folder: string, uids: number[]): Promise<Record<number, string>> {
  ensurePreviews()
  const out: Record<number, string> = {}
  const missing: number[] = []
  for (const uid of uids) {
    const cached = previewCache.get(cacheKey(account.id, folder, uid))
    // 以前存下来的空摘要、带链接的摘要不算数，重新取一次
    if (cached && !/https?:\/\//i.test(cached)) out[uid] = cached
    else if (cached === '' && emptyTried.has(cacheKey(account.id, folder, uid))) out[uid] = ''
    else missing.push(uid)
  }
  if (!missing.length) return out

  // 摘要是后台慢慢补的，走后台那条连接：一口气要取几十上百封的开头，不能挡着用户打开邮件
  const raws = await withMailbox(
    account,
    folder,
    async (client) => {
      const list: { uid: number; source: Buffer }[] = []
      for await (const m of client.fetch(missing, { uid: true, source: { maxLength: 32768 } }, { uid: true })) {
        if (m.source) list.push({ uid: m.uid, source: m.source })
      }
      return list
    },
    'bg'
  )

  for (const r of raws) {
    let snippet = ''
    try {
      const parsed = await simpleParser(r.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true })
      snippet = makeSnippet(parsed.text || '')
      // 很多通知邮件只有 HTML 正文，纯文本是空的或者只剩一堆链接
      if (snippet.length < 12 && parsed.html) {
        const fromHtml = makeSnippet(htmlToText(parsed.html))
        if (fromHtml.length > snippet.length) snippet = fromHtml
      }
    } catch {
      // 截断的邮件偶尔解析失败，没有摘要也无妨
    }
    const key = cacheKey(account.id, folder, r.uid)
    if (!snippet) emptyTried.add(key)
    previewCache.set(key, snippet)
    out[r.uid] = snippet
  }
  savePreviews(previewCache)
  if (previewCache.size > 8000) {
    let n = 0
    for (const k of previewCache.keys()) {
      previewCache.delete(k)
      if (++n >= 2000) break
    }
  }
  return out
}

// ---------------- 读信 ----------------

// 最近打开的邮件的附件缓存，保存/转发附件时不用再下载一次
const attachmentCache = new Map<string, Attachment[]>()
const cacheKey = (accountId: string, folder: string, uid: number): string => `${accountId}|${folder}|${uid}`

// 附件都放在内存里，除了限制封数，还要限制总大小，免得连着打开几封带大附件的邮件就占掉几百兆
const ATTACHMENT_CACHE_BYTES = 120 * 1024 * 1024

function remember(key: string, atts: Attachment[]): void {
  attachmentCache.delete(key)
  attachmentCache.set(key, atts)
  const bytes = (): number => {
    let n = 0
    for (const list of attachmentCache.values()) for (const a of list) n += a.size || a.content?.length || 0
    return n
  }
  // 最新打开的那一封始终保留
  while (attachmentCache.size > 1 && (attachmentCache.size > 20 || bytes() > ATTACHMENT_CACHE_BYTES)) {
    const oldest = attachmentCache.keys().next().value
    if (oldest === undefined) break
    attachmentCache.delete(oldest)
  }
}

function addrs(v?: AddressObject | AddressObject[]): Address[] {
  if (!v) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.flatMap((o) => o.value.map((a) => ({ name: a.name || '', address: a.address || '' })))
}

const REMOTE_IMG = /<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\/|url\(\s*["']?\s*(https?:)?\/\/|background\s*=\s*["']?\s*https?:/i

/** 把真正的附件挑出来（排除正文里内嵌显示的图片） */
function visibleAttachments(parsed: ParsedMail): AttachmentInfo[] {
  return parsed.attachments
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => !(a.related && a.contentDisposition !== 'attachment'))
    .map(({ a, index }) => ({
      index,
      filename: a.filename || `附件${index + 1}`,
      contentType: a.contentType,
      size: a.size
    }))
}

/** 邮件太大就不提前取（预取是白送的，不值得为它下载一个大附件） */
export const PREFETCH_MAX_BYTES = 2 * 1024 * 1024

export async function getMessage(
  account: Account,
  folder: string,
  uid: number,
  markSeen = true,
  opts: { lane?: Lane; maxSize?: number } = {}
): Promise<MessageDetail> {
  const { source, flags } = await withMailbox(
    account,
    folder,
    async (client) => {
      if (opts.maxSize) {
        const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true })
        if (meta && meta.size && meta.size > opts.maxSize) throw new Error('邮件太大，不提前取')
      }
      const msg = await client.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('这封邮件已经不存在了（可能已在别处被删除或移动）')
      return { source: msg.source, flags: msg.flags }
    },
    opts.lane ?? 'main'
  )
  // 已读标记不用等：正文取回来就先给界面，标记在后面悄悄补上（少一次和服务器来回）
  if (markSeen && !flags?.has('\\Seen')) setFlag(account, folder, uid, 'seen', true).catch(() => undefined)

  // mailparser 默认会把正文里 cid: 引用的内嵌图片替换成 data: 地址
  const parsed = await simpleParser(source)
  remember(cacheKey(account.id, folder, uid), parsed.attachments)

  const html = typeof parsed.html === 'string' ? parsed.html : undefined
  const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []
  const unsub = unsubscribeInfo(parsed)

  return {
    uid,
    accountId: account.id,
    folder,
    subject: parsed.subject || '',
    from: addrs(parsed.from),
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    replyTo: addrs(parsed.replyTo),
    date: (parsed.date || new Date()).toISOString(),
    messageId: parsed.messageId,
    references: refs,
    html,
    text: parsed.text || '',
    hasRemoteImages: !!html && REMOTE_IMG.test(html),
    attachments: visibleAttachments(parsed),
    flagged: !!flags?.has('\\Flagged'),
    unsubscribe: unsub ? (unsub.oneClick && unsub.url ? 'oneclick' : unsub.mailto ? 'mail' : 'link') : undefined,
    unsubscribeInfo: unsub,
    v: 2
  }
}

/**
 * 订阅邮件一般会在邮件头里写明退订方式（List-Unsubscribe）：一个网址、一个邮箱地址，或者两个都有。
 * 如果还带着 List-Unsubscribe-Post，说明这个网址支持「一键退订」，不用打开网页。
 */
function unsubscribeInfo(parsed: ParsedMail): { url?: string; mailto?: string; oneClick: boolean } | undefined {
  const lines = (parsed as unknown as { headerLines?: { key: string; line: string }[] }).headerLines || []
  const value = (key: string): string =>
    (lines.find((l) => l.key === key)?.line || '')
      .replace(/^[^:]*:/, '')
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim()
  const raw = value('list-unsubscribe')
  if (!raw) return undefined
  const targets = (raw.match(/<[^<>]+>/g) || []).map((t) => t.slice(1, -1).replace(/\s+/g, ''))
  const url = targets.find((t) => /^https:\/\//i.test(t)) || targets.find((t) => /^http:\/\//i.test(t))
  const mailto = targets.find((t) => /^mailto:/i.test(t))
  if (!url && !mailto) return undefined
  const oneClick = /List-Unsubscribe=One-Click/i.test(value('list-unsubscribe-post')) && !!url && /^https:/i.test(url)
  return { url, mailto, oneClick }
}

/** 取邮件原文（.eml 的内容），不改变已读状态 */
export async function getRawMessage(account: Account, folder: string, uid: number): Promise<Buffer> {
  return withMailbox(account, folder, async (client) => {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
    if (!msg || !msg.source) throw new Error('这封邮件已经不存在了（可能已在别处被删除或移动）')
    return msg.source
  })
}

/** 取附件内容；缓存里没有就重新下载这封邮件 */
export async function getAttachment(account: Account, folder: string, uid: number, index: number): Promise<Attachment> {
  const key = cacheKey(account.id, folder, uid)
  let atts = attachmentCache.get(key)
  if (!atts) {
    const source = await withMailbox(account, folder, async (client) => {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('这封邮件已经不存在了')
      return msg.source
    })
    atts = (await simpleParser(source)).attachments
    remember(key, atts)
  }
  const att = atts[index]
  if (!att) throw new Error('找不到这个附件')
  return att
}

// ---------------- 标记、移动、删除（都支持一次处理多封） ----------------

type Uids = number | number[]

/** 把 UID 列表切成小段，避免一条 IMAP 命令过长被服务器拒绝 */
function chunks(uids: Uids, size = 200): string[] {
  const list = Array.isArray(uids) ? uids : [uids]
  const out: string[] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size).join(','))
  return out
}

/** 连接中途断了：抛一个带 NoConnection 的错误，让 withMailbox 重连后再试一次 */
function lostConnection(client: ImapFlow): void {
  if (!client.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' })
}

/** imapflow 的移动/删除失败时只返回 false 不报错，这里统一检查 */
function ensure(ok: unknown, client: ImapFlow, message: string): void {
  if (ok) return
  lostConnection(client)
  throw new Error(message)
}

/**
 * 移动邮件。服务器不支持 MOVE 命令时要「先复制再删除」，
 * 必须确认复制成功了才能删原件，否则目标文件夹不存在或已满时邮件就丢了。
 */
async function safeMove(client: ImapFlow, range: string, target: string): Promise<void> {
  if (client.capabilities?.has('MOVE')) {
    ensure(await client.messageMove(range, target, { uid: true }), client, '移动失败：服务器拒绝了这次操作（目标文件夹可能已被删除或改名，请刷新后重试）')
    return
  }
  ensure(await client.messageCopy(range, target, { uid: true }), client, '移动失败：无法复制到目标文件夹（文件夹可能已被删除、改名或已满），邮件仍在原处')
  // 复制已经成功，这一步失败不能整段重来（否则目标文件夹里会多出一份）
  let removed = false
  try {
    removed = !!(await client.messageDelete(range, { uid: true }))
  } catch {
    removed = false
  }
  if (!removed) {
    throw Object.assign(new Error('邮件已复制到目标文件夹，但原处的那一份没能删除，刷新后可以手动删掉'), { noRetry: true })
  }
}

export async function setFlag(
  account: Account,
  folder: string,
  uids: Uids,
  flag: 'seen' | 'flagged' | 'answered',
  value: boolean
): Promise<void> {
  const imapFlag = flag === 'seen' ? '\\Seen' : flag === 'flagged' ? '\\Flagged' : '\\Answered'
  await withMailbox(account, folder, async (client) => {
    for (const range of chunks(uids)) {
      const ok = value
        ? await client.messageFlagsAdd(range, [imapFlag], { uid: true })
        : await client.messageFlagsRemove(range, [imapFlag], { uid: true })
      // 有的文件夹不允许改某些标记，这种情况 imapflow 也返回 false，所以只在断线时才当成出错
      if (!ok) lostConnection(client)
    }
  })
}

/** 把文件夹里的邮件全部标为已读（seen=true）或全部标为未读（seen=false），返回改动的数量 */
export async function markAll(account: Account, folder: string, seen: boolean): Promise<number> {
  return withMailbox(account, folder, async (client) => {
    const uids = (await client.search({ seen: !seen }, { uid: true })) || []
    for (const range of chunks(uids)) {
      const ok = seen
        ? await client.messageFlagsAdd(range, ['\\Seen'], { uid: true })
        : await client.messageFlagsRemove(range, ['\\Seen'], { uid: true })
      if (!ok) lostConnection(client)
    }
    return uids.length
  })
}

/** 清空文件夹（彻底删除里面的所有邮件）。只允许用在「已删除」和「垃圾邮件」上 */
export async function emptyFolder(account: Account, folder: string): Promise<number> {
  const folders = folderCache.get(account.id) ?? (await listFolders(account))
  const use = folders.find((f) => f.path === folder)?.specialUse
  if (use !== 'trash' && use !== 'junk') throw new Error('只能清空「已删除」和「垃圾邮件」文件夹')
  return withMailbox(account, folder, async (client) => {
    const uids = (await client.search({ all: true }, { uid: true })) || []
    for (const range of chunks(uids)) {
      ensure(await client.messageDelete(range, { uid: true }), client, '清空失败：服务器拒绝了删除操作')
    }
    return uids.length
  })
}

export async function deleteMessage(account: Account, folder: string, uids: Uids): Promise<void> {
  const trash = await findSpecial(account, 'trash')
  await withMailbox(account, folder, async (client) => {
    for (const range of chunks(uids)) {
      if (trash && trash !== folder) {
        await safeMove(client, range, trash)
      } else {
        // 已经在「已删除」里，或者没有「已删除」文件夹：彻底删除
        ensure(await client.messageDelete(range, { uid: true }), client, '删除失败：服务器拒绝了这次操作')
      }
    }
  })
}

export async function moveMessage(account: Account, folder: string, uids: Uids, target: string): Promise<void> {
  if (target === folder) return
  await withMailbox(account, folder, async (client) => {
    for (const range of chunks(uids)) {
      await safeMove(client, range, target)
    }
  })
}

/** 归档；返回 false 表示这个邮箱没有归档文件夹 */
export async function archiveMessage(account: Account, folder: string, uids: Uids): Promise<boolean> {
  // Gmail 没有单独的归档文件夹，移到「所有邮件」就等于去掉收件箱标签
  const archive = (await findSpecial(account, 'archive')) || (account.provider === 'gmail' ? await findSpecial(account, 'all') : undefined)
  if (!archive || archive === folder) return false
  await moveMessage(account, folder, uids, archive)
  return true
}

export async function appendMessage(account: Account, folder: string, raw: Buffer, flags: string[]): Promise<void> {
  await withClient(account, async (client) => {
    await client.append(folder, raw, flags)
  })
}

export function forgetAccount(accountId: string): void {
  folderCache.delete(accountId)
  for (const key of [...attachmentCache.keys()]) {
    if (key.startsWith(accountId + '|')) attachmentCache.delete(key)
  }
  ensurePreviews()
  let changed = false
  for (const key of [...previewCache.keys()]) {
    if (key.startsWith(accountId + '|')) {
      previewCache.delete(key)
      changed = true
    }
  }
  if (changed) savePreviews(previewCache)
}

/** 用户在设置里点了「清除缓存」：内存里的摘要也要清掉，否则过几秒又会被写回磁盘 */
export function resetMemoryCaches(): void {
  previewsLoaded = true
  // 清空原来那个对象而不是换一个新的：等着写盘的定时器手里拿的是它
  previewCache.clear()
  emptyTried.clear()
  attachmentCache.clear()
}
