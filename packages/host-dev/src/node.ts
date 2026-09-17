import type { Context } from '@pluxel/core'
import { requireNodeModuleHost } from '@pluxel/services/internal/node'
import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi } from './attachments'
import { NodeArtifactCompiler, type NodeArtifactCompilerOptions } from './node-compiler'

export { NodeArtifactCompiler, type NodeArtifactCompilerOptions } from './node-compiler'

/** Attaches one shared source compiler to an installed NodeModules backend. The caller owns disposal. */
export function attachNodeArtifactCompiler(
	ctx: Context,
	options: NodeArtifactCompilerOptions = {},
): Readonly<{ dispose(): Promise<void> }> {
	const backend = requireNodeModuleHost(ctx)
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
): Plugin<HostDevelopmentPluginApi> {
	return {
		name: 'pluxel:node-artifacts',
		apply: 'serve',
		api: {
			pluxelHost: {
				attach: ({ host, server }) =>
					attachNodeArtifactCompiler(host.ctx, { ...options, viteServer: server }).dispose,
			},
		},
	}
}
