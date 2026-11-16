import { Button, Input, Select, SelectItem } from '@heroui/react'

// MIS属性类型定义
export interface MisProperty {
  field: string
  name: string
  description: string
  type?: 'text' | 'select'
  options?: { label: string; value: string }[]
  ser: (v: any) => string
  de: (v: string) => any
}

// 可编辑属性列表组件
export interface EditablePropertyListProps {
  title: string
  properties: MisProperty[]
  values: Record<string, string>
  onChange?: (values: Record<string, any>) => void
  onSave?: () => void
}

export default function EditablePropertyList({
  title,
  properties,
  values = {},
  onChange,
  onSave,
}: EditablePropertyListProps) {
  const handleInputChange = (field: string, value: any) => {
    onChange?.({
      ...values,
      [field]: value,
    })
  }

  const handleSave = () => {
    onSave?.()
  }

  return (
    <div className="editable-property-list-wrapper">
      <h2>{title}</h2>
      <div className="editable-property-list">
        {properties.map((property) => (
          <div
            key={property.field}
            className={`property-item${property.ser(values[property.field]) ? ' filled' : ''}`}
          >
            <label>{property.name}</label>
            <p>{property.description}</p>
            {property.type === 'select' && property.options ? (
              <Select
                selectedKeys={property.ser(values[property.field]) ? [property.ser(values[property.field])] : []}
                onSelectionChange={(keys) => {
                  const selected = Array.from(keys)[0] as string
                  handleInputChange(property.field, property.de(selected))
                }}
                variant="bordered"
                size="sm"
              >
                {property.options.map((opt) => (
                  <SelectItem key={opt.value}>{opt.label}</SelectItem>
                ))}
              </Select>
            ) : (
              <Input
                type="text"
                value={property.ser(values[property.field]) || ''}
                onValueChange={(value) => handleInputChange(property.field, property.de(value) || '')}
                variant="bordered"
                size="sm"
              />
            )}
          </div>
        ))}
      </div>
      <Button onPress={handleSave} color="primary" size="md" className="save-button">
        保存
      </Button>
    </div>
  )
}
