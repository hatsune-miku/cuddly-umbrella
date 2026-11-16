import { useEffect, useState } from 'react'

import { addToast, Tab, Tabs } from '@heroui/react'

import { useSystemDarkModeAware } from './hooks'
import './index.scss'
import GlobalTabContent from './tabs/global'
import HotModuleTabContent from './tabs/hot-module'
import LegacyHotUpdateTabContent from './tabs/legacy-hot-update'
import MallTabContent from './tabs/mall'
import { ThemeSwitcher } from './ThemeSwitcher'

const MIS_OPERATION_URL = 'https://bifrost-api.vanillacake.cn/mis-operation'

function App() {
  const [tabKeyToValues, setTabKeyToValues] = useState<Record<string, Record<string, any>>>({})

  useSystemDarkModeAware()

  useEffect(() => {
    fetch(MIS_OPERATION_URL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })
      .then((res) => res.json())
      .then(setTabKeyToValues)
  }, [])

  // tabKey 即 misData 的 overlay key（settingsOverlay / mallConfig / hotModuleConfig），保存时整体回写该 slice。
  function handleChange(tabKey: string, values: Record<string, any>) {
    setTabKeyToValues((prev) => ({
      ...prev,
      [tabKey]: values,
    }))
  }

  function handleSave(tabKey: string) {
    fetch(MIS_OPERATION_URL, {
      method: 'POST',
      body: JSON.stringify({
        [tabKey]: tabKeyToValues[tabKey],
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    }).then(() => {
      addToast({
        title: '保存成功',
      })
    })
  }

  return (
    <div style={{ padding: '20px', width: '1000px' }}>
      <Tabs color="primary" variant="underlined">
        <Tab title="热更新">
          <HotModuleTabContent
            tabKey="hotModuleConfig"
            tabKeyToValues={tabKeyToValues}
            onChange={handleChange}
            onSave={handleSave}
          />
        </Tab>
        <Tab title="商城">
          <MallTabContent
            tabKey="mallConfig"
            tabKeyToValues={tabKeyToValues}
            onChange={handleChange}
            onSave={handleSave}
          />
        </Tab>
        <Tab title="全局">
          <GlobalTabContent
            tabKey="settingsOverlay"
            tabKeyToValues={tabKeyToValues}
            onChange={handleChange}
            onSave={handleSave}
          />
        </Tab>
        <Tab title="旧热更新">
          <LegacyHotUpdateTabContent
            tabKey="settingsOverlay"
            tabKeyToValues={tabKeyToValues}
            onChange={handleChange}
            onSave={handleSave}
          />
        </Tab>
        <Tab disabled>
          <ThemeSwitcher />
        </Tab>
      </Tabs>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }} />
    </div>
  )
}

export default App
