// Browser entry for the custom UI demo.
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { PluginWithUIUi } from '../../PluginWithUI.workbench'

export const pluginUi = createWorkbenchUi(PluginWithUIUi)
