// AI 服务商预设：界面和主进程共用。密钥不在这里，单独加密保存在本机。

/** anthropic：Claude 官方接口；openai：OpenAI 以及绝大多数「兼容 OpenAI」的服务（国内的基本都是这种） */
export type AiStyle = 'anthropic' | 'openai'

export interface AiPreset {
  id: string
  label: string
  style: AiStyle
  baseUrl: string
  model: string
  /** 常用的模型名，填模型时给个参考（不限于这些，服务商出了新模型可以直接填） */
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
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    direct: true
  },
  {
    id: 'qwen',
    label: '通义千问（阿里云百炼）',
    style: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    direct: true
  },
  {
    id: 'kimi',
    label: 'Kimi（月之暗面）',
    style: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-32k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    direct: true
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    style: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    direct: true
  },
  {
    id: 'claude',
    label: 'Claude（Anthropic）',
    style: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5-5',
    models: ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    direct: false
  },
  {
    id: 'openai',
    label: 'OpenAI',
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
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

export const presetOf = (id: string): AiPreset => AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[AI_PRESETS.length - 1]

/** AI 能帮忙做的事 */
export type AiTask = 'summarize' | 'compose' | 'reply' | 'polish'

/** 写作的语气 */
export const AI_TONES: { id: string; label: string; hint: string }[] = [
  { id: 'friendly', label: '友好自然', hint: '像平时和同事、客户说话那样，礼貌但不生硬' },
  { id: 'formal', label: '正式', hint: '商务场合的正式措辞' },
  { id: 'concise', label: '简短', hint: '尽量短，几句话说清楚' }
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

