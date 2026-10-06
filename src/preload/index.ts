// 预加载脚本：把有限的几个接口暴露给界面，界面本身拿不到 Node.js 能力

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function on(channel: string) {
  return (cb: (payload: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

const api = {
  state: invoke('app:state'),
  saveSettings: invoke('settings:save'),
  settingsDefaults: invoke('settings:defaults'),
  detect: invoke('accounts:detect'),
  addPasswordAccount: invoke('accounts:addPassword'),
  addOAuthAccount: invoke('accounts:addOAuth'),
  cancelOAuth: invoke('accounts:cancelOAuth'),
  reauthAccount: invoke('accounts:reauth'),
  updateAccount: invoke('accounts:update'),
  removeAccount: invoke('accounts:remove'),
  folders: invoke('mail:folders'),
  list: invoke('mail:list'),
  search: invoke('mail:search'),
  get: invoke('mail:get'),
  previews: invoke('mail:previews'),
  listByUids: invoke('mail:listByUids'),
  cachedList: invoke('cache:list'),
  cacheInfo: invoke('cache:info'),
  cacheClear: invoke('cache:clear'),
  updateData: invoke('data:update'),
  scheduleAdd: invoke('schedule:add'),
  scheduleCancel: invoke('schedule:cancel'),
  scheduleSendNow: invoke('schedule:sendNow'),
  flag: invoke('mail:flag'),
  markAll: invoke('mail:markAll'),
  emptyFolder: invoke('mail:empty'),
  remove: invoke('mail:delete'),
  archive: invoke('mail:archive'),
  move: invoke('mail:move'),
  send: invoke('mail:send'),
  saveAttachment: invoke('attachment:save'),
  exportMail: invoke('mail:export'),
  printMail: invoke('mail:print'),
  copyText: invoke('clipboard:write'),
  searchAll: invoke('mail:searchAll'),
  contacts: invoke('contacts:search'),
  unsubscribe: invoke('mail:unsubscribe'),
  sendLater: invoke('send:later'),
  sendUndo: invoke('send:undo'),
  testNotify: invoke('notify:test'),
  updateStatus: invoke('update:status'),
  updateCheck: invoke('update:check'),
  updateInstall: invoke('update:install'),
  backupInfo: invoke('backup:info'),
  backupDetect: invoke('backup:detect'),
  backupPickFolder: invoke('backup:pickFolder'),
  backupEnable: invoke('backup:enable'),
  backupDisable: invoke('backup:disable'),
  backupNow: invoke('backup:now'),
  backupPickFile: invoke('backup:pickFile'),
  backupRestore: invoke('backup:restore'),
  openAttachment: invoke('attachment:open'),
  previewAttachment: invoke('attachment:preview'),
  threadSent: invoke('mail:threadSent'),
  createFolder: invoke('folders:create'),
  renameFolder: invoke('folders:rename'),
  deleteFolder: invoke('folders:delete'),
  previewTheme: invoke('theme:preview'),
  pickFiles: invoke('dialog:pickFiles'),
  openExternal: invoke('shell:open'),
  testProxy: invoke('proxy:test'),
  setControls: invoke('window:controls'),
  homeImage: invoke('home:image'),
  pickHomeImage: invoke('home:pick'),
  clearHomeImage: invoke('home:clear'),
  openDataDir: invoke('app:openDataDir'),
  onNewMail: on('mail:new'),
  onChanged: on('mail:changed'),
  onOpenMail: on('mail:open'),
  onMailto: on('compose:mailto'),
  onComposeNew: on('compose:new'),
  onDataChanged: on('data:changed'),
  onSendDone: on('send:done'),
  onUpdateStatus: on('update:status')
}

contextBridge.exposeInMainWorld('bluebird', api)

// 拖拽附件时取得文件在电脑上的路径
contextBridge.exposeInMainWorld('bluebirdFiles', {
  pathFor: (file: File): string => webUtils.getPathForFile(file)
})

export type RawApi = typeof api
