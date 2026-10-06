// 邮件翻译（界面这一半）：把邮件正文拆成一段一段的文字交给主进程去翻译，再把译文放回原来的位置。
// 版式、图片、链接都保持原样，只换文字。

import type { MessageDetail } from '../../shared/types'

export interface Translated {
  subject: string
  html?: string
  text: string
  /** 原文是什么语言（DeepL 判断的，比如 EN、JA） */
  from: string
  /** 邮件太长，只翻译了前面一部分 */
  partial: boolean
}

type Send = (texts: string[], xml: boolean) => Promise<{ texts: string[]; from: string }>

// 行内的标签：它们和旁边的文字是同一句话里的，要放在一起翻译
const INLINE = new Set([
  'A', 'B', 'I', 'U', 'S', 'EM', 'STRONG', 'SPAN', 'FONT', 'SMALL', 'BIG', 'SUB', 'SUP', 'MARK', 'ABBR', 'CITE', 'Q', 'LABEL', 'INS', 'DEL', 'TT', 'NOBR', 'STRIKE',
  'BR', 'IMG', 'WBR'
])
const VOID = new Set(['BR', 'IMG', 'WBR'])
// 这些里面的东西不翻译
const SKIP = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'PRE', 'CODE', 'TEXTAREA', 'SVG', 'MATH', 'OBJECT', 'IFRAME', 'SELECT'])

// 一封邮件最多翻译这么多字，再长就只翻译前面的（免费额度一个月 50 万字，一封超长的群发邮件不能把它吃掉一大块）
const LIMIT = 40000

const HAS_WORD = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ۿ฀-๿぀-ヿ㐀-鿿가-힯]{2}/
const ONLY_LINK = /^\s*(?:https?:\/\/\S+|www\.\S+|[^\s@]+@[^\s@]+\.[^\s@]+)\s*$/i

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inlineOnly(el: Element): boolean {
  if (!INLINE.has(el.tagName)) return false
  for (const d of Array.from(el.querySelectorAll('*'))) if (!INLINE.has(d.tagName)) return false
  return true
}

/** 一段要翻译的内容：同一个上级元素里连在一起的文字和行内标签 */
interface Run {
  nodes: Node[]
  /** 交给翻译服务的样子：文字照旧，标签换成 <g1>…</g1>、<x2/> 这样的简单记号 */
  xml: string
  /** 记号对应的原来的元素 */
  marks: Map<string, Element>
  lead: string
  tail: string
}

function serialize(nodes: Node[], marks: Map<string, Element>, counter: { n: number }): string {
  let out = ''
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) out += esc(node.nodeValue || '')
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const id = String(++counter.n)
      marks.set(id, el)
      out += VOID.has(el.tagName) ? `<x${id}/>` : `<g${id}>${serialize(Array.from(el.childNodes), marks, counter)}</g${id}>`
    }
  }
  return out
}

function collect(root: Element): Run[] {
  const runs: Run[] = []
  const counter = { n: 0 }
  const flush = (nodes: Node[]): void => {
    if (!nodes.length) return
    const plain = nodes.map((n) => n.textContent || '').join('')
    if (!HAS_WORD.test(plain) || ONLY_LINK.test(plain)) return
    const marks = new Map<string, Element>()
    const xml = serialize(nodes, marks, counter)
    const lead = /^\s*/.exec(xml)![0]
    const tail = /\s*$/.exec(xml.slice(lead.length))![0]
    runs.push({ nodes, xml: xml.slice(lead.length, xml.length - tail.length), marks, lead, tail })
  }
  const walk = (el: Element): void => {
    let run: Node[] = []
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) run.push(child)
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element
        if (SKIP.has(c.tagName.toUpperCase())) {
          flush(run)
          run = []
        } else if (inlineOnly(c)) run.push(c)
        else {
          flush(run)
          run = []
          walk(c)
        }
      }
    }
    flush(run)
  }
  walk(root)
  return runs
}

/** 把译文（带简单记号）还原成真正的节点：记号换回原来的元素，文字换成译文 */
function rebuild(doc: Document, translated: string, run: Run): DocumentFragment | null {
  const parsed = new DOMParser().parseFromString(`<r>${translated}</r>`, 'application/xml')
  if (parsed.getElementsByTagName('parsererror').length || !parsed.documentElement) return null
  const build = (from: Node, into: Node): void => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE) into.appendChild(doc.createTextNode(n.nodeValue || ''))
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = (n as Element).tagName
        const orig = run.marks.get(tag.slice(1))
        if (!orig) {
          // 翻译服务自己加出来的标记：只留里面的文字
          build(n, into)
        } else if (tag[0] === 'x') into.appendChild(orig.cloneNode(true))
        else {
          const copy = orig.cloneNode(false)
          build(n, copy)
          into.appendChild(copy)
        }
      }
    }
  }
  const frag = doc.createDocumentFragment()
  build(parsed.documentElement, frag)
  return frag
}

const stripMarks = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export async function translateMail(detail: MessageDetail, send: Send): Promise<Translated> {
  let from = ''
  let partial = false

  // 主题
  let subject = detail.subject
  if (HAS_WORD.test(detail.subject)) {
    const r = await send([detail.subject], false)
    subject = r.texts[0] || detail.subject
    from = r.from
  }

  // 纯文字的邮件：按空行分段
  if (!detail.html) {
    const parts = detail.text.split(/(\n\s*\n)/)
    const idx: number[] = []
    let used = 0
    parts.forEach((p, i) => {
      if (i % 2 || !HAS_WORD.test(p) || ONLY_LINK.test(p)) return
      if (used + p.length > LIMIT) {
        partial = true
        return
      }
      used += p.length
      idx.push(i)
    })
    if (idx.length) {
      const r = await send(idx.map((i) => parts[i]), false)
      idx.forEach((i, k) => (parts[i] = r.texts[k] ?? parts[i]))
      from ||= r.from
    }
    return { subject, text: parts.join(''), from, partial }
  }

  // HTML 邮件
  const doc = new DOMParser().parseFromString(detail.html, 'text/html')
  const all = collect(doc.body)
  const runs: Run[] = []
  let used = 0
  for (const run of all) {
    if (used + run.xml.length > LIMIT) {
      partial = true
      break
    }
    used += run.xml.length
    runs.push(run)
  }
  if (runs.length) {
    const r = await send(runs.map((x) => x.xml), true)
    from ||= r.from
    runs.forEach((run, i) => {
      const t = r.texts[i]
      const first = run.nodes[0]
      const parent = first.parentNode
      if (!t || !parent) return
      // 记号被翻译服务弄乱了就退一步：这一段不保留加粗、链接，只放译文
      const frag = rebuild(doc, t, run) ?? (() => {
        const f = doc.createDocumentFragment()
        f.appendChild(doc.createTextNode(stripMarks(t)))
        return f
      })()
      if (run.lead) frag.insertBefore(doc.createTextNode(' '), frag.firstChild)
      if (run.tail) frag.appendChild(doc.createTextNode(' '))
      parent.insertBefore(frag, first)
      run.nodes.forEach((n) => n.parentNode?.removeChild(n))
    })
  }
  // head 里的样式要带上，不然版式就乱了
  const styles = Array.from(doc.head.querySelectorAll('style'))
    .map((s) => s.outerHTML)
    .join('')
  return { subject, html: styles + doc.body.innerHTML, text: doc.body.textContent || detail.text, from, partial }
}

/**
 * 这封邮件看起来是不是外语（相对于简体/繁体中文）：正文里的字大多不是汉字，或者夹着不少日文假名、韩文。
 * 只用来决定要不要主动提示「翻译」，判断不准也不要紧
 */
export function looksForeign(detail: { subject: string; text: string }): boolean {
  const sample = `${detail.subject}\n${detail.text}`.slice(0, 3000)
  const han = (sample.match(/[㐀-鿿]/g) || []).length
  const kana = (sample.match(/[぀-ヿ가-힯]/g) || []).length
  const other = (sample.match(/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-ۿ฀-๿]/g) || []).length
  const letters = han + kana + other
  if (letters < 40) return false
  if (kana > 15 && kana / letters > 0.08) return true
  // 拉丁字母按词算更公平：一个汉字约等于半个英文单词的分量
  return han / (han + kana + other / 4) < 0.3
}

const LANG_NAMES: Record<string, string> = {
  EN: '英语', JA: '日语', KO: '韩语', DE: '德语', FR: '法语', ES: '西班牙语', RU: '俄语', IT: '意大利语', PT: '葡萄牙语', ZH: '中文', NL: '荷兰语', PL: '波兰语',
  TR: '土耳其语', AR: '阿拉伯语', ID: '印尼语', UK: '乌克兰语', SV: '瑞典语', DA: '丹麦语', FI: '芬兰语', CS: '捷克语', EL: '希腊语', HU: '匈牙利语', RO: '罗马尼亚语',
  NB: '挪威语', BG: '保加利亚语', VI: '越南语', TH: '泰语'
}
export const langName = (code: string): string => LANG_NAMES[(code || '').toUpperCase().split('-')[0]] || code || '外语'

export const TARGET_LANGS: { id: string; label: string }[] = [
  { id: 'ZH', label: '简体中文' },
  { id: 'ZH-HANT', label: '繁体中文' },
  { id: 'EN-US', label: '英语' },
  { id: 'JA', label: '日语' },
  { id: 'KO', label: '韩语' },
  { id: 'DE', label: '德语' },
  { id: 'FR', label: '法语' },
  { id: 'ES', label: '西班牙语' },
  { id: 'RU', label: '俄语' }
]
