import type { Context } from '@pluxel/runtime'
import { requireWorkbench } from '@pluxel/runtime/internal'

import {
	PluginArtifactCompiler,
	type PluginArtifactCompilerOptions,
	type PluginArtifactCompilerViteServer,
	type WorkbenchArtifactCompilations,
} from './workbench/PluginArtifactCompiler.ts'

export type PluginArtifactCompilerAttachmentOptions = PluginArtifactCompilerOptions &
	Readonly<{
		viteServer?: PluginArtifactCompilerViteServer
	}>

export type PluginArtifactCompilerAttachment = Readonly<{
	publishWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): ReturnType<PluginArtifactCompiler['publishWorkbenchArtifacts']>
	dispose(): void
}>

const attachments = new WeakMap<Context, PluginArtifactCompilerAttachment>()

/**
 * Attaches the route-neutral Node/Workbench artifact compiler to one Runtime root.
 *
 * Workbench artifact compilations must come from the shared semantic lowering snapshot. The
 * attachment does not observe generation publication or rediscover Content/renderer entries.
 */
export function attachPluginArtifactCompiler(
	ctx: Context,
	options: PluginArtifactCompilerAttachmentOptions,
): PluginArtifactCompilerAttachment {
	if (ctx !== ctx.root) {
		throw new Error('[runtime-dev] artifact compiler must be attached to the root Context')
	}
	if (attachments.has(ctx)) {
		throw new Error('[runtime-dev] artifact compiler is already attached')
	}

	const coordinator = ctx.workbench ? requireWorkbench(ctx).artifactCoordinator : undefined
	const compiler = new PluginArtifactCompiler(
		ctx,
		{ coordinator, viteServer: options.viteServer },
		{ cacheDir: options.cacheDir, packageMode: options.packageMode },
	)
	const detachNode = ctx.nodeModules.attachSourceBinder((declaration, onUpdate, onError) =>
		compiler.watchNodeModule(declaration, onUpdate, onError),
	)
	let active = true
	const attachment: PluginArtifactCompilerAttachment = Object.freeze({
		publishWorkbenchArtifacts: (input: WorkbenchArtifactCompilations) => {
			if (!active) {
				return Promise.reject(new Error('[runtime-dev] artifact compiler is disposed'))
			}
			return compiler.publishWorkbenchArtifacts(input)
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
	WorkbenchArtifactCompilations,
	WorkbenchContentCompilation,
	PluginArtifactCompilerOptions,
	PluginArtifactCompilerViteServer,
	WorkbenchProducerCompilation,
} from './workbench/PluginArtifactCompiler.ts'
