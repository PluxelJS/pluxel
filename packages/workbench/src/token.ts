import { defineContextCapability } from '@pluxel/core/host'
import type { PluginWorkbench } from './workbench/definition'
import type { WorkbenchBackend } from './services/workbench'

export const Workbench = defineContextCapability<PluginWorkbench>('workbench', {
	access: 'owner',
	property: 'workbench',
})
export const WorkbenchHost = defineContextCapability<WorkbenchBackend>('workbench.host', {
	access: 'root',
})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly workbench?: PluginWorkbench
	}
}
