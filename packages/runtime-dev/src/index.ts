import type { Context } from '@pluxel/core'
import {
	clearHmrRuntimeHandles,
	getHmrRuntimeHandles,
	setHmrRuntimeHandles,
} from '@pluxel/runtime/internal'
import { mergeConfig, type InlineConfig, type ViteDevServer } from 'vite'
import './context-augment'

import {
	ExtensionCompilerService,
	type ExtensionCompilerServiceConfig,
} from './extensions/ExtensionCompilerService'

export {
	ExtensionCompilerService,
	type ExtensionCompilerServiceConfig,
	type ExtensionCompilerServiceDeps,
} from './extensions/ExtensionCompilerService'

export type InstallExtensionDevRuntimeOptions = {
	viteServer?: ViteDevServer
	vite?: InlineConfig
	compiler?: ExtensionCompilerServiceConfig
	enableRuntimeServices?: boolean
}

export type InstallExtensionDevRuntimeResult = {
	ctx: Context
	extensionCompiler: ExtensionCompilerService
	dispose(): void
}

export function mergeExtensionCompilerViteConfig(
	base: ExtensionCompilerServiceConfig | undefined,
	vite: InlineConfig | undefined,
): ExtensionCompilerServiceConfig | undefined {
	if (!vite) return base
	return {
		...base,
		vite: base?.vite ? mergeConfig(base.vite, vite) : vite,
	}
}

export function installExtensionDevRuntime(
	ctx: Context,
	options: InstallExtensionDevRuntimeOptions = {},
): InstallExtensionDevRuntimeResult {
	const previousHandles = getHmrRuntimeHandles(ctx)
	if (previousHandles?.extensions?.bindUiSource) {
		throw new Error('[runtime-dev] extension source UI runtime is already installed')
	}

	const compilerConfig = mergeExtensionCompilerViteConfig(options.compiler, options.vite)
	ctx.config.extensionCompiler = compilerConfig

	const extensionCompiler = new ExtensionCompilerService(
		ctx,
		{ viteServer: options.viteServer, enabled: true },
		compilerConfig,
	)

	if (options.enableRuntimeServices !== false) {
		ctx.config.http = { ...ctx.config.http, uiAssets: 'hmr-server' }
		ctx.config.extensionService = {
			...ctx.config.extensionService,
			enabled: true,
		}
	}

	const extensionStore = ctx.ext.ui
	extensionStore.reconfigure(ctx.config.extensionService)
	extensionCompiler.attachStore(extensionStore)

	setHmrRuntimeHandles(ctx, {
		...previousHandles,
		extensions: {
			...previousHandles?.extensions,
			bindUiSource: (ownerCtx, declaration) =>
				extensionCompiler.bindDeclaration(ownerCtx, declaration),
		},
	})

	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		extensionCompiler.dispose()
		if (previousHandles) setHmrRuntimeHandles(ctx, previousHandles)
		else clearHmrRuntimeHandles(ctx)
	}
	ctx.effects.defer(dispose)

	return { ctx, extensionCompiler, dispose }
}
