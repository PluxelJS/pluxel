import {
	installExtensionDevRuntime,
	type InstallExtensionDevRuntimeResult,
} from '@pluxel/runtime-dev'
import type { InlineConfig, ViteDevServer } from 'vite'

import type {
	StaticRuntimeDefinition,
	StaticRuntimeHmrReport,
	StaticRuntimeHost,
} from './index'

export type ReloadStaticRuntimeOptions = {
	host: StaticRuntimeHost
	definition: StaticRuntimeDefinition
}

/**
 * Apply a static runtime definition update to an already-running static host.
 *
 * The caller owns how the definition was imported (for example Vite SSR import).
 * This function only compares the fixed catalog by plugin name, revalidates
 * enabled plugins through the host config service, and delegates lifecycle
 * changes to core commit.
 */
export function reloadStaticRuntime(
	options: ReloadStaticRuntimeOptions,
): Promise<StaticRuntimeHmrReport> {
	return options.host.hmr.reload(options.definition)
}

export type InstallStaticRuntimeHmrOptions = {
	host: StaticRuntimeHost
	viteServer?: ViteDevServer
	vite?: InlineConfig
	extensionCompiler?: StaticRuntimeExtensionCompilerConfig
	enableRuntimeServices?: boolean
}

export type InstallStaticRuntimeHmrResult = {
	host: StaticRuntimeHost
	dispose(): void
}

export type StaticRuntimeExtensionCompilerConfig = {
	enabled?: boolean
	/**
	 * Disk cache directory for compiled extension modules.
	 *
	 * Defaults to `.pluxel/extensions` under `process.cwd()`.
	 */
	cacheDir?: string
	/**
	 * How many compiled remote builds to keep per plugin on disk.
	 * @default 5
	 */
	cacheKeep?: number
	/**
	 * Maximum number of plugin UI remotes compiled concurrently.
	 * @default 2
	 */
	compileConcurrency?: number
	/**
	 * Override the shared package list exposed by the host runtime.
	 */
	sharedPackages?: string[]
	/** Extra Vite config merged into plugin UI remote builds. */
	vite?: InlineConfig
}

/**
 * Install route-neutral development handles for a static host.
 *
 * Static owns the fixed catalog/reload model; this only enables the same source UI
 * to web MF remote compilation path used by dynamic HMR.
 */
export function installStaticRuntimeHmr(
	options: InstallStaticRuntimeHmrOptions,
): InstallStaticRuntimeHmrResult {
	const result: InstallExtensionDevRuntimeResult = installExtensionDevRuntime(options.host.ctx, {
		viteServer: options.viteServer,
		vite: options.vite,
		compiler: options.extensionCompiler,
		enableRuntimeServices: options.enableRuntimeServices,
	})
	return {
		host: options.host,
		dispose: result.dispose,
	}
}
