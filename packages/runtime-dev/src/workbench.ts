import type { Context } from '@pluxel/runtime'
import { fileURLToPath } from 'node:url'
import { readWorkbenchUiEntry, requireWorkbench } from '@pluxel/runtime/internal'
import { resolve } from 'pathe'
import { resolvePluginArtifactKey } from '@pluxel/rolldown/vite/declaration'

import {
	PluginArtifactCompiler,
	type PluginArtifactCompilerViteServer,
} from './workbench/PluginArtifactCompiler'

export type PluginArtifactCompilerAttachmentOptions = {
	pluginDirs?: Record<string, string>
	viteServer?: PluginArtifactCompilerViteServer
}

export function attachPluginArtifactCompiler(
	ctx: Context,
	options: PluginArtifactCompilerAttachmentOptions = {},
): () => void | Promise<void> {
	if (ctx !== ctx.root) {
		throw new Error('[runtime-dev] Workbench compiler must be attached to the root Context')
	}

	const artifacts = ctx.workbench.enabled ? requireWorkbench(ctx).artifacts : undefined
	let compiler: PluginArtifactCompiler | undefined
	const getCompiler = () =>
		(compiler ??= new PluginArtifactCompiler(
			ctx,
			{ store: artifacts, viteServer: options.viteServer },
			{ pluginDirs: options.pluginDirs },
		))

	try {
		const detachNode = ctx.nodeModules.attachSourceBinder((declaration, onUpdate, onError) =>
			getCompiler().watchNodeModule(declaration, onUpdate, onError),
		)
		const detachWorkbench = artifacts?.attachSourceBinder(
			(ownerCtx, declaration, contractFingerprint) => {
				const descriptor = readWorkbenchUiEntry(declaration)
				const declarationFile = fileURLToPath(descriptor.moduleUrl)
				const root = resolve(options.viteServer?.config.root ?? process.cwd())
				const declarationKey =
					descriptor.artifactKey ??
					resolvePluginArtifactKey('workbench', root, declarationFile, descriptor.entryPath)
				return getCompiler().bindDeclaration(ownerCtx, {
					entryPath: fileURLToPath(new URL(descriptor.entryPath, descriptor.moduleUrl)),
					declarationKey,
					contractFingerprint,
				})
			},
		)
		const guard = ctx.effects.defer(() => {
			detachWorkbench?.()
			detachNode()
			compiler?.dispose()
		})
		return () => guard.dispose()
	} catch (error) {
		compiler?.dispose()
		throw error
	}
}
