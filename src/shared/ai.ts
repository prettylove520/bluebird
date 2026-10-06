// AI 服务商预设：界面和主进程共用。密钥不在这里，单独加密保存在本机。

/** anthropic：Claude 官方接口；openai：OpenAI 以及绝大多数「兼容 OpenAI」的服务（国内的基本都是这种） */
export type AiStyle = 'anthropic' | 'openai'

export interface AiPreset {
  id: string
  label: string
  style: AiStyle
  baseUrl: string
  model: string
  /** 联网获取不到模型列表时给的参考（会过时，以服务商返回的列表为准） */
  models: string[]
  /** 到哪里申请密钥 */
  keyUrl: string
  /** 国内能不能直接连上 */
  direct: boolean
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    style: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    direct: true
  },
  {
    id: 'qwen',
    label: '通义千问（阿里云百炼）',
    style: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-plus',
    models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3.7-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    direct: true
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    style: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.6'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    direct: true
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    style: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-Flash',
    models: ['glm-5.3-Flash', 'glm-5.3', 'glm-4.7-flash'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    direct: true
  },
  {
    id: 'claude',
    label: 'Claude（Anthropic）',
    style: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5-5',
    models: ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-fable-5-1'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    direct: false
  },
  {
    id: 'openai',
    label: 'OpenAI',
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-6-astra'],
    keyUrl: 'https://platform.openai.com/api-keys',
    direct: false
  },
  {
    id: 'custom',
    label: '其他（自己填地址）',
    style: 'openai',
    baseUrl: '',
    model: '',
    models: [],
    keyUrl: '',
    direct: true
  }
]

/** 以前版本预设里的模型名。其中不少服务商已经下线，设置里遇到它们会自动换成服务商现有的模型 */
export const LEGACY_MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-plus',
  'qwen-turbo',
  'qwen-max',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
  'glm-4-flash',
  'glm-4-plus',
  'glm-4-air',
  'gpt-4o-mini',
  'gpt-4o'
]

/** 模型名是不是「预设自带的」（不是用户自己特意选的）：这样的名字在服务商没有时可以放心自动换掉 */
export const isPresetModel = (name: string): boolean => !name || LEGACY_MODELS.includes(name) || AI_PRESETS.some((p) => p.models.includes(name))

/** 接口地址里的主机名（带端口）：密钥按它分开保存，填给 A 服务商的密钥不会被发到 B */
export function aiHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return ''
  }
}

export const presetOf = (id: string): AiPreset => AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[AI_PRESETS.length - 1]

/** AI 能帮忙做的事 */
export type AiTask = 'summarize' | 'compose' | 'reply' | 'polish'

/** 写作的语气 */
export const AI_TONES: { id: string; label: string; hint: string }[] = [
  { id: 'friendly', label: '友好自然', hint: '像平时和同事、客户说话那样，礼貌但不生硬' },
  { id: 'warm', label: '热情亲切', hint: '温暖、积极，表达关心和善意，适合熟悉的人和老客户，可以带一点点口语' },
  { id: 'formal', label: '正式', hint: '商务场合的正式措辞，用语严谨，结构清楚' },
  { id: 'professional', label: '专业干练', hint: '直接切入重点，条理清楚，不绕弯子，也不过分客套' },
  { id: 'respectful', label: '恭敬谦逊', hint: '写给上级、长辈或重要客户：措辞谦虚恭敬，多用「您」，态度诚恳' },
  { id: 'concise', label: '简短', hint: '尽量短，几句话说清楚' },
  { id: 'grateful', label: '感谢', hint: '真诚地表达感谢，具体说出感谢的是什么，不空泛' },
  { id: 'apology', label: '诚恳致歉', hint: '坦率承认问题，真诚道歉，说明会怎么补救，不找借口，也不过度卑微' },
  { id: 'request', label: '委婉请求', hint: '礼貌地请对方帮忙或配合，说明原因和时间，给对方留有余地' },
  { id: 'urgent', label: '催办跟进', hint: '礼貌但明确地提醒对方，说清楚事项和期限，不带责备，也不含糊' },
  { id: 'firm', label: '坚定明确', hint: '立场清楚、语气平稳地说明（比如拒绝、不同意、坚持条件），不失礼貌，不留模糊空间' },
  { id: 'empathy', label: '体谅安慰', hint: '先理解对方的处境和心情，再说事情；语气温和，不说教' },
  { id: 'humor', label: '轻松幽默', hint: '轻松活泼，可以有一点点幽默，但不轻浮，不影响事情本身说清楚' }
]

export interface AiMail {
  from?: string
  to?: string
  subject?: string
  date?: string
  text?: string
}

/** 界面交给主进程的请求 */
export interface AiRequest {
  task: AiTask
  /** 正在看的、或者要回复的那封邮件 */
  mail?: AiMail
  /** 会话里更早的几封（总结整个会话时用） */
  earlier?: AiMail[]
  /** 你想写什么：「礼貌地拒绝，说预算有限」 */
  instruction?: string
  /** 已经写了一部分的正文（润色用） */
  draft?: string
  tone?: string
  /** 新邮件还没有主题时，让 AI 顺便拟一个 */
  wantSubject?: boolean
  /** 你的名字，写信时用 */
  me?: string
}

