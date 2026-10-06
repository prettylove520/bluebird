// imapflow 的精简类型声明（只覆盖本项目用到的部分）。
// 不同版本的 imapflow 自带类型不完全一致，这里固定一份，保证 npm run typecheck 稳定。

declare module 'imapflow' {
  export interface ImapFlowOptions {
    host: string
    port: number
    secure?: boolean
    auth: { user: string; pass?: string; accessToken?: string }
    logger?: false | object
    clientInfo?: Record<string, string>
    connectionTimeout?: number
    greetingTimeout?: number
    socketTimeout?: number
    maxIdleTime?: number
    tls?: object
    /** true：必须升级到加密连接，服务器不支持就直接失败，不会用明文发密码 */
    doSTARTTLS?: boolean
    /** 例如 socks5://127.0.0.1:7890 或 http://127.0.0.1:7890 */
    proxy?: string
  }

  export interface ListResponse {
    path: string
    name: string
    delimiter: string
    flags: Set<string>
    specialUse?: string
    status?: { messages?: number; unseen?: number }
  }

  export interface FetchMessageObject {
    seq: number
    uid: number
    flags?: Set<string>
    size?: number
    internalDate?: Date | string
    source?: Buffer
    headers?: Buffer
    bodyStructure?: unknown
    envelope?: {
      date?: Date | string
      subject?: string
      messageId?: string
      from?: { name?: string; address?: string }[]
      to?: { name?: string; address?: string }[]
      cc?: { name?: string; address?: string }[]
    }
  }

  export class ImapFlow {
    constructor(options: ImapFlowOptions)
    usable: boolean
    capabilities: Map<string, unknown>
    mailbox: false | { path: string; exists: number; uidNext?: number }
    connect(): Promise<void>
    logout(): Promise<void>
    noop(): Promise<void>
    close(): void
    on(event: string, listener: (...args: any[]) => void): this
    list(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<ListResponse[]>
    getMailboxLock(path: string): Promise<{ release(): void }>
    mailboxOpen(path: string): Promise<unknown>
    fetch(range: string | number[], query: object, options?: { uid?: boolean }): AsyncIterableIterator<FetchMessageObject>
    fetchOne(range: string, query: object, options?: { uid?: boolean }): Promise<FetchMessageObject | false>
    search(query: object, options?: { uid?: boolean }): Promise<number[] | false>
    messageFlagsAdd(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean>
    messageFlagsRemove(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean>
    messageMove(range: string, destination: string, options?: { uid?: boolean }): Promise<unknown>
    /** 路径可以是数组，会自动用服务器的分隔符拼起来 */
    mailboxCreate(path: string | string[]): Promise<unknown>
    mailboxRename(path: string, newPath: string | string[]): Promise<unknown>
    mailboxDelete(path: string): Promise<unknown>
    status(path: string, query: { messages?: boolean; unseen?: boolean }): Promise<{ messages?: number; unseen?: number }>
    messageCopy(range: string, destination: string, options?: { uid?: boolean }): Promise<unknown>
    messageDelete(range: string, options?: { uid?: boolean }): Promise<boolean>
    append(path: string, content: Buffer | string, flags?: string[], idate?: Date): Promise<unknown>
  }
}
