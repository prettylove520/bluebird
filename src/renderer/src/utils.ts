import type { AiMail } from '../../shared/ai'
import type { Address, MessageDetail } from '../../shared/types'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n: number): string => String(n).padStart(2, '0')

/** 列表里的短时间：今天显示时刻，一周内显示星期，今年显示月日 */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime()) || d.getTime() === 0) return ''
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= startOfToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (t >= startOfToday - 86400000) return '昨天'
  if (t >= startOfToday - 6 * 86400000) return WEEK[d.getDay()]
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 列表里按时间分组的标题 */
export function dateGroup(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime()) || d.getTime() === 0) return '更早'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const t = d.getTime()
  if (t >= startOfToday) return '今天'
  if (t >= startOfToday - 86400000) return '昨天'
  if (t >= startOfToday - 6 * 86400000) return '最近一周'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月`
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

/** 读信页的完整时间 */
export function fullDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function displayName(a?: Address): string {
  if (!a) return '未知发件人'
  return a.name || a.address.split('@')[0] || a.address
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

export function joinAddresses(list: Address[]): string {
  return list.map(formatAddress).join(', ')
}

const AVATAR_COLORS = ['#2f6f5e', '#3d5a99', '#8a4f7d', '#a35a2c', '#4b7a2a', '#6a5acd', '#2c7c96', '#9a3f4a']

export function avatarColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

/** 头像上的字：中文名取最后一个字，英文取首字母 */
export function avatarText(a?: Address): string {
  const name = (a?.name || a?.address || '?').trim()
  const cjk = name.match(/[一-鿿]/g)
  if (cjk && cjk.length) return cjk[cjk.length - 1]
  return name.charAt(0).toUpperCase()
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 纯文本邮件转成 HTML，网址变成链接 */
export function textToHtml(text: string): string {
  const escaped = escapeHtml(text)
  const linked = escaped.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1">$1</a>')
  return `<div class="fm-plain">${linked}</div>`
}

const EMAIL_BASE_CSS = `
html,body{margin:0;padding:0;background:#fff;}
html{overflow-y:hidden;overflow-x:auto;}
body{padding:8px 32px 24px;color:#1f2328;font:14px/1.6 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif;word-wrap:break-word;overflow-wrap:anywhere;}
img{max-width:100%;}
table{max-width:100%;}
pre{white-space:pre-wrap;}
a{color:#2f73f6;}
.fm-plain{white-space:pre-wrap;font-family:inherit;}
blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #d5dbe1;color:#57606a;}
`

// 深色模式：把整页颜色反过来（白底变深灰、黑字变浅色），再把图片反回去保持原样
const EMAIL_DARK_CSS = `
html{background:#fff;filter:invert(.9) hue-rotate(180deg);}
img,video,picture,svg,[background],[style*="background-image"],[style*="background:url"]{filter:invert(1) hue-rotate(180deg);}
`

/** 去掉邮件 HTML 里会自动跳转或执行的东西（iframe 本身已禁用脚本，这里再加一层保险） */
function stripDangerous(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
}

/** 生成放进沙箱 iframe 的完整页面；默认不加载远程图片，防止追踪 */
export function buildEmailDocument(detail: MessageDetail, allowRemote: boolean, dark = false): string {
  const remote = allowRemote ? ' https: http:' : ''
  const csp = [
    "default-src 'none'",
    `img-src data: cid:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    'media-src data:'
  ].join('; ')
  const body = detail.html ? stripDangerous(detail.html) : textToHtml(detail.text)
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    '<base target="_blank">' +
    `<style>${EMAIL_BASE_CSS}${dark ? EMAIL_DARK_CSS : ''}</style></head><body>${body}</body></html>`
  )
}

/** 打印 / 存 PDF 用的版面：顶上带主题、发件人、时间，正文始终用浅色 */
export function buildPrintDocument(detail: MessageDetail, allowRemote: boolean): string {
  const remote = allowRemote ? ' https: http:' : ''
  const csp = ["default-src 'none'", `img-src data: cid:${remote}`, `style-src 'unsafe-inline'${remote}`, `font-src data:${remote}`].join('; ')
  const body = detail.html ? stripDangerous(detail.html) : textToHtml(detail.text)
  const row = (label: string, value: string): string =>
    value ? `<tr><td class="k">${label}</td><td>${escapeHtml(value)}</td></tr>` : ''
  const head =
    `<div class="bb-print-head"><h1>${escapeHtml(detail.subject || '（无主题）')}</h1><table>` +
    row('发件人', joinAddresses(detail.from)) +
    row('收件人', joinAddresses(detail.to)) +
    row('抄送', joinAddresses(detail.cc)) +
    row('时间', fullDate(detail.date)) +
    (detail.attachments.length ? row('附件', detail.attachments.map((a) => a.filename).join('、')) : '') +
    '</table></div>'
  const css =
    '.bb-print-head{font-family:"Microsoft YaHei UI","Segoe UI",Arial,sans-serif;border-bottom:1px solid #ccc;margin:0 0 18px;padding:0 0 12px;color:#111}' +
    '.bb-print-head h1{font-size:18px;margin:0 0 10px}' +
    '.bb-print-head table{border-collapse:collapse;font-size:12.5px}' +
    '.bb-print-head td{padding:2px 0;vertical-align:top}' +
    '.bb-print-head td.k{color:#666;padding-right:14px;white-space:nowrap}'
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<title>${escapeHtml(detail.subject || '邮件')}</title>` +
    `<style>${EMAIL_BASE_CSS}${css}</style></head><body>${head}${body}</body></html>`
  )
}

const DROP_TAGS =
  'script,style,link,meta,base,iframe,frame,frameset,object,embed,form,input,button,select,textarea,title,svg,math,' +
  'noscript,xmp,noembed,noframes,plaintext,listing,template,video,audio,source,track,picture,canvas,applet,dialog'

/** 链接类属性只放行这几种开头，其余一律去掉 */
function urlAllowed(name: string, value: string, allowRemote: boolean): boolean {
  const v = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase()
  if (!v) return true
  if (name === 'href') return /^(https?:|mailto:|tel:|#)/.test(v)
  // 图片：内嵌的随时可以；远程的只有用户点过「显示图片」才留
  if (/^(data:image\/(png|x-png|jpe?g|pjpeg|gif|webp|bmp);|cid:)/.test(v)) return true
  return allowRemote && /^https?:/.test(v)
}

/**
 * 回复/转发时把原邮件引用进编辑器。编辑器在应用自己的页面里，
 * 所以必须清洗：去掉脚本、样式表、事件属性；不允许远程图片时把它们删掉。
 */
export function sanitizeForQuote(html: string, allowRemote: boolean): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll(DROP_TAGS).forEach((el) => el.remove())
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim().toLowerCase()
      if (name.startsWith('on') || name === 'srcset' || name === 'srcdoc' || name === 'ping' || name === 'formaction') {
        el.removeAttribute(attr.name)
      } else if (name === 'href' || name === 'src' || name === 'background' || name === 'poster' || name === 'action' || name === 'xlink:href') {
        if (!urlAllowed(name, attr.value, allowRemote)) el.removeAttribute(attr.name)
      } else if (name === 'style') {
        // 会加载外部资源的写法、会盖住编辑器以外界面的定位，整条样式去掉
        if (/expression\s*\(|image-set|position\s*:\s*(fixed|absolute|sticky)|behavior\s*:|@import/.test(value)) el.removeAttribute(attr.name)
        else if (/url\s*\(/.test(value) && !(allowRemote && /url\s*\(\s*["']?\s*https?:/.test(value))) {
          // 只去掉带 url() 的那几条，颜色、字号这些照留
          const kept = attr.value
            .split(';')
            .filter((d) => d.trim() && !/url\s*\(/i.test(d))
            .join(';')
          if (kept) el.setAttribute('style', kept)
          else el.removeAttribute(attr.name)
        }
      } else if ((name === 'class' || name === 'id') && el.tagName !== 'A') el.removeAttribute(attr.name)
    }
    // 远程图片被去掉地址以后只剩一个空壳，直接删掉
    if (el.tagName === 'IMG' && !el.getAttribute('src')) el.remove()
  })
  return doc.body.innerHTML
}

/** 把邮件正文的 HTML 转成 Markdown。邮件的排版千奇百怪，这里只求文字、链接、列表、标题不丢 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll(DROP_TAGS).forEach((el) => el.remove())
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent || '').replace(/\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    const inner = (): string => [...el.childNodes].map(walk).join('')
    const flat = (): string => inner().replace(/\s+/g, ' ').trim()
    if (/^h[1-6]$/.test(tag)) {
      const t = flat()
      return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t}\n\n` : ''
    }
    switch (tag) {
      case 'br':
        return '\n'
      case 'hr':
        return '\n\n---\n\n'
      case 'strong':
      case 'b': {
        const t = flat()
        return t ? `**${t}**` : ''
      }
      case 'em':
      case 'i': {
        const t = flat()
        return t ? `*${t}*` : ''
      }
      case 'a': {
        const t = flat()
        const href = el.getAttribute('href') || ''
        if (!/^(https?:|mailto:)/i.test(href)) return t
        if (!t || t === href) return href
        return `[${t}](${href})`
      }
      case 'img': {
        const src = el.getAttribute('src') || ''
        const alt = (el.getAttribute('alt') || '').trim()
        return /^https?:/i.test(src) && alt ? `![${alt}](${src})` : ''
      }
      case 'ul':
      case 'ol': {
        let n = 0
        const lines = [...el.children]
          .filter((c) => c.tagName === 'LI')
          .map((li) => `${tag === 'ol' ? `${++n}.` : '-'} ${walk(li).replace(/\s*\n\s*/g, ' ').trim()}`)
        return `\n\n${lines.join('\n')}\n\n`
      }
      case 'tr': {
        const cells = [...el.children].map((c) => walk(c).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
        return cells.length ? cells.join(' | ') + '\n' : ''
      }
      case 'blockquote': {
        const t = inner().trim()
        return t ? `\n\n${t.split('\n').map((l) => '> ' + l).join('\n')}\n\n` : ''
      }
      case 'pre':
        return `\n\n\`\`\`\n${el.textContent || ''}\n\`\`\`\n\n`
      case 'p':
      case 'div':
      case 'table':
      case 'section':
      case 'article':
      case 'header':
      case 'footer':
      case 'li':
        return `\n\n${inner()}\n\n`
      default:
        return inner()
    }
  }
  return walk(doc.body)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 整封邮件的 Markdown 或纯文字版本，用于复制 */
export function mailAsText(detail: MessageDetail, markdown: boolean): string {
  const body = detail.html ? htmlToMarkdown(detail.html) : detail.text.trim()
  const plain = (t: string): string =>
    t
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/^#{1,6} /gm, '')
  const lines = [
    ['发件人', joinAddresses(detail.from)],
    ['收件人', joinAddresses(detail.to)],
    ['抄送', joinAddresses(detail.cc)],
    ['时间', fullDate(detail.date)]
  ].filter(([, v]) => v)
  if (markdown) {
    return `# ${detail.subject || '（无主题）'}\n\n${lines.map(([k, v]) => `- **${k}：** ${v}`).join('\n')}\n\n---\n\n${body}\n`
  }
  return `${detail.subject || '（无主题）'}\n${lines.map(([k, v]) => `${k}：${v}`).join('\n')}\n\n${plain(body)}\n`
}

export function quoteHeader(detail: MessageDetail): string {
  const from = detail.from[0]
  return `在 ${fullDate(detail.date)}，${escapeHtml(from ? formatAddress(from) : '对方')} 写道：`
}

export function prefixSubject(subject: string, prefix: 'Re' | 'Fwd'): string {
  const re = prefix === 'Re' ? /^(re|回复|答复)\s*[:：]/i : /^(fwd?|转发)\s*[:：]/i
  return re.test(subject.trim()) ? subject : `${prefix}: ${subject}`
}

/** 「稍后处理」和「定时发送」用的几个常用时间 */
export function timePresets(now = new Date()): { label: string; at: number }[] {
  const at = (dayOffset: number, hour: number): number => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, 0, 0, 0)
    return d.getTime()
  }
  const out: { label: string; at: number }[] = []
  const h = now.getHours()
  out.push({ label: '3 小时后', at: now.getTime() + 3 * 3600 * 1000 })
  if (h < 17) out.push({ label: '今天晚上 20:00', at: at(0, 20) })
  out.push({ label: '明天上午 9:00', at: at(1, 9) })
  out.push({ label: '后天上午 9:00', at: at(2, 9) })
  // 下周一；今天就是周一时指的是七天后
  const toMonday = (8 - now.getDay()) % 7 || 7
  out.push({ label: '下周一上午 9:00', at: at(toMonday, 9) })
  return out
}

/** 把时间写成「今天 20:00」「明天 9:00」「10月8日 9:00」这样 */
export function friendlyTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const diff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0) / 86400000)
  const time = `${d.getHours()}:${pad(d.getMinutes())}`
  if (diff === 0) return `今天 ${time}`
  if (diff === 1) return `明天 ${time}`
  if (diff === 2) return `后天 ${time}`
  // 不是今年的要带上年份，不然去年的备份看着像刚做的
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

/** datetime-local 输入框需要的格式 */
export function toLocalInput(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 账号小图标上的字：取显示名称的第一个字，没有名称时取邮箱地址的第一个字 */
export function accountInitial(a: { name: string; email: string }): string {
  return ((a.name || '').trim() || a.email).charAt(0).toUpperCase()
}

// 常见邮箱的叫法；不在这里面的用域名的第一段
const PROVIDER_TAGS: Record<string, string> = {
  qq: 'QQ',
  foxmail: 'Foxmail',
  '163': '163',
  '126': '126',
  yeah: 'Yeah',
  '139': '139',
  sina: '新浪',
  sohu: '搜狐',
  aliyun: '阿里云',
  gmail: 'Gmail',
  googlemail: 'Gmail',
  outlook: 'Outlook',
  hotmail: 'Hotmail',
  live: 'Live',
  icloud: 'iCloud',
  me: 'iCloud',
  yahoo: 'Yahoo',
  proton: 'Proton',
  protonmail: 'Proton'
}

/**
 * 每个邮箱在列表里显示的短标签：用户自己起了就用自己的；
 * 没起的按邮箱服务商取（QQ、Gmail、公司域名…），两个邮箱撞名了就改用 @ 前面的那一段来区分
 */
export function accountTags(accounts: { id: string; email: string; tag?: string }[]): Record<string, string> {
  const auto = (email: string): string => {
    const first = ((email.split('@')[1] || '').toLowerCase().replace(/^(mail|vip|exmail)\./, '').split('.')[0] || '').trim()
    return PROVIDER_TAGS[first] || (first ? first.charAt(0).toUpperCase() + first.slice(1, 8) : '邮箱')
  }
  const base = accounts.map((a) => (a.tag || '').trim() || auto(a.email))
  const count = new Map<string, number>()
  for (const b of base) count.set(b, (count.get(b) || 0) + 1)
  const out: Record<string, string> = {}
  accounts.forEach((a, i) => {
    const custom = (a.tag || '').trim()
    out[a.id] = custom || ((count.get(base[i]) || 0) > 1 ? a.email.split('@')[0].slice(0, 8) || base[i] : base[i])
  })
  return out
}

/** 账号小图标上的字：取标签的头一两个字（QQ、Gm、16、公…），比只用名字的第一个字好认——几个邮箱的显示名称经常是同一个 */
export function tagMark(tag: string): string {
  const t = (tag || '').trim()
  if (!t) return '?'
  // 汉字一个就够占满了；字母数字取两个
  return /^[\x00-\x7f]{2}/.test(t) ? t.slice(0, 2) : t.charAt(0)
}

/** 邮件的纯文字正文；只有 HTML 的邮件就从 HTML 里取出文字 */
export function plainText(d: MessageDetail): string {
  if (d.text && d.text.trim()) return d.text
  if (!d.html) return ''
  try {
    const doc = new DOMParser().parseFromString(d.html, 'text/html')
    doc.querySelectorAll('style,script,head').forEach((n) => n.remove())
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n')
  } catch {
    return ''
  }
}

/** 交给 AI 的邮件内容 */
export function aiMailOf(d: MessageDetail): AiMail {
  return { from: joinAddresses(d.from), to: joinAddresses(d.to), subject: d.subject, date: d.date, text: plainText(d) }
}
