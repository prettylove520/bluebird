// 主进程和界面共用的数据类型

export type AuthType = 'password' | 'oauth2'
export type OAuthProvider = 'google' | 'microsoft'

export interface ServerConfig {
  host: string
  port: number
  /** true = 直接 SSL/TLS（如 993/465）；false = 明文后 STARTTLS（如 587/143） */
  secure: boolean
}

export interface Account {
  id: string
  email: string
  /** 发件人显示名 */
  name: string
  /** 预设服务商 id，例如 qq、163、gmail；自定义为 custom */
  provider: string
  imap: ServerConfig
  smtp: ServerConfig
  auth: { type: AuthType; oauthProvider?: OAuthProvider; user?: string }
  /** 是否通过设置里的代理连接（Gmail/Outlook 在国内通常需要） */
  useProxy: boolean
  /** 发送后是否需要客户端自己把邮件存到「已发送」（Gmail/Outlook 服务器会自动保存） */
  appendSent: boolean
  color: string
  /** 签名（纯文本，可多行） */
  signature?: string
  /** 用户给这个邮箱起的短标签（比如「公司」「私人」），列表里用它标出邮件是哪个邮箱收到的；没填就自动取一个 */
  tag?: string
}

export interface ProxySettings {
  enabled: boolean
  host: string
  port: number
}

export interface OAuthSettings {
  googleClientId: string
  googleClientSecret: string
  microsoftClientId: string
}

export interface GeneralSettings {
  theme: 'system' | 'light' | 'dark'
  /** 点关闭按钮时缩到托盘，继续在后台收信 */
  closeToTray: boolean
  /** 开机自动启动（只对安装版生效） */
  launchAtLogin: boolean
  /** 自动检查、下载新版本（只对安装版生效） */
  autoUpdate: boolean
  /** 界面布局：wide 是整屏宽列表、点开后整屏阅读；split 是列表和阅读并排 */
  layout: 'wide' | 'split'
  /** 打开程序时先显示主屏 */
  showHome: boolean
  /** 主屏背景：auto 跟随时间，custom 用自己选的图片，其余是内置背景的编号 */
  homeBackground: string
  /** 写新邮件时默认用哪个账号，空字符串表示跟随当前查看的账号 */
  defaultAccountId: string
  /** 左下角的更新提示过多少秒自动收起，0 是不自动收起（设置图标上的红点一直在） */
  updateHideSeconds: number
}

export interface ReadingSettings {
  /** 打开邮件时自动标为已读 */
  markReadOnOpen: boolean
  /** 自动加载远程图片（会让发件人知道你读了邮件） */
  autoLoadImages: boolean
  /** 深色模式下，把邮件正文也变成深色（图片保持原样） */
  darkMail: boolean
  /** 列表里显示正文摘要 */
  showPreview: boolean
  density: 'comfortable' | 'compact'
  confirmDelete: boolean
  /** 在收件箱里显示「个人 / 通知 / 订阅」分类 */
  smartInbox: boolean
  /** 删除或归档当前邮件后：打开下一封，还是回到列表 */
  afterRemove: 'next' | 'none'
  /** 把同一个话题来回的邮件合并成一条 */
  threads: boolean
  /** 陌生人第一次来信时，在信的上方问一下「接受还是屏蔽」 */
  gatekeeper: boolean
}

export interface ComposeSettings {
  /** 回复时带上原文 */
  quoteOnReply: boolean
  /** 正文字号（像素） */
  fontSize: number
  /** 没写主题时发送前提醒 */
  warnEmptySubject: boolean
  /** 点发送后等几秒再真正发出，期间可以撤销；0 表示立即发出 */
  undoSeconds: number
}

export interface NotifySettings {
  enabled: boolean
  /** 只对真人来信弹通知，系统通知和订阅邮件不打扰 */
  onlyPersonal: boolean
  sound: boolean
  /** 通知里显示发件人和主题；关闭后只提示「有新邮件」 */
  showContent: boolean
  quietEnabled: boolean
  /** 免打扰时间段，格式 HH:mm */
  quietStart: string
  quietEnd: string
  /** 每隔多少秒向服务器问一次有没有新邮件 */
  checkSeconds: number
}

/** 邮件翻译（DeepL）。密钥不在这里，单独加密保存 */
export interface TranslateSettings {
  /** 翻译成哪种语言（DeepL 的语言代码，ZH 是简体中文） */
  target: string
}

/** AI 助手（写邮件、读邮件）。密钥不在这里，单独加密保存 */
export interface AiSettings {
  enabled: boolean
  /** 服务商预设的 id（见 shared/ai.ts） */
  preset: string
  style: 'anthropic' | 'openai'
  baseUrl: string
  model: string
  /** 选「其他」时给这个服务商起的名字，只用来显示 */
  customName: string
  /** 总结邮件用的语言 */
  language: 'zh' | 'en'
  /** 写邮件默认的语气 */
  tone: string
}

export interface Settings {
  proxy: ProxySettings
  oauth: OAuthSettings
  general: GeneralSettings
  reading: ReadingSettings
  compose: ComposeSettings
  notify: NotifySettings
  translate: TranslateSettings
  ai: AiSettings
}

export interface Template {
  id: string
  name: string
  subject: string
  /** 纯文本正文 */
  body: string
}

export interface ScheduledMail {
  /** 因为网络问题没发出去时，下一次自动重试的时间 */
  retryAt?: number
  /** 已经自动重试了几次 */
  tries?: number
  /** 错过计划时间太久，没有自动发出，等用户决定 */
  held?: boolean
  id: string
  /** 计划发送时间（毫秒时间戳） */
  sendAt: number
  message: OutgoingMessage
  /** 上一次发送失败的原因 */
  error?: string
  /** 这是刚点了「发送」、还在可以撤销的那几秒里的邮件，不是用户安排的定时邮件 */
  undo?: boolean
  /** 这封信对应的本机草稿：发出去以后删掉；撤销或发送失败时从它恢复 */
  draftId?: string
}

/** 「撤销发送」的那封信有了结果 */
export interface SendDoneEvent {
  id: string
  ok: boolean
  error?: string
  draftId?: string
  /** 回复的是哪封邮件（发出后列表里给它加上「已回复」的标记） */
  replyTo?: { accountId: string; folder: string; uid: number }
}

/** 保存在本机的草稿（写信时自动保存） */
export interface LocalDraft {
  id: string
  savedAt: number
  mode: 'new' | 'reply' | 'replyAll' | 'forward'
  accountId: string
  to: string
  cc: string
  bcc: string
  subject: string
  /** 编辑器里的完整内容 */
  html: string
  attachments: ComposeAttachment[]
  inReplyTo?: string
  references?: string[]
  replyTo?: { accountId?: string; folder: string; uid: number }
}

export interface SnoozeInfo {
  /** 到这个时间重新出现在收件箱 */
  until: number
  subject: string
  from: string
  /** 和别的邮件一起作为一个会话推迟的、不是最新的那几封：到点时跟着回来，但不单独提醒、也不标成未读 */
  quiet?: boolean
}

/** 邮件规则：来信符合条件时自动处理。只对收件箱里新到的邮件生效，规则在本机执行 */
export type RuleField = 'from' | 'to' | 'subject'
export interface RuleCondition {
  field: RuleField
  /** 包含这段文字就算符合（不分大小写；发件人、收件人会同时比对名字和邮箱地址） */
  value: string
}
export type RuleActionType = 'markRead' | 'star' | 'move' | 'archive' | 'trash' | 'silent'
export interface RuleAction {
  type: RuleActionType
  /** move：移到哪个文件夹（路径） */
  target?: string
}
export interface MailRule {
  id: string
  name: string
  enabled: boolean
  /** 空字符串表示所有邮箱 */
  accountId: string
  /** all：全部条件都符合；any：符合其中一个就行 */
  match: 'all' | 'any'
  conditions: RuleCondition[]
  actions: RuleAction[]
}

/** 保存在本机的数据。邮件用「账号|文件夹|UID」作为键 */
export interface UserData {
  pinned: Record<string, number>
  snoozed: Record<string, SnoozeInfo>
  /** 重要发件人的邮箱地址（小写） */
  priority: string[]
  /** 屏蔽的发件人（小写） */
  blocked: string[]
  templates: Template[]
  quickReplies: string[]
  scheduled: ScheduledMail[]
  drafts: LocalDraft[]
  /** 已经点过「接受」的发件人（小写），不再提示 */
  accepted: string[]
  /** 邮件规则，从上到下依次执行 */
  rules: MailRule[]
}

/** 自动更新进行到哪一步了 */
export interface UpdateStatus {
  /**
   * unsupported：不是安装版，不参与更新；latest：已经是最新；
   * available：发现了新版本，等用户决定要不要下载；downloading：用户点了下载，正在下；ready：下载好了，等用户决定要不要马上重启安装
   */
  state: 'unsupported' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
  /** 新版本的版本号 */
  version?: string
  /** 下载进度，0 到 100 */
  percent?: number
  error?: string
  /** 上一次检查完的时间 */
  checkedAt?: number
}

export interface AppInfo {
  version: string
  dataDir: string
  packaged: boolean
}

export interface Preset {
  id: string
  label: string
  domains: string[]
  imap: ServerConfig
  smtp: ServerConfig
  /** 登录方式：授权码/密码，或 OAuth */
  auth: AuthType
  oauthProvider?: OAuthProvider
  /** 国外服务，默认走代理 */
  foreign: boolean
  appendSent: boolean
  /** 给用户看的提示，比如去哪里开 IMAP、拿授权码 */
  hint?: string
}

export interface DetectResult {
  preset?: Preset
  imap?: ServerConfig
  smtp?: ServerConfig
  /** 识别来源：内置预设 / MX 记录 / Thunderbird 数据库 / 猜测 */
  source: 'preset' | 'mx' | 'ispdb' | 'guess'
}

export interface NewAccountInput {
  email: string
  name: string
  provider: string
  imap: ServerConfig
  smtp: ServerConfig
  authType: AuthType
  oauthProvider?: OAuthProvider
  /** 用户名，留空则用邮箱地址 */
  user?: string
  password?: string
  useProxy: boolean
  appendSent: boolean
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'flagged'

export interface Folder {
  path: string
  name: string
  /** 带层级的显示名称，例如「其他文件夹/工作」 */
  displayName: string
  specialUse?: SpecialUse
  unseen: number
  total: number
  depth: number
  /** 服务器上分隔上下级文件夹的符号（一般是 / 或 .） */
  delimiter?: string
}

/** 附件预览的结果：图片、文字直接在界面里看；PDF 会另开一个窗口 */
export type AttachmentPreview =
  | { kind: 'image'; name: string; url: string }
  | { kind: 'text'; name: string; text: string; truncated: boolean }
  | { kind: 'window'; name: string }

export interface Address {
  name: string
  address: string
}

/** 智能收件箱的分类 */
export type MailCategory = 'personal' | 'notification' | 'newsletter'

export interface MessageSummary {
  category: MailCategory
  accountId: string
  folder: string
  uid: number
  seq: number
  subject: string
  from: Address[]
  to: Address[]
  date: string
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  size: number
  /** 这封邮件自己的 Message-ID（用来把来回的邮件串成一个会话） */
  messageId?: string
  /** 它回复、引用的那些邮件的 Message-ID */
  refs?: string[]
}

/** 自动补全用的联系人 */
export interface Contact {
  name: string
  address: string
}

export interface MessagePage {
  messages: MessageSummary[]
  /** 文件夹总数 */
  total: number
  /** 是否还有更早的邮件 */
  hasMore: boolean
}

export interface AttachmentInfo {
  index: number
  filename: string
  contentType: string
  size: number
}

export interface MessageDetail {
  uid: number
  accountId: string
  folder: string
  subject: string
  from: Address[]
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  date: string
  messageId?: string
  references: string[]
  /** 已处理好的 HTML（cid 图片已内联），没有 HTML 正文时为空 */
  html?: string
  text: string
  /** 正文里是否引用了远程图片 */
  hasRemoteImages: boolean
  attachments: AttachmentInfo[]
  flagged: boolean
  /** 订阅邮件自带的退订方式：oneclick 可以直接替你退订；mail 要发一封退订邮件；link 只能打开网页 */
  unsubscribe?: 'oneclick' | 'mail' | 'link'
  /** 这个发件人以前没怎么来过信（用来显示「接受 / 屏蔽」的提示） */
  newSender?: boolean
  /** 退订时会联系谁（邮箱地址或网站域名），只用来给用户看 */
  unsubscribeTarget?: string
  /** 邮件头里写的退订地址，只给主进程用 */
  unsubscribeInfo?: { url?: string; mailto?: string; oneClick: boolean }
  /** 缓存格式的版本：旧缓存里没有退订信息，读到旧版本就重新取一次 */
  v?: number
}

export interface ComposeAttachment {
  /** 本地文件路径 */
  path?: string
  filename: string
  size: number
  /** 转发时引用原邮件的附件 */
  fromMessage?: { accountId: string; folder: string; uid: number; index: number }
}

export interface OutgoingMessage {
  accountId: string
  to: string
  cc: string
  bcc: string
  subject: string
  html: string
  text: string
  attachments: ComposeAttachment[]
  inReplyTo?: string
  references?: string[]
  /** 回复成功后给原邮件打「已回复」标记 */
  replyTo?: { accountId?: string; folder: string; uid: number }
}

export interface NewMailEvent {
  accountId: string
  count: number
  /** 需要提醒用户的那部分（已经排除了屏蔽的发件人、免打扰时段等）；不需要提醒时没有这一项 */
  notify?: { count: number; uid: number; from: string; subject: string }
}

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}

/** 一份备份文件的基本情况（不用密码就能看到的部分） */
export interface BackupMeta {
  file: string
  savedAt: number
  /** 是哪台电脑写的 */
  device: string
  accounts: number
}

/** 自动找到的云盘位置，以及云盘里已有的备份 */
export interface BackupDetect {
  /** path 是建议存放备份的文件夹（云盘里的 Bluebird 子文件夹） */
  drives: { name: string; path: string }[]
  found: (BackupMeta & { drive: string })[]
}

export interface BackupInfo {
  enabled: boolean
  folder: string
  hasPassword: boolean
  /** 备份文件夹里现有的那一份 */
  last: BackupMeta | null
  thisDevice: string
  /** 最近一次自动备份失败的原因，没失败是空字符串 */
  error: string
}
