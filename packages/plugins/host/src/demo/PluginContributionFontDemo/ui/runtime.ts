import { managementApp } from '@pluxel/runtime/management/ui'
import { FontManagerManagement } from '../../PluginContributionFontDemo.management'
import { FontSettingsPort } from '../../PluginContributionFontDemo.shared'

export const fontManager = managementApp(FontManagerManagement)
export const fontSettings = managementApp(FontSettingsPort)
