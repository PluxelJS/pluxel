import { defineGQLensEntry } from '@gqlens/vite/entry'

import '@pluxel/runtime-dynamic/register'
import { createInternalGraphQLSchemaSDL } from '@pluxel/runtime'

const unknownPluginSource: {
	__typename: 'PluginSourceInfo'
	kind: 'unknown'
	moduleId: string | null
	packageName: string | null
	version: string | null
	tag: string | null
} = {
	__typename: 'PluginSourceInfo',
	kind: 'unknown',
	moduleId: null,
	packageName: null,
	version: null,
	tag: null,
} as const

const schemaContext = {
	logger: console,
	configService: {
		getExtra(): unknown[] {
			return []
		},
		setExtra() {},
	},
	pluginCatalog: {
		require() {
			return class {}
		},
		resolve(target: unknown) {
			return typeof target === 'function' ? target : undefined
		},
		listDependencies(): unknown[] {
			return []
		},
		resolveSource() {
			return unknownPluginSource
		},
		readStatus() {
			return {
				isRunning: false,
				isEnabled: false,
				lifecycleStage: 'stopped',
				source: unknownPluginSource,
			}
		},
		statusOverview(): {
			statuses: unknown[]
			summary: { total: number; running: number; stopped: number; disabled: number }
		} {
			return {
				statuses: [],
				summary: { total: 0, running: 0, stopped: 0, disabled: 0 },
			}
		},
	},
}

export default defineGQLensEntry({
	schema: () => createInternalGraphQLSchemaSDL(schemaContext as never),
})
