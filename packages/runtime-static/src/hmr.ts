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
