// 界面调用主进程的接口（类型化封装，出错时抛出带中文说明的异常）

import type {
  Account,
  AppInfo,
  AttachmentPreview,
  BackupDetect,
  BackupInfo,
  BackupMeta,
  ComposeAttachment,
  Contact,
  DetectResult,
  Folder,
  MessageDetail,
  MessagePage,
  MessageSummary,
  NewAccountInput,
  NewMailEvent,
  OAuthProvider,
  OutgoingMessage,
  Preset,
  ProxySettings,
  Result,
  SendDoneEvent,
  ServerConfig,
  Settings,
  UpdateStatus,
  UserData,
  InviteAnswer
} from '../../shared/types'
import type { AiRequest } from '../../shared/ai'

type Fn = (...args: unknown[]) => Promise<unknown>
type Listen = (cb: (payload: unknown) => void) => () => void

declare global {
  interface Window {
    bluebird: Record<string, Fn | Listen>
    bluebirdFiles?: { pathFor: (file: File) => string }
  }
}

async function call<T>(name: string, ...args: unknown[]): Promise<T> {
  const r = (await (window.bluebird[name] as Fn)(...args)) as Result<T>
  if (!r.ok) throw new Error(r.error || '操作失败')
  return r.data as T
}

function listen<T>(name: string, cb: (payload: T) => void): () => void {
  return (window.bluebird[name] as Listen)((p) => cb(p as T))
}

export interface AppState {
  accounts: Account[]
  settings: Settings
  presets: Preset[]
  info: AppInfo
  data: UserData
  /** 上次缓存的文件夹列表 */
  folders: Record<string, Folder[] | null>
}

export interface AccountPatch {
  name?: string
  useProxy?: boolean
  appendSent?: boolean
  password?: string
  signature?: string
  tag?: string
  color?: string
  imap?: ServerConfig
  smtp?: ServerConfig
}

export const api = {
  state: () => call<AppState>('state'),
  saveSettings: (s: Settings) => call<Settings>('saveSettings', s),
  settingsDefaults: () => call<Settings>('settingsDefaults'),
  detect: (email: string) => call<DetectResult>('detect', email),
  addPasswordAccount: (input: NewAccountInput) => call<Account>('addPasswordAccount', input),
  addOAuthAccount: (provider: OAuthProvider, name?: string) => call<Account>('addOAuthAccount', provider, name),
  cancelOAuth: () => call<void>('cancelOAuth'),
  reauthAccount: (id: string) => call<Account>('reauthAccount', id),
  updateAccount: (id: string, patch: AccountPatch) => call<Account>('updateAccount', id, patch),
  removeAccount: (id: string) => call<boolean>('removeAccount', id),
  folders: (accountId: string) => call<Folder[]>('folders', accountId),
  list: (accountId: string, folder: string, before?: number) => call<MessagePage>('list', accountId, folder, before),
  search: (accountId: string, folder: string, q: string) => call<MessagePage>('search', accountId, folder, q),
  get: (accountId: string, folder: string, uid: number, markSeen = true) =>
    call<MessageDetail>('get', accountId, folder, uid, markSeen),
  cachedList: (accountId: string, folder: string) => call<MessagePage | null>('cachedList', accountId, folder),
  cacheInfo: () => call<number>('cacheInfo'),
  cacheClear: () => call<number>('cacheClear'),
  reconnect: (ids: string[]) => call<void>('reconnect', ids),
  listByUids: (accountId: string, folder: string, uids: number[]) =>
    call<MessageSummary[]>('listByUids', accountId, folder, uids),
  updateData: (patch: Partial<UserData>) => call<UserData>('updateData', patch),
  runRules: () => call<number>('runRules'),
  inviteRespond: (accountId: string, folder: string, uid: number, answer: InviteAnswer) => call<UserData>('inviteRespond', accountId, folder, uid, answer),
  inviteOpen: (accountId: string, folder: string, uid: number) => call<boolean>('inviteOpen', accountId, folder, uid),
  scheduleAdd: (msg: OutgoingMessage, sendAt: number) => call<UserData>('scheduleAdd', msg, sendAt),
  scheduleCancel: (id: string) => call<UserData>('scheduleCancel', id),
  scheduleSendNow: (id: string) => call<UserData>('scheduleSendNow', id),
  prefetch: (accountId: string, folder: string, uids: number[]) => call<boolean>('prefetch', accountId, folder, uids),
  previews: (accountId: string, folder: string, uids: number[]) =>
    call<Record<number, string>>('previews', accountId, folder, uids),
  flag: (accountId: string, folder: string, uids: number | number[], flag: 'seen' | 'flagged', value: boolean) =>
    call<void>('flag', accountId, folder, uids, flag, value),
  markAll: (accountId: string, folder: string, seen: boolean) => call<number>('markAll', accountId, folder, seen),
  emptyFolder: (accountId: string, folder: string) => call<number>('emptyFolder', accountId, folder),
  remove: (accountId: string, folder: string, uids: number | number[]) => call<void>('remove', accountId, folder, uids),
  archive: (accountId: string, folder: string, uids: number | number[]) => call<boolean>('archive', accountId, folder, uids),
  move: (accountId: string, folder: string, uids: number | number[], target: string) =>
    call<void>('move', accountId, folder, uids, target),
  send: (msg: OutgoingMessage) => call<{ savedToSent: boolean }>('send', msg),
  saveAttachment: (accountId: string, folder: string, uid: number, index: number) =>
    call<boolean>('saveAttachment', accountId, folder, uid, index),
  openAttachment: (accountId: string, folder: string, uid: number, index: number) =>
    call<boolean>('openAttachment', accountId, folder, uid, index),
  previewAttachment: (accountId: string, folder: string, uid: number, index: number) =>
    call<AttachmentPreview>('previewAttachment', accountId, folder, uid, index),
  threadSent: (accountId: string, ids: string[]) => call<MessageSummary[] | null>('threadSent', accountId, ids),
  createFolder: (accountId: string, name: string, parent?: string) => call<Folder[]>('createFolder', accountId, name, parent),
  renameFolder: (accountId: string, path: string, name: string) => call<Folder[]>('renameFolder', accountId, path, name),
  deleteFolder: (accountId: string, path: string, expectedTotal: number) => call<Folder[]>('deleteFolder', accountId, path, expectedTotal),
  previewTheme: (theme: string | null) => call<boolean>('previewTheme', theme),
  exportMail: (accountId: string, folder: string, uid: number, name: string) => call<boolean>('exportMail', accountId, folder, uid, name),
  printMail: (html: string, pdf: boolean, name: string) => call<boolean>('printMail', html, pdf, name),
  copyText: (text: string) => call<boolean>('copyText', text),
  searchAll: (accountId: string, q: string) => call<MessagePage>('searchAll', accountId, q),
  contacts: (q: string) => call<Contact[]>('contacts', q),
  contactList: () => call<(Contact & { sent: boolean; last: number })[]>('contactList'),
  contactRemove: (address: string) => call<void>('contactRemove', address),
  contactScan: () => call<{ scanned: number; total: number }>('contactScan'),
  unsubscribe: (accountId: string, folder: string, uid: number) => call<'done' | 'mailed' | 'opened'>('unsubscribe', accountId, folder, uid),
  sendLater: (msg: OutgoingMessage, seconds: number, draftId?: string) => call<{ id: string; data: UserData }>('sendLater', msg, seconds, draftId),
  sendUndo: (id: string) => call<UserData>('sendUndo', id),
  translateInfo: () => call<{ hasKey: boolean; tail: string }>('translateInfo'),
  translateSetKey: (key: string) => call<{ hasKey: boolean; tail: string }>('translateSetKey', key),
  translateUsage: () => call<{ used: number; limit: number }>('translateUsage'),
  translateTexts: (texts: string[], xml: boolean) => call<{ texts: string[]; from: string }>('translateTexts', texts, xml),
  updateStatus: () => call<UpdateStatus>('updateStatus'),
  updateCheck: () => call<UpdateStatus>('updateCheck'),
  aiInfo: (ai: Settings['ai']) => call<{ hasKey: boolean; tail: string }>('aiInfo', ai),
  aiSetKey: (key: string, ai: Settings['ai']) => call<{ hasKey: boolean; tail: string; note?: string }>('aiSetKey', key, ai),
  aiModels: (ai: Settings['ai']) => call<{ models: string[]; suggested: string }>('aiModels', ai),
  aiTest: (ai: Settings['ai']) => call<{ ms: number }>('aiTest', ai),
  aiRun: (req: AiRequest) => call<string>('aiRun', req),
  updateDownload: () => call<UpdateStatus>('updateDownload'),
  updateInstall: () => call<boolean>('updateInstall'),
  testNotify: () => call<{ supported: boolean }>('testNotify'),
  backupInfo: () => call<BackupInfo>('backupInfo'),
  backupDetect: () => call<BackupDetect>('backupDetect'),
  backupPickFolder: () => call<string | null>('backupPickFolder'),
  backupEnable: (folder: string, password?: string) => call<BackupInfo>('backupEnable', folder, password),
  backupDisable: () => call<BackupInfo>('backupDisable'),
  backupNow: () => call<BackupInfo>('backupNow'),
  backupPickFile: () => call<BackupMeta | null>('backupPickFile'),
  backupRestore: (file: string, password: string) => call<{ accounts: number }>('backupRestore', file, password),
  pickFiles: () => call<ComposeAttachment[]>('pickFiles'),
  openExternal: (url: string) => call<void>('openExternal', url),
  homeImage: () => call<string | null>('homeImage'),
  pickHomeImage: () => call<string | null>('pickHomeImage'),
  clearHomeImage: () => call<boolean>('clearHomeImage'),
  setControls: (light: boolean) => call<boolean>('setControls', light),
  testProxy: (p: ProxySettings) => call<{ ms: number; kind: 'socks5' | 'http' }>('testProxy', p),
  detectProxy: () => call<{ host: string; port: number; kind: 'socks5' | 'http'; source: 'system' | 'scan' } | null>('detectProxy'),
  openDataDir: () => call<boolean>('openDataDir'),

  onNewMail: (cb: (e: NewMailEvent) => void) => listen<NewMailEvent>('onNewMail', cb),
  onChanged: (cb: (e: { accountId: string }) => void) => listen<{ accountId: string }>('onChanged', cb),
  onOpenMail: (cb: (e: { accountId: string; folder: string; uid?: number }) => void) =>
    listen<{ accountId: string; folder: string; uid?: number }>('onOpenMail', cb),
  onMailto: (cb: (url: string) => void) => listen<string>('onMailto', cb),
  onComposeNew: (cb: () => void) => listen<null>('onComposeNew', () => cb()),
  onDataChanged: (cb: (d: UserData) => void) => listen<UserData>('onDataChanged', cb),
  onSendDone: (cb: (e: SendDoneEvent) => void) => listen<SendDoneEvent>('onSendDone', cb),
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => listen<UpdateStatus>('onUpdateStatus', cb)
}
