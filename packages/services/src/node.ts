import {
	installOwnerViewCapability,
	installRootCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { NodeModules, NodeModuleHost } from './node/token'
import { NodeModuleService, type NodeModuleArtifactHostOptions } from './node/service'

export { NodeModules, type NodeModuleApi } from './node/token'
export {
	defineNodeModule,
	type NodeModuleDeclaration,
	type NodeModuleSetup,
	type NodeModuleCleanup,
} from './node/declaration'
export type { NodeModuleArtifactHostOptions } from './node/service'

/** Install owner-bound Node artifacts. Source compilation is attached separately by development hosts. */
export function nodeModules(options: NodeModuleArtifactHostOptions = {}) {
	const snapshot = Object.freeze({ ...options })
	return defineHostService({
		name: 'Node modules',
		capabilities: [
			installRootCapability(NodeModuleHost, {
				create: (ctx) => new NodeModuleService(ctx, snapshot),
			}),
			installOwnerViewCapability(NodeModules, {
				property: 'nodeModules',
				createRoot: (ctx) => resolveContextCapability(ctx, NodeModuleHost),
				createView: (backend, owner) => {
					const service = backend.forOwner(owner)
					return Object.freeze({ ctx: owner, use: service.use.bind(service) })
				},
			}),
		],
	})
}
