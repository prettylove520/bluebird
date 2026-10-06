// 智能收件箱的分类：根据邮件头和发件人地址，把邮件分成「个人 / 通知 / 订阅」
// 只是经验规则，不会百分之百准确；重要发件人永远算「个人」

import type { MailCategory } from '../../shared/types'

/** 列表里需要额外取的几个邮件头 */
export const CLASSIFY_HEADERS = ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'x-auto-response-suppress', 'references']

// 机器发信常用的地址前缀
const AUTO_SENDER =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|mailer(-daemon)?|postmaster|bounces?|system|service|services|admin|account|accounts|security|verify|verification|billing|invoice|receipt|order|orders|ship(ping)?|delivery|support|helpdesk|auto|robot|bot|ccsvc)([-_.+]|$)|(^|[-_.+])(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer)([-_.+]|$)/i

// 一看域名就知道是机器发的：比如 Google Voice 把短信转成邮件用的地址
const AUTO_HOST = /@(txt\.voice\.google\.com|.*\.bounces\.google\.com|.*\.amazonses\.com|.*\.sendgrid\.net|.*\.mailgun\.org|.*\.mcsv\.net)$/i

export function parseHeaders(raw?: Buffer | string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw) return out
  // 折行的头（下一行以空白开头）先拼回一行
  const text = raw.toString().replace(/\r?\n[ \t]+/g, ' ')
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

// 个人常用的免费邮箱：从这些域名发来的信，除非邮件头明确说是群发，否则一律算「个人」
const FREE_MAIL =
  /@(qq|vip\.qq|foxmail|163|126|yeah|139|189|sina|sohu|aliyun|gmail|googlemail|outlook|hotmail|live|msn|icloud|me|yahoo|proton|protonmail)\.(com|cn|net|me|com\.cn)$/i

// 专门用来群发的子域名，例如 message.cmbchina.com、edm.xxx.com
const BULK_HOST = /@(e?mail|e?dm|news(letter)?|notice|notify|notifications?|message|msg|service|info|mkt|marketing|promo|campaign|bounce|mailer|system|post|send(er)?|em\d*|mg|smtp)\d*[-.]/i

// 发件人显示名里的机构特征
const ORG_NAME =
  /银行|信用卡|支付宝|微信支付|财付通|证券|保险|基金|阿里云|腾讯云|华为云|客服|官方|通知|提醒|系统|管理员|账户中心|帐户中心|安全中心|快递|速运|物流|航空|铁路|12306|运营商|移动|联通|电信|no[-_ ]?reply|\b(bank|team|support|security|notifications?|billing|accounts?|service)\b/i

// 主题里明确是系统通知的字样（只用特征很强的词，避免把正常往来误判）
const NOTICE_SUBJECT =
  /验证码|校验码|动态码|邮箱验证|验证邮件|验证你的|验证您的|新短信|语音留言|未接来电|order (summary|confirmation|receipt)|new (text message|voicemail)|missed call|登录提醒|登录通知|异地登录|安全提醒|密码重置|重置密码|找回密码|电子发票|发票已开具|交易提醒|扣款通知|还款提醒|已发货|已签收|verification code|verify your|security alert|password reset|reset your password|confirm your (email|account)|your order|has shipped/i

// 主题里明显是推广的字样
const PROMO_SUBJECT =
  /满意度调查|问卷调查|有奖调研|用户调研|\bsurvey\b|优惠|折扣|特惠|促销|大促|限时|秒杀|福利|红包|代金券|优惠券|满减|免费领|免费试用|立减|低至|上新|新品|直播|邀请您参加|活动报名|周刊|月刊|周报|精选|双\s?1[12]|618|\d+\s?% ?off|\bsale\b|\bdeals?\b|\boffer\b|discount|coupon|webinar|newsletter|digest|unsubscribe/i

export function classify(fromAddress: string, rawHeaders?: Buffer | string, fromName = '', subject = ''): MailCategory {
  const h = parseHeaders(rawHeaders)
  const local = fromAddress.split('@')[0] || ''
  const auto = h['auto-submitted'] && h['auto-submitted'].toLowerCase() !== 'no'
  if (AUTO_SENDER.test(local) || AUTO_HOST.test(fromAddress) || auto) return 'notification'
  const bulk = /^(bulk|list|junk)$/i.test(h['precedence'] || '')
  if (h['list-unsubscribe'] || h['list-id'] || bulk) return 'newsletter'
  // 下面是没有群发邮件头时的补充判断。个人邮箱发来的信不参与，免得误伤
  if (!fromAddress || FREE_MAIL.test(fromAddress)) return 'personal'
  // 回复、转发的信是有人在往来，不按主题里的字样判断
  if (!/^\s*(re|fwd?|回复|答复|转发)\s*[:：]/i.test(subject)) {
    if (NOTICE_SUBJECT.test(subject)) return 'notification'
    if (PROMO_SUBJECT.test(subject)) return 'newsletter'
  }
  if (BULK_HOST.test(fromAddress) || ORG_NAME.test(fromName)) return 'notification'
  return 'personal'
}
