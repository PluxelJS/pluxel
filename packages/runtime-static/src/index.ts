import '@pluxel/runtime/register/static'
import { setPluxelRuntime } from '@pluxel/core'

import { createStaticRuntimeHost } from './internal/host'
import type { StaticRuntime, StaticRuntimeConfig, StaticRuntimeDefinition } from './types'

setPluxelRuntime('core')

export {
	BaseFeature,
	BasePlugin,
	cfg,
	Config,
	Context,
	defineOptionalFeature,
	f,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	pluginMethodDecorator,
	v,
	type ConfigSchemaMap,
} from '@pluxel/runtime'

export type {
	StaticRuntime,
	StaticRuntimeCatalogEntry,
	StaticRuntimeCatalogSnapshot,
	StaticRuntimeConfig,
	StaticRuntimeDefinition,
	StaticRuntimePluginStatus,
	StaticRuntimeRegisteredServices,
	StaticRuntimeReportEntry,
	StaticRuntimeStartupReport,
} from './types'
export { defineStaticRuntimeConfig } from './config'

export async function createStaticRuntime(config: StaticRuntimeConfig): Promise<StaticRuntime> {
	const host = await createStaticRuntimeHost(toStaticRuntimeDefinition(config), {
		configService: config.configService,
		runtimeState: config.runtimeState,
		persistence: config.persistence,
		pluginData: config.pluginData,
		http: config.http,
		management: config.management,
		logger: config.logger,
		profile: config.profile,
		context: config.context,
	})
	await host.start()

	return {
		ctx: host.ctx,
		fetch: (request, env, ctx) => host.ctx.http.fetch(request, env, ctx),
		start: () => host.start(),
		stop: () => host.stop(),
	}
}

function toStaticRuntimeDefinition(config: StaticRuntimeDefinition): StaticRuntimeDefinition {
	return {
		name: config.name,
		plugins: config.plugins,
	}
}
