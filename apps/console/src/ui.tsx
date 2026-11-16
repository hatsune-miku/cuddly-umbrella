import { Button as CakeButton, type ButtonProps } from '@a1knla/cakeui'

export {
  Alert,
  Avatar,
  Badge,
  CakeProvider,
  CheckBox,
  ComboBox,
  Dialog,
  NumberBox,
  ProgressBar,
  Spinner,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextArea,
  TextBox,
} from '@a1knla/cakeui'

/** Keep business selectors stable while centralizing the visual action hierarchy. */
export function Button({ className = '', variant, size = 'small', ...props }: ButtonProps) {
  const resolvedVariant =
    variant ??
    (/(?:danger|cancel-build|delete-button)/.test(className)
      ? 'danger'
      : /(?:primary-button|auth-action)/.test(className)
        ? 'primary'
        : /(?:text-button|icon-button|queue-row|history-row|branch-picker-option|requirement-action)/.test(
              className
            )
          ? 'ghost'
          : 'default')
  return <CakeButton {...props} className={className} variant={resolvedVariant} size={size} />
}
