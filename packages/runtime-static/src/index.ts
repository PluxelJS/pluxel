import { setPluxelRuntime } from '@pluxel/core'

setPluxelRuntime('core')

export {
	BaseFeature,
	BasePlugin,
	cfg,
	Config,
	Context,
	defineLazyFeature,
	f,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	v,
	type ConfigSchemaMap,
} from '@pluxel/runtime'

export type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeCatalogEntry,
	StaticRuntimeCatalogSnapshot,
	StaticRuntimeContextConfig,
	StaticRuntimeDeployment,
	StaticRuntimeDefinition,
	StaticRuntimeEnvironment,
	StaticRuntimeHmrReport,
	StaticRuntimeHost,
	StaticRuntimeHostOptions,
	StaticRuntimePluginStatus,
	StaticRuntimeReportEntry,
	StaticRuntimeStartupContext,
	StaticRuntimeStartupReport,
} from './types'
export { defineStaticRuntime } from './application'
