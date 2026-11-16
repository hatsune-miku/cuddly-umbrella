import fs from 'fs'

import { config } from '../config'

// 管理端配置的唯一存放处：进程内一份对象 + 落盘一个 JSON 文件。
//
// 目前是全局单份配置，所有访问者共享。将来要做「一个需求一个环境」时，
// 替换点就在这里：把 getMisData() 改成按环境 ID 取，调用方无需变动。

let misData: Record<string, any> = loadFromFile()

function loadFromFile(): Record<string, any> {
  try {
    if (fs.existsSync(config.misDataFile)) {
      console.log('xx', 'loaded mis data from', config.misDataFile)
      return JSON.parse(fs.readFileSync(config.misDataFile, 'utf-8'))
    }
  } catch (e) {
    console.error('xx', 'failed to load mis data from file', e)
  }
  return {}
}

function saveToFile() {
  try {
    fs.writeFileSync(config.misDataFile, JSON.stringify(misData, null, 2), 'utf-8')
  } catch (e) {
    console.error('xx', 'failed to save mis data to file', e)
  }
}

/** 按 slice 合并写入。传入的 falsy 值表示「清空该 slice」，不写进存量数据 */
export function setMisData(data: Record<string, any>) {
  // 传进来的是请求体解析出的纯数据，structuredClone 足够，不需要 lodash
  const state = structuredClone(data)
  for (const key of Object.keys(state)) {
    if (!state[key]) {
      delete state[key]
    }
  }

  console.log('xx', 'writing mis data', state)
  Object.assign(misData, state)
  saveToFile()
}

export function getMisData(): Record<string, any> {
  return misData
}
