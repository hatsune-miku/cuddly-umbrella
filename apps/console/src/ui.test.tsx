import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, CheckBox, ComboBox, NumberBox, Switch, TextArea, TextBox } from './ui'

describe('CakeUI integration', () => {
  it('preserves action semantics and disabled state', () => {
    const html = renderToStaticMarkup(
      <Button type="submit" className="primary-button" disabled aria-label="保存配置">
        保存
      </Button>
    )
    expect(html).toContain('type="submit"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('data-variant="primary"')
    expect(html).toContain('cake-button primary-button')
    expect(html).toContain('aria-label="保存配置"')
  })

  it('uses native accessible fields instead of replacing their events or values', () => {
    const html = renderToStaticMarkup(
      <>
        <TextBox type="url" defaultValue="https://example.test" required />
        <NumberBox defaultValue={3} min={1} max={12} />
        <TextArea defaultValue="pnpm build" />
        <ComboBox defaultValue="tttt">
          <option value="tttt">测试环境</option>
        </ComboBox>
      </>
    )
    expect(html).toContain('type="url"')
    expect(html).toContain('required=""')
    expect(html).toContain('cake-numberbox')
    expect(html).toContain('min="1"')
    expect(html).toContain('cake-textarea')
    expect(html).toMatch(/<option(?=[^>]*value="tttt")(?=[^>]*selected="")[^>]*>/)
  })

  it('gives each switch and checkbox exactly one label', () => {
    const html = renderToStaticMarkup(
      <>
        <Switch defaultChecked>走公司内网</Switch>
        <CheckBox defaultChecked>启用项目</CheckBox>
      </>
    )
    expect(html.match(/<label\b/g)).toHaveLength(2)
    expect(html.match(/<input\b/g)).toHaveLength(2)
    expect(html).toContain('role="switch"')
  })

  it('maps destructive and low-priority action styles consistently', () => {
    expect(renderToStaticMarkup(<Button className="cancel-build-button">中断</Button>)).toContain(
      'data-variant="danger"'
    )
    expect(renderToStaticMarkup(<Button className="icon-button">刷新</Button>)).toContain(
      'data-variant="ghost"'
    )
  })
})
