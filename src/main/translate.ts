// 邮件翻译：用 DeepL 的接口。密钥是用户自己的，只保存在本机（用 Windows 系统加密），不会交给界面，更不会上传到别处。
// 界面把要翻译的一段段文字交过来，这里分批发给 DeepL，再按原来的顺序交回去。

import { httpFetch } from './net'
import { getSettings, getTranslateKey } from './store'

const TARGETS = new Set(['ZH', 'ZH-HANT', 'EN-US', 'EN-GB', 'JA', 'KO', 'DE', 'FR', 'ES', 'RU', 'IT', 'PT-BR'])

/** 免费版的密钥以 :fx 结尾，用的是另一个地址 */
function base(key: string): string {
  return key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
}

function fail(status: number): Error {
  if (status === 403 || status === 401) return new Error('DeepL 不认这个密钥，请到「设置 → 翻译」里检查一下')
  if (status === 456) return new Error('DeepL 这个月的免费额度用完了，下个月会自动恢复')
  if (status === 429 || status === 529) return new Error('翻译请求太频繁了，过一会儿再试')
  if (status === 413) return new Error('这封邮件太长，DeepL 一次翻译不了')
  return new Error(`DeepL 没有接受这次请求（${status}）`)
}

async function call(path: string, key: string, body?: unknown): Promise<unknown> {
  let res: Response
  try {
    res = await httpFetch(base(key) + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      useProxy: getSettings().translate.useProxy,
      timeoutMs: 30000
    })
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    throw new Error(
      aborted
        ? '翻译服务半天没有回应，请过一会儿再试'
        : `连不上翻译服务（DeepL）。${getSettings().translate.useProxy ? '请确认代理软件开着' : '如果一直连不上，可以到「设置 → 翻译」里打开「通过代理连接」'}`
    )
  }
  if (!res.ok) throw fail(res.status)
  return res.json()
}

function needKey(): string {
  const key = getTranslateKey()
  if (!key) throw new Error('还没有填 DeepL 密钥。请到「设置 → 翻译」里填上')
  return key
}

/**
 * 翻译一批文字，返回同样数量、同样顺序的译文。
 * xml：文字里带着简单的标记（用来保住加粗、链接这些格式），让 DeepL 原样保留标记、只翻译文字
 */
export async function translateTexts(texts: string[], xml: boolean): Promise<{ texts: string[]; from: string }> {
  const key = needKey()
  const target = TARGETS.has(getSettings().translate.target) ? getSettings().translate.target : 'ZH'
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '')).slice(0, 2000)
  if (list.reduce((n, t) => n + t.length, 0) > 200000) throw new Error('这封邮件太长了，没法整封翻译')
  const out: string[] = []
  let from = ''
  // 一次请求最多 40 段、约 5 万字，多了分几次发
  let i = 0
  while (i < list.length) {
    const batch: string[] = []
    let size = 0
    while (i < list.length && batch.length < 40 && (batch.length === 0 || size + list[i].length <= 50000)) {
      batch.push(list[i])
      size += list[i].length
      i++
    }
    const data = (await call('/v2/translate', key, {
      text: batch,
      target_lang: target,
      ...(xml ? { tag_handling: 'xml' } : { preserve_formatting: true })
    })) as { translations?: { text?: string; detected_source_language?: string }[] }
    const got = data.translations || []
    if (got.length !== batch.length) throw new Error('翻译服务返回的内容不完整，请再试一次')
    for (const t of got) out.push(String(t.text ?? ''))
    from ||= got.find((t) => t.detected_source_language)?.detected_source_language || ''
  }
  return { texts: out, from }
}

/** 密钥能不能用、这个月用了多少额度 */
export async function translateUsage(key?: string): Promise<{ used: number; limit: number }> {
  const data = (await call('/v2/usage', key || needKey())) as { character_count?: number; character_limit?: number }
  return { used: data.character_count ?? 0, limit: data.character_limit ?? 0 }
}
