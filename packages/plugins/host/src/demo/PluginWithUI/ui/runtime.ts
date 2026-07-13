// Browser entry for the custom UI demo.
import { managementApp } from '@pluxel/runtime/management/ui'
import { PluginWithUIManagement } from '../../PluginWithUI.management'

export const plugin = managementApp(PluginWithUIManagement)
