import { resolveContextService } from '@pluxel/core/internal'
import { readLoadedNodeArtifacts } from './node/packaged-artifacts'
import { installOwnerViewService, installRootService } from '@pluxel/core/host'
import { defineHostService, type HostService } from '@pluxel/host'
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
export function nodeModules(options: NodeModuleArtifactHostOptions = {}): HostService {
	const snapshot = Object.freeze({ ...options })
	return defineHostService({
		name: 'Node modules',
		provides: [
			installRootService(NodeModuleHost, {
				create: (ctx) => new NodeModuleService(ctx, snapshot),
			}),
			installOwnerViewService(NodeModules, {
				createRoot: (ctx) => resolveContextService(ctx, NodeModuleHost),
				createView: (backend, owner) => {
					const service = backend.forOwner(owner)
					return Object.freeze({ ctx: owner, use: service.use.bind(service) })
				},
			}),
		],
		async prepare({ ctx, plugins }) {
			if (snapshot.root !== undefined || snapshot.resolve !== undefined) return
			const artifacts = await readLoadedNodeArtifacts(plugins)
			resolveContextService(ctx, NodeModuleHost).installLoadedArtifacts(artifacts)
		},
	})
}
