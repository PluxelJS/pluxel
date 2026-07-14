// Browser entry for the custom UI demo.
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { PluginWithUIWorkbench } from '../../PluginWithUI.workbench'

export const pluginUi = createWorkbenchUi<typeof PluginWithUIWorkbench>()
