import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { FontSettingsWorkbenchView } from '../../PluginContributionFontDemo.workbench'

export const fontSettingsUi = createWorkbenchUi<FontSettingsWorkbenchView>()
export const fontSettingsView = fontSettingsUi.view('FontSettings')
