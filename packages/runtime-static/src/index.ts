import { StaticRuntimeHostImpl } from './internal/host'
import type { StaticRuntimeDefinition, StaticRuntimeHost, StaticRuntimeHostOptions } from './types'

export type {
	StaticRuntimeCatalogEntry,
	StaticRuntimeCatalogSnapshot,
	StaticRuntimeDefinition,
	StaticRuntimeHmrController,
	StaticRuntimeHmrReport,
	StaticRuntimeHost,
	StaticRuntimeHostOptions,
	StaticRuntimePluginStatus,
	StaticRuntimeReportEntry,
	StaticRuntimeStartupReport,
} from './types'

export function defineStaticRuntime(definition: StaticRuntimeDefinition): StaticRuntimeDefinition {
	return definition
}

export async function createStaticRuntimeHost(
	definition: StaticRuntimeDefinition,
	options: StaticRuntimeHostOptions = {},
): Promise<StaticRuntimeHost> {
	const host = new StaticRuntimeHostImpl(definition, options)
	await host.prepare()
	return host
}
