// 配置、密钥、用户数据这几个 JSON 文件的读写。
// 这些文件丢了就等于所有账号都要重新添加，所以多做两层保护：
// 1. 写入：先写临时文件并确认落盘，再替换正式文件，替换前把上一份留作 .bak
// 2. 读取：正式文件坏了（断电、蓝屏后可能变成空文件）就用 .bak；坏文件改名留底，不会被悄悄覆盖

import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'fs'

function parseText<T>(text: string): T {
  const value = JSON.parse(text) as T
  if (value === null || typeof value !== 'object') throw new Error('内容不是有效的数据')
  return value
}

/** 读文件内容。文件被杀毒软件之类短暂占用时等一下再试，实在读不到返回 undefined */
function readText(path: string): string | undefined {
  for (let i = 0; i < 4; i++) {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      if (i === 3) {
        console.error(`读不到 ${path}`, err)
        return undefined
      }
      // 同步等 150 毫秒
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
    }
  }
  return undefined
}

export function readJsonSafe<T>(path: string, fallback: T): T {
  const bak = path + '.bak'
  if (existsSync(path)) {
    const text = readText(path)
    if (text !== undefined) {
      try {
        return parseText<T>(text)
      } catch (err) {
        console.error(`${path} 的内容已损坏，尝试用备份恢复`, err)
        // 把坏文件挪开留底：既方便排查，也避免下次保存时把它当成「上一份」盖掉好的备份。
        // 只有内容确实坏了才挪；只是暂时读不到的话原文件不动
        try {
          renameSync(path, `${path}.corrupt-${Date.now()}`)
        } catch {
          // 挪不动就算了
        }
      }
    }
  }
  if (existsSync(bak)) {
    const text = readText(bak)
    if (text !== undefined) {
      try {
        const value = parseText<T>(text)
        console.warn(`已从备份恢复 ${path}`)
        return value
      } catch (err) {
        console.error(`备份 ${bak} 也读不出来`, err)
      }
    }
  }
  return fallback
}

export function writeJsonSafe(path: string, data: unknown): void {
  const tmp = path + '.tmp'
  const text = JSON.stringify(data, null, 2)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text, 0, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    // 只有确认现在这份是好的，才拿它去覆盖备份
    if (existsSync(path)) {
      parseText(readFileSync(path, 'utf8'))
      copyFileSync(path, path + '.bak')
    }
  } catch {
    // 现有文件读不了或已损坏：保留原来的备份不动
  }
  try {
    renameSync(tmp, path)
  } catch {
    // 正式文件被杀毒软件之类短暂占用时改名会失败，退一步直接写
    writeFileSync(path, text, 'utf8')
  }
  for (const fn of listeners) {
    try {
      fn(path)
    } catch {
      // 监听的一方出错不影响保存
    }
  }
}

const listeners: ((path: string) => void)[] = []
/** 每次保存成功后通知一声（自动备份用） */
export function onJsonWritten(fn: (path: string) => void): void {
  listeners.push(fn)
}
