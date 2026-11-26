import type { PluginWorkbench } from './workbench/definition'
import type { WorkbenchBackend } from './services/workbench'
export abstract class Workbench {
	static readonly access = 'owner' as const
}
export interface Workbench extends PluginWorkbench {}
export abstract class WorkbenchHost {
	static readonly access = 'root' as const
}
export interface WorkbenchHost extends WorkbenchBackend {}
