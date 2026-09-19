import type { Context } from '@pluxel/core'
import { NodeModuleHost } from '../node/token'
import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi } from '@pluxel/host-dev/vite'
import { NodeArtifactCompiler, type NodeArtifactCompilerOptions } from './node-compiler'

export { NodeArtifactCompiler, type NodeArtifactCompilerOptions } from './node-compiler'

/** Attaches one shared source compiler to an installed NodeModules backend. The caller owns disposal. */
export function attachNodeArtifactCompiler(
	ctx: Context,
	options: NodeArtifactCompilerOptions = {},
): Readonly<{ dispose(): Promise<void> }> {
	if (ctx !== ctx.root) throw new TypeError('Node artifact host requires a root Context')
	const backend = ctx.root.require(NodeModuleHost)
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
