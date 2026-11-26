import type { NodeModuleService } from './service'

export type NodeModuleApi = Pick<NodeModuleService, 'ctx' | 'use'>
export abstract class NodeModuleHost {
	static readonly access = 'root' as const
}
export interface NodeModuleHost extends NodeModuleService {}
export abstract class NodeModules {}
export interface NodeModules extends NodeModuleApi {}
