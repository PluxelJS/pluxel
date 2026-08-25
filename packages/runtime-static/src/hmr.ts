import type { StaticRuntimeDefinition, StaticRuntimeHmrReport, StaticRuntimeHost } from './index'

export type ReloadStaticRuntimeOptions = {
	host: StaticRuntimeHost
	definition: StaticRuntimeDefinition
}

/**
 * Apply a static runtime definition update to an already-running static host.
 *
 * The caller owns how the definition was imported (for example Vite SSR import).
 * This function compares the fixed catalog by lowered Plugin node address, revalidates
 * enabled plugins through the host config service, and delegates lifecycle changes to core commit.
 * Concurrent reloads are committed serially in call order.
 */
export function reloadStaticRuntime(
	options: ReloadStaticRuntimeOptions,
): Promise<StaticRuntimeHmrReport> {
	return options.host.hmr.reload(options.definition)
}
