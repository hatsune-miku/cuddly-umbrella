import EditablePropertyList from '../components/EditablePropertyList'
import type { TabProperties } from './types'

const tabItems = [
  {
    title: '/api/v3/mall/index',
    properties: [
      {
        field: 'decoration_tpl',
        name: '盲盒换肤',
        description: '选择商城盲盒的皮肤模板',
        type: 'select' as const,
        options: [
          { label: '默认', value: 'default' },
          { label: 'VCT.CN', value: 'vct' },
          { label: 'Lunar 2026', value: 'lunar2026' },
        ],
        ser: (v: any) => v || '',
        de: (v: string) => v || '',
      },
    ],
  },
]

export default function MallTabContent({ tabKey, tabKeyToValues, onChange, onSave }: TabProperties) {
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
