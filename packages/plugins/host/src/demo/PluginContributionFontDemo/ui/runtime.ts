import { managementApp } from '@pluxel/runtime/management/ui'
import type { FontManagerManagement } from '../../PluginContributionFontDemo.management'
import type { FontSettingsPort } from '../../PluginContributionFontDemo.shared'

export const fontManager = managementApp<typeof FontManagerManagement>()
export const fontSettings = managementApp<typeof FontSettingsPort>()
