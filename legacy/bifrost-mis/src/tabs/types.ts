import type { MisProperty } from '../components/EditablePropertyList'

export interface TabProperties {
  tabKey: string
  tabKeyToValues: Record<string, Record<string, any>>
  onChange?: (tabKey: string, values: Record<string, any>) => void
  onSave?: (tabKey: string) => void
}

export interface MisTab {
  tabKey: string
  title: string
  tabItems: MisTabItem[]
}

export interface MisTabItem {
  title: string
  properties: MisProperty[]
}
