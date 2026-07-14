import { workbench } from '@pluxel/runtime/workbench'
import { PluginWithUIUi } from './PluginWithUI.workbench'

export const PluginWithUIWorkbench = workbench.extension({
	contract: PluginWithUIUi,
	entry: workbench.entry(import.meta.url, './PluginWithUI/ui/index.tsx'),
})
