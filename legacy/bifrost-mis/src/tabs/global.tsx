import EditablePropertyList from '../components/EditablePropertyList'
import type { TabProperties } from './types'

// 全局设置：仅保留与热更无关的常规覆盖项（语音房公告等）。
// 旧热更（summary_tpl）已拆到「旧热更配置」tab，但二者同属 /api/v3/user/settings 覆盖，
// 共用 tabKey="settingsOverlay"，互不覆盖对方字段（EditablePropertyList 改单字段时整体透传）。
const tabItems = [
  {
    title: '/api/v3/user/settings',
    properties: [
      {
        field: 'radio_official_topic',
        name: '语音房公告',
        description: '语音房公告文案',
        ser: (v: any) => v,
        de: (v: string) => v,
      },
    ],
  },
]

export default function GlobalTabContent({ tabKey, tabKeyToValues, onChange, onSave }: TabProperties) {
  function handleChange(values: Record<string, any>) {
    onChange?.(tabKey, values)
  }

  return tabItems.map((tabItem, i) => (
    <EditablePropertyList
      key={i}
      title={tabItem.title}
      properties={tabItem.properties}
      values={tabKeyToValues[tabKey]}
      onChange={handleChange}
      onSave={() => onSave?.(tabKey)}
    />
  ))
}
