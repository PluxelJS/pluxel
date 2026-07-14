// Browser entry for the custom UI demo.
import { managementApp } from '@pluxel/runtime/management/ui'
import type { PluginWithUIManagement } from '../../PluginWithUI.management'

export const plugin = managementApp<typeof PluginWithUIManagement>()
