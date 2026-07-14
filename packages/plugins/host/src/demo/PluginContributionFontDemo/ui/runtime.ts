import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { FontManagerWorkbench } from '../../PluginContributionFontDemo.workbench'

export const fontSettingsUi = createWorkbenchUi<typeof FontManagerWorkbench>()
export const fontSettingsView = fontSettingsUi.views.FontSettings
