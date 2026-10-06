// 日历邀请：读懂邮件里的 .ics（iCalendar），并生成「接受 / 待定 / 拒绝」的回复。
// 不依赖第三方库，只处理邮件邀请里常见的那部分：单个活动、时间、地点、组织者、参加者

import type { CalendarInvite, InviteAnswer } from '../shared/types'

interface Prop {
  name: string
  params: Record<string, string>
  value: string
  /** 原来的整行（回复时原样带回去） */
  line: string
}

/** 把「折行」的内容接回去，再拆成一行一个属性 */
function readProps(ics: string): Prop[] {
  const lines = ics.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const out: Prop[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    // 冒号前面是名字和参数；参数值可以用引号括起来，里面可能有冒号
    let inQuote = false
    let at = -1
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') inQuote = !inQuote
      else if (ch === ':' && !inQuote) {
        at = i
        break
      }
    }
    if (at < 1) continue
    const head = line.slice(0, at)
    const value = line.slice(at + 1)
    const parts: string[] = []
    let cur = ''
    inQuote = false
    for (const ch of head) {
      if (ch === '"') inQuote = !inQuote
      if (ch === ';' && !inQuote) {
        parts.push(cur)
        cur = ''
      } else cur += ch
    }
    parts.push(cur)
    const params: Record<string, string> = {}
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=')
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
    }
    out.push({ name: parts[0].toUpperCase(), params, value, line })
  }
  return out
}

const unescapeText = (v: string): string => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const escapeText = (v: string): string => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

// Outlook 等用 Windows 的时区名，换成通用名字
const WIN_TZ: Record<string, string> = {
  'china standard time': 'Asia/Shanghai',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'utc': 'UTC',
  'gmt standard time': 'Europe/London',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'e. europe standard time': 'Europe/Bucharest',
  'russian standard time': 'Europe/Moscow',
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'aus eastern standard time': 'Australia/Sydney'
}

/** 某个时刻在某个时区比 UTC 快多少毫秒 */
function offsetAt(utc: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const p: Record<string, number> = {}
  for (const x of f.formatToParts(new Date(utc))) if (x.type !== 'literal') p[x.type] = Number(x.value)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return asUtc - Math.floor(utc / 1000) * 1000
}

/** 解析 DTSTART/DTEND：返回毫秒；全天的活动按本机时区的 0 点算 */
function parseTime(p: Prop): { ms: number; allDay: boolean } | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim())
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (m[4] === undefined || p.params.VALUE === 'DATE') return { ms: new Date(y, mo - 1, d).getTime(), allDay: true }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] || 0)]
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false }
  const wall = Date.UTC(y, mo - 1, d, h, mi, s)
  const tzName = (p.params.TZID || '').trim()
  if (tzName) {
    const tz = WIN_TZ[tzName.toLowerCase()] || tzName
    try {
      // 先猜一个，再按那一刻的时差修正（夏令时切换的那几小时也够用）
      let guess = wall - offsetAt(wall, tz)
      guess = wall - offsetAt(guess, tz)
      if (Number.isFinite(guess)) return { ms: guess, allDay: false }
    } catch {
      // 不认识的时区名，按本机时区算
    }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false }
}

const mailOf = (v: string): string => v.replace(/^mailto:/i, '').trim().toLowerCase()

const RULE_DAYS: Record<string, string> = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' }
function describeRule(rule: string): string {
  const r: Record<string, string> = {}
  for (const part of rule.split(';')) {
    const [k, v] = part.split('=')
    if (k && v) r[k.toUpperCase()] = v
  }
  const every = Number(r.INTERVAL) > 1 ? `每 ${r.INTERVAL} ` : '每'
  let text = ''
  if (r.FREQ === 'DAILY') text = `${every}天`
  else if (r.FREQ === 'WEEKLY') text = `${every}周` + (r.BYDAY ? `（${r.BYDAY.split(',').map((d) => RULE_DAYS[d.replace(/^[-+\d]+/, '')] || d).join('、')}）` : '')
  else if (r.FREQ === 'MONTHLY') text = `${every}个月`
  else if (r.FREQ === 'YEARLY') text = `${every}年`
  else return '重复活动'
  return `重复活动：${text}重复`
}

export interface ParsedInvite {
  invite: CalendarInvite
  /** 回复时要原样带回去的几行 */
  lines: { dtstart: string; dtend?: string; organizer?: string; recurrenceId?: string; rrule?: string }
  /** 受邀人里的邮箱地址（小写） */
  attendeeAddresses: string[]
}

/** 读邮件里的日历内容；读不出来（不是邀请、没有开始时间）就返回 undefined */
export function parseInvite(ics: string): ParsedInvite | undefined {
  if (!ics || ics.length > 400_000 || !/BEGIN:VCALENDAR/i.test(ics)) return undefined
  const props = readProps(ics)
  const method = (props.find((p) => p.name === 'METHOD')?.value || 'PUBLISH').trim().toUpperCase()
  const begin = props.findIndex((p) => p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT')
  if (begin < 0) return undefined
  // 只看第一个活动（整个重复系列的例外场次不在这里展示）
  let end = props.findIndex((p, i) => i > begin && p.name === 'END' && p.value.toUpperCase() === 'VEVENT')
  if (end < 0) end = props.length
  const ev = props.slice(begin + 1, end)
  const get = (name: string): Prop | undefined => ev.find((p) => p.name === name)

  const startProp = get('DTSTART')
  const start = startProp && parseTime(startProp)
  if (!startProp || !start) return undefined
  const endProp = get('DTEND')
  let endMs = endProp ? parseTime(endProp)?.ms : undefined
  if (endMs === undefined) {
    const dur = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(get('DURATION')?.value || '')
    if (dur) endMs = start.ms + (((Number(dur[1] || 0) * 7 + Number(dur[2] || 0)) * 24 + Number(dur[3] || 0)) * 60 + Number(dur[4] || 0)) * 60000
  }
  if (endMs !== undefined && endMs < start.ms) endMs = undefined

  const orgProp = get('ORGANIZER')
  const organizer = orgProp && mailOf(orgProp.value) ? { name: unescapeText(orgProp.params.CN || ''), address: mailOf(orgProp.value) } : undefined
  const attendeeProps = ev.filter((p) => p.name === 'ATTENDEE')
  const status = (get('STATUS')?.value || '').trim().toUpperCase()
  const rrule = get('RRULE')

  let reply: CalendarInvite['reply']
  if (method === 'REPLY' && attendeeProps[0]) {
    const a = attendeeProps[0]
    reply = { name: unescapeText(a.params.CN || ''), address: mailOf(a.value), status: (a.params.PARTSTAT || 'NEEDS-ACTION').toLowerCase() }
  }
  const description = unescapeText(get('DESCRIPTION')?.value || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const invite: CalendarInvite = {
    method: (['REQUEST', 'CANCEL', 'REPLY', 'PUBLISH'].includes(method) ? method : 'PUBLISH') as CalendarInvite['method'],
    uid: (get('UID')?.value || '').trim().slice(0, 300),
    sequence: Number(get('SEQUENCE')?.value) || 0,
    summary: unescapeText(get('SUMMARY')?.value || '').slice(0, 300) || '（没有标题的活动）',
    start: start.ms,
    end: endMs,
    allDay: start.allDay,
    location: unescapeText(get('LOCATION')?.value || '').slice(0, 300) || undefined,
    description: description ? description.slice(0, 600) : undefined,
    organizer,
    attendees: attendeeProps.length,
    reply,
    recurring: rrule ? describeRule(rrule.value) : undefined,
    cancelled: method === 'CANCEL' || status === 'CANCELLED'
  }
  return {
    invite,
    lines: {
      dtstart: startProp.line,
      dtend: endProp?.line,
      organizer: orgProp?.line,
      recurrenceId: get('RECURRENCE-ID')?.line,
      rrule: rrule?.line
    },
    attendeeAddresses: attendeeProps.map((p) => mailOf(p.value))
  }
}

const fold = (line: string): string => {
  const out: string[] = []
  let rest = line
  while (rest.length > 60) {
    out.push(rest.slice(0, 60))
    rest = ' ' + rest.slice(60)
  }
  out.push(rest)
  return out.join('\r\n')
}

const STATUS_TEXT: Record<InviteAnswer, { part: string; verb: string }> = {
  accepted: { part: 'ACCEPTED', verb: '已接受' },
  tentative: { part: 'TENTATIVE', verb: '待定' },
  declined: { part: 'DECLINED', verb: '已拒绝' }
}

/** 生成给组织者的日历回复（iTIP REPLY） */
export function buildReply(parsed: ParsedInvite, me: { name: string; address: string }, answer: InviteAnswer): { ics: string; subject: string; text: string } {
  const { invite, lines } = parsed
  const st = STATUS_TEXT[answer]
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const cn = me.name ? `;CN=${JSON.stringify(me.name.replace(/"/g, ''))}` : ''
  const body = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Bluebird//Mail//CN',
    'VERSION:2.0',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${invite.uid}`,
    `SEQUENCE:${invite.sequence}`,
    `DTSTAMP:${now}`,
    lines.dtstart,
    ...(lines.dtend ? [lines.dtend] : []),
    ...(lines.recurrenceId ? [lines.recurrenceId] : []),
    `SUMMARY:${escapeText(invite.summary)}`,
    ...(lines.organizer ? [lines.organizer] : []),
    `ATTENDEE;PARTSTAT=${st.part}${cn}:mailto:${me.address}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ]
  return {
    ics: body.map(fold).join('\r\n') + '\r\n',
    subject: `${st.verb}：${invite.summary}`,
    text: `${me.name || me.address} ${st.verb}了活动「${invite.summary}」。`
  }
}
