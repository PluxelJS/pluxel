import { readLoadedNodeArtifacts } from '../node/packaged-artifacts'
import type { Context } from '@pluxel/core'
import { NodeModuleHost } from '../node/token'
import type { Plugin } from 'vite'
import type { HostVitePluginApi, HostViteCandidate } from '@pluxel/host-vite'
import { NodeArtifactCompiler, type NodeArtifactCompilerOptions } from './node-compiler'

export { NodeArtifactCompiler, type NodeArtifactCompilerOptions } from './node-compiler'

/** Attaches one shared source compiler to an installed NodeModules backend. The caller owns disposal. */
export function attachNodeArtifactCompiler(
	ctx: Context,
	options: NodeArtifactCompilerOptions = {},
): Readonly<{ dispose(): Promise<void> }> {
	if (ctx !== ctx.root) throw new TypeError('Node artifact host requires a root Context')
	const backend = ctx.root.require(NodeModuleHost)
	if (backend.hasArtifactConfiguration)
		throw new TypeError('Node source compilation conflicts with explicit artifact configuration')
	const compiler = new NodeArtifactCompiler(ctx, options)
	const detach = backend.attachSourceBinder((declaration, onUpdate, onError) =>
		compiler.watchNodeModule(declaration, onUpdate, onError),
	)
	let closeTask: Promise<void> | undefined
	return Object.freeze({
		dispose: () => {
			if (!closeTask) {
				detach()
				closeTask = compiler.dispose()
			}
			return closeTask
		},
	})
}

/** Explicit Node artifact development support for hosts assembled by host(). */
export function nodeArtifacts(
	options: Readonly<{ cacheDir?: string }> = {},
): Plugin<HostVitePluginApi> {
	return {
		name: 'pluxel:node-artifacts',
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach(input) {
					const backend = input.host.ctx.require(NodeModuleHost)
					if (backend.hasArtifactConfiguration) return undefined
					const { host, server, catalog } = input
					const compiler = attachNodeArtifactCompiler(host.ctx, { ...options, viteServer: server })
					const prepareCandidate = async (
						candidate: typeof catalog,
					): Promise<HostViteCandidate> => {
						const artifacts = await readLoadedNodeArtifacts(candidate.plugins)
						return {
							commit() {
								backend.installLoadedArtifacts(artifacts)
							},
							rollback() {},
						}
					}
					try {
						const initial = await prepareCandidate(catalog)
						initial.commit()
					} catch (error) {
						await compiler.dispose()
						throw error
					}
					return { prepareCandidate, dispose: compiler.dispose }
				},
			},
		},
	}
}
