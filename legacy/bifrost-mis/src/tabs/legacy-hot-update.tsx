import EditablePropertyList from '../components/EditablePropertyList'
import type { TabProperties } from './types'

// 旧热更配置：基于 globalSetting.summary_tpl 的「每模块 多版本表」机制。
// 管理员填联邦 name，拼成各模块的版本化 entry；handleChange 据当前 host 版本区间铺满 summary_tpl。
// 新机制（独立接口 /api/v3/version/hot-module）见「热更配置」tab。
function makeTemplateSerde(subject: string) {
  return {
    ser: (v: any) => v?.name,
    de: (name: string) => ({
      entry: `https://img.kookapp.cn/${subject}/${name}/remoteEntry.js`,
      name,
    }),
  }
}

const tabItems = [
  {
    title: '/api/v3/user/settings · summary_tpl（旧热更）',
    properties: [
      {
        field: 'discover_tpl',
        name: '发现页热更版本',
        description: '示例：discover_v50，留空代表与官网版本同步',
        ...makeTemplateSerde('discover'),
      },
      {
        field: 'base_tpl',
        name: '基础页热更版本（消息中心、礼物、语音房等）',
        description: '示例：base_v50，留空代表与官网版本同步',
        ...makeTemplateSerde('base'),
      },
      {
        field: 'mall_tpl',
        name: '商城热更版本',
        description: '示例：mall_v50，留空代表与官网版本同步',
        ...makeTemplateSerde('mall'),
      },
      {
        field: 'settings_tpl',
        name: '设置页热更版本',
        description: '示例：settings_v50，留空代表与官网版本同步',
        ...makeTemplateSerde('settings'),
      },
      {
        field: 'thread_tpl',
        name: '帖子热更版本',
        description: '示例：thread_v50，留空代表与官网版本同步',
        ...makeTemplateSerde('thread'),
      },
    ],
  },
]

function makeKeys(start: number, end: number) {
  const subVersions = 5
  const ret: string[] = []
  for (let i = start; i <= end; ++i) {
    const base = `0.${i}`
    for (let j = 0; j < subVersions; ++j) {
      if (j === 0) {
        ret.push(base)
      }
      ret.push(`${base}.${j}`)
    }
  }
  return ret
}

export default function LegacyHotUpdateTabContent({ tabKey, tabKeyToValues, onChange, onSave }: TabProperties) {
  function handleChange(values: Record<string, any>) {
    values['summary_tpl'] = tabItems[0].properties
      .filter((p) => p.field.endsWith('_tpl'))
      .reduce<Record<string, any>>((acc, p) => {
        if (values[p.field]) {
          const pValue = values[p.field].name
          const keys = makeKeys(105, 110)
          keys.forEach((key) => {
            acc[p.field] = {
              ...acc[p.field],
              [key]: p.de(pValue),
            }
          })
        }
        return acc
      }, {})
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
