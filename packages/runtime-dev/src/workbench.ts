import type { Context } from '@pluxel/runtime'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { mergeConfig, type InlineConfig } from 'vite'

import './context-augment'
import {
	WorkbenchCompilerService,
	type WorkbenchCompilerServiceConfig,
	type WorkbenchCompilerViteServer,
} from './workbench/WorkbenchCompilerService'

export type { WorkbenchCompilerServiceConfig } from './workbench/WorkbenchCompilerService'

export type WorkbenchCompilerAttachmentOptions = {
	config?: WorkbenchCompilerServiceConfig
	vite?: InlineConfig
	viteServer?: WorkbenchCompilerViteServer
}

function mergeWorkbenchCompilerViteConfig(
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
	if (ctx !== ctx.root) {
		throw new Error('[runtime-dev] Workbench compiler must be attached to the root Context')
	}

	const config = mergeWorkbenchCompilerViteConfig(
		options.config ?? ctx.config.workbenchCompiler,
		options.vite,
	)
	const artifacts = requireWorkbench(ctx).artifacts
	const compiler = new WorkbenchCompilerService(
		ctx,
		{
			store: artifacts,
			viteServer: options.viteServer,
		},
		config,
	)

	try {
		const detach = artifacts.attachSourceBinder((ownerCtx, declaration) =>
			compiler.bindDeclaration(ownerCtx, declaration),
		)
		const guard = ctx.effects.defer(() => {
			detach()
			compiler.dispose()
		})
		return () => guard.dispose()
	} catch (error) {
		compiler.dispose()
		throw error
	}
}
