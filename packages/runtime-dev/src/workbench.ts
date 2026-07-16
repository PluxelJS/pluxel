import type { Context } from '@pluxel/runtime'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { mergeConfig, type InlineConfig } from 'vite'

import './context-augment'
import {
	WorkbenchCompilerService,
	type WorkbenchCompilerServiceConfig,
	type WorkbenchCompilerViteServer,
} from './workbench/WorkbenchCompilerService'

export {
	WorkbenchCompilerService,
	type WorkbenchCompilerServiceConfig,
	type WorkbenchCompilerServiceDeps,
} from './workbench/WorkbenchCompilerService'

export type WorkbenchCompilerAttachmentOptions = {
	config?: WorkbenchCompilerServiceConfig
	vite?: InlineConfig
	viteServer?: WorkbenchCompilerViteServer
}

export function mergeWorkbenchCompilerViteConfig(
	base: WorkbenchCompilerServiceConfig | undefined,
	vite: InlineConfig | undefined,
): WorkbenchCompilerServiceConfig | undefined {
	if (!vite) return base
	return {
		...base,
		vite: base?.vite ? mergeConfig(base.vite, vite) : vite,
	}
}

export function attachWorkbenchCompiler(
	ctx: Context,
	options: WorkbenchCompilerAttachmentOptions = {},
): () => void | Promise<void> {
	const previousDev = ctx.runtimeDev
	if (previousDev?.workbenchUiSource) {
		throw new Error('[runtime-dev] Workbench compiler is already attached')
	}

	const previousConfig = ctx.config.workbenchCompiler
	const config = mergeWorkbenchCompilerViteConfig(options.config ?? previousConfig, options.vite)
	const compiler = new WorkbenchCompilerService(
		ctx,
		{
			store: requireWorkbench(ctx).registry.getArtifacts(),
			viteServer: options.viteServer,
			enabled: true,
		},
		config,
	)

	ctx.config.workbenchCompiler = config
	ctx.runtimeDev = {
		...previousDev,
		workbenchUiSource: {
			bind: (ownerCtx, declaration) => compiler.bindDeclaration(ownerCtx, declaration),
		},
	}

	try {
		const guard = ctx.effects.defer(() => {
			compiler.dispose()
			ctx.runtimeDev = previousDev
			if (ctx.config.workbenchCompiler === config) {
				ctx.config.workbenchCompiler = previousConfig
			}
		})
		return () => guard.dispose()
	} catch (error) {
		compiler.dispose()
		ctx.runtimeDev = previousDev
		ctx.config.workbenchCompiler = previousConfig
		throw error
	}
}
