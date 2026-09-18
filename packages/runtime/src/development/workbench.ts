import { attachNodeArtifactCompiler } from '@pluxel/services/node/vite'
import type { Context } from '../index.ts'
import { optionalWorkbench } from '@pluxel/workbench/server'

import {
	PluginArtifactCompiler,
	type PluginArtifactCompilerOptions,
	type PluginArtifactCompilerViteServer,
	type WorkbenchArtifactCompilations,
} from '@pluxel/workbench/dev'

export type PluginArtifactCompilerAttachmentOptions = PluginArtifactCompilerOptions &
	Readonly<{
		viteServer?: PluginArtifactCompilerViteServer
	}>

export type PluginArtifactCompilerAttachment = Readonly<{
	prepareWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): ReturnType<PluginArtifactCompiler['prepareWorkbenchArtifacts']>
	publishWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): ReturnType<PluginArtifactCompiler['publishWorkbenchArtifacts']>
	dispose(): Promise<void>
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
		throw new Error('[host-dev] artifact compiler must be attached to the root Context')
	}
	if (attachments.has(ctx)) {
		throw new Error('[host-dev] artifact compiler is already attached')
	}

	const backend = optionalWorkbench(ctx)
	const coordinator = backend?.artifactCoordinator
	const compiler = new PluginArtifactCompiler(
		ctx,
		{ coordinator, producerStatus: backend?.producerStatus, viteServer: options.viteServer },
		{ cacheDir: options.cacheDir, packageMode: options.packageMode },
	)
	const nodeCompiler = attachNodeArtifactCompiler(ctx, options)
	let closeTask: Promise<void> | undefined
	let active = true
	const attachment: PluginArtifactCompilerAttachment = Object.freeze({
		prepareWorkbenchArtifacts: (input: WorkbenchArtifactCompilations) => {
			if (!active) return Promise.reject(new Error('[host-dev] artifact compiler is disposed'))
			return compiler.prepareWorkbenchArtifacts(input)
		},
		publishWorkbenchArtifacts: (input: WorkbenchArtifactCompilations) => {
			if (!active) {
				return Promise.reject(new Error('[host-dev] artifact compiler is disposed'))
			}
			return compiler.publishWorkbenchArtifacts(input)
		},
		dispose: () => {
			if (closeTask) return closeTask
			active = false
			attachments.delete(ctx)
			closeTask = Promise.all([compiler.dispose(), nodeCompiler.dispose()]).then(
				(): void => undefined,
			)
			return closeTask
		},
	})
	attachments.set(ctx, attachment)
	try {
		ctx.effects.defer(attachment.dispose)
	} catch (error) {
		void attachment
			.dispose()
			.catch((disposeError) =>
				ctx.logger.error('failed to dispose artifact compiler', { error: disposeError }),
			)
		throw error
	}
	return attachment
}

export type {
	PreparedWorkbenchArtifacts,
	WorkbenchArtifactCompilations,
	WorkbenchContentCompilation,
	PluginArtifactCompilerOptions,
	PluginArtifactCompilerViteServer,
	WorkbenchProducerCompilation,
} from '@pluxel/workbench/dev'
