import type { Context } from '@pluxel/runtime'
import { requireWorkbench } from '@pluxel/runtime/internal'

import {
	PluginArtifactCompiler,
	type PluginArtifactCompilerOptions,
	type PluginArtifactCompilerViteServer,
	type WorkbenchProducerCompilation,
} from './workbench/PluginArtifactCompiler'

export type PluginArtifactCompilerAttachmentOptions = PluginArtifactCompilerOptions &
	Readonly<{
		viteServer?: PluginArtifactCompilerViteServer
	}>

export type PluginArtifactCompilerAttachment = Readonly<{
	publishWorkbenchProducers(
		inputs: readonly WorkbenchProducerCompilation[],
	): ReturnType<PluginArtifactCompiler['publishWorkbenchProducers']>
	dispose(): void
}>

const attachments = new WeakMap<Context, PluginArtifactCompilerAttachment>()

/**
 * Attaches the route-neutral Node/Workbench artifact compiler to one Runtime root.
 *
 * Workbench producer plans must be supplied by the shared semantic lowering pass. The
 * attachment does not observe generation publication or rediscover renderer entries.
 */
export function attachPluginArtifactCompiler(
	ctx: Context,
	options: PluginArtifactCompilerAttachmentOptions = {},
): PluginArtifactCompilerAttachment {
	if (ctx !== ctx.root) {
		throw new Error('[runtime-dev] artifact compiler must be attached to the root Context')
	}
	if (attachments.has(ctx)) {
		throw new Error('[runtime-dev] artifact compiler is already attached')
	}

	const store = ctx.workbench ? requireWorkbench(ctx).artifacts : undefined
	const compiler = new PluginArtifactCompiler(
		ctx,
		{ store, viteServer: options.viteServer },
		{ cacheDir: options.cacheDir },
	)
	const detachNode = ctx.nodeModules.attachSourceBinder((declaration, onUpdate, onError) =>
		compiler.watchNodeModule(declaration, onUpdate, onError),
	)
	let active = true
	const attachment: PluginArtifactCompilerAttachment = Object.freeze({
		publishWorkbenchProducers: (inputs: readonly WorkbenchProducerCompilation[]) => {
			if (!active) {
				return Promise.reject(new Error('[runtime-dev] artifact compiler is disposed'))
			}
			return compiler.publishWorkbenchProducers(inputs)
		},
		dispose: () => {
			if (!active) return
			active = false
			attachments.delete(ctx)
			detachNode()
			compiler.dispose()
		},
	})
	attachments.set(ctx, attachment)
	try {
		ctx.effects.defer(attachment.dispose)
	} catch (error) {
		attachment.dispose()
		throw error
	}
	return attachment
}

export type {
	PluginArtifactCompilerOptions,
	PluginArtifactCompilerViteServer,
	WorkbenchProducerCompilation,
} from './workbench/PluginArtifactCompiler'
