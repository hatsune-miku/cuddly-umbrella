import { Button, Input, Switch } from '@heroui/react'

import type { TabProperties } from './types'

// 新版热更配置：对应后端独立接口 GET /api/v3/version/hot-module。
// 契约对照 kook host（只读参考）：apps/webapp/src/_core/hot-update-service/index.ts parseHotModuleResponse
//   下发形态 { version, modules: { '<key>': { name, entry, version, restartRequired } } }
// 后端在 bifrost-kookapp/src/hot-module.ts 据 misData.hotModuleConfig 组装下发。

interface HotModuleItem {
  name?: string
  entry?: string
  version?: string
  restartRequired?: boolean
}

interface HotModuleConfig {
  modules?: Record<string, HotModuleItem>
}

// host 已知 remote key（与后端 KNOWN_REMOTE_KEYS / kook prodRemoteEntryMock 对齐）。
const REMOTE_MODULES: { key: string; label: string }[] = [
  { key: 'base', label: 'base（消息中心 / 礼物挂载 / 进程检测等）' },
  { key: 'discover', label: '发现页 discover' },
  { key: 'gift', label: '礼物系统 gift' },
  { key: 'guild', label: '服务器相关 guild' },
  { key: 'help_center', label: '帮助中心 help_center' },
  { key: 'mall', label: '商城 mall' },
  { key: 'order_tracker', label: '工会成员听单器 order_tracker' },
  { key: 'profile', label: '个人卡片 profile' },
  { key: 'settings', label: '设置 settings' },
  { key: 'thread', label: '帖子 thread' },
  { key: 'tutorial', label: '新手引导 tutorial' },
  { key: 'voice_runtime', label: '语音运行时 voice_runtime' },
  { key: 'voice_panel', label: '语音面板 voice_panel' },
]

// 联邦 name → remoteEntry.js 入口 URL（走 bifrost OSS 域，路径 {key}/{name}）。
function buildEntry(key: string, name: string) {
  return `https://bifrost-oss.vanillacake.cn/${key}/${name}/remoteEntry.js`
}

export default function HotModuleTabContent({ tabKey, tabKeyToValues, onChange, onSave }: TabProperties) {
  const config: HotModuleConfig = (tabKeyToValues[tabKey] as HotModuleConfig) || {}
  const modules = config.modules || {}

  function emit(next: HotModuleConfig) {
    onChange?.(tabKey, next as Record<string, any>)
  }

  // 填 name 自动拼 entry（version 取 name，与 host 从 entry 路径段推导的结果一致）；清空则不覆盖该模块。
  function setName(key: string, rawName: string) {
    const name = rawName.trim()
    const nextModules = { ...modules }
    if (!name) {
      delete nextModules[key]
    } else {
      nextModules[key] = {
        ...nextModules[key],
        name,
        version: name,
        entry: buildEntry(key, name),
      }
    }
    emit({ ...config, modules: nextModules })
  }

  function setRestart(key: string, restartRequired: boolean) {
    const current = modules[key]
    if (!current) {
      return
    }
    emit({ ...config, modules: { ...modules, [key]: { ...current, restartRequired } } })
  }

  return (
    <div className="editable-property-list-wrapper">
      <h2>/api/v3/version/hot-module</h2>
      <div className="editable-property-list">
        {REMOTE_MODULES.map(({ key, label }) => {
          const item = modules[key] || {}
          return (
            <div key={key} className={`property-item${item.name ? ' filled' : ''}`}>
              <label>{label}</label>
              <p>{item.entry || `例如 ${key}_v1_prod_06221540_bf5f5；留空代表使用官方版本`}</p>
              <Input
                type="text"
                value={item.name || ''}
                onValueChange={(v) => setName(key, v)}
                variant="bordered"
                size="sm"
                placeholder={`${key}_v1_prod_...`}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <Switch
                  isSelected={!!item.restartRequired}
                  isDisabled={!item.name}
                  onValueChange={(v) => setRestart(key, v)}
                  size="sm"
                >
                  需重启 restartRequired
                </Switch>
              </div>
            </div>
          )
        })}
      </div>
      <Button onPress={() => onSave?.(tabKey)} color="primary" size="md" className="save-button">
        保存
      </Button>
    </div>
  )
}
