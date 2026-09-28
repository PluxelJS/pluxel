import { defineContextCapability } from '@pluxel/core/host'
import type { NodeModuleService } from './service'

export type NodeModuleApi = Pick<NodeModuleService, 'ctx' | 'use'>
export const NodeModuleHost = defineContextCapability<NodeModuleService>('services.node-host', {
	access: 'root',
})

export const NodeModules = defineContextCapability<NodeModuleApi>('services.node', {
	access: 'all',
	property: 'nodeModules',
})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly nodeModules: NodeModuleApi
	}
}
