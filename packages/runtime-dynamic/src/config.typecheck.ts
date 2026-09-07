import { defineDynamicRuntimeConfig } from './config.ts'
import type { PluginConstructor, PluginNodeAddress } from '@pluxel/core'
import type { PersistenceBackend } from '@pluxel/runtime'
import type { RuntimeCustomSinkInput } from '@pluxel/runtime/logger'

declare const owner: PluginNodeAddress
declare const backend: PersistenceBackend & { readonly backendExtension: true }
declare const plugin: PluginConstructor & { readonly constructorExtension: true }
declare const customSink: RuntimeCustomSinkInput['sink'] & { readonly sinkExtension: true }

defineDynamicRuntimeConfig({
	root: '/repo',
	storage: { persistenceDir: '.pluxel/persistence' },
	management: true,
	workbench: { enabled: true, uiBasePath: '/admin' },
})

// @ts-expect-error Dynamic config rejects the removed Workbench access option.
defineDynamicRuntimeConfig({
	root: '/repo',
	workbench: { enabled: true, access: { exposure: 'private' } },
})

// @ts-expect-error Dynamic config rejects the removed Workbench pluginGroups option.
defineDynamicRuntimeConfig({ root: '/repo', workbench: { enabled: true, pluginGroups: [] } })

// @ts-expect-error Dynamic config rejects unknown nested storage options.
defineDynamicRuntimeConfig({ root: '/repo', storage: { persistenceDir: '.pluxel', extra: true } })

// @ts-expect-error Dynamic config rejects unknown top-level options.
defineDynamicRuntimeConfig({ root: '/repo', unknownHostOption: true })

defineDynamicRuntimeConfig({
	configService: {
		environment: { CUSTOM_ENVIRONMENT_NAME: 'value' },
		snapshot: { plugins: [{ owner, config: { pluginOwnedField: { nested: true } } }] },
	},
})
defineDynamicRuntimeConfig({
	runtimeState: { snapshot: { autoStart: new Set<PluginNodeAddress>() } },
})
defineDynamicRuntimeConfig({ runtimeState: { snapshot: { autoStart: [owner] } } })

// @ts-expect-error Iterable implementations stay open while their yielded values stay exact.
defineDynamicRuntimeConfig({
	runtimeState: { snapshot: { autoStart: new Set([{ ...owner, unknown: true }]) } },
})

defineDynamicRuntimeConfig({ persistence: { mode: 'custom', backend } })
defineDynamicRuntimeConfig({ plugins: [plugin] })
defineDynamicRuntimeConfig({
	database: { driver: 'postgres', connectionString: 'postgres://localhost/db', pool: { max: 4 } },
})
defineDynamicRuntimeConfig({
	logging: {
		root: { profile: 'typecheck' },
		sinks: { custom: { kind: 'logtape', label: 'custom', sink: customSink, caller: false } },
		routes: {
			runtime: [{ sink: 'custom', minLevel: 'info' }],
			plugins: [],
			debug: [],
			meta: [],
		},
	},
})
defineDynamicRuntimeConfig({ workers: { maxThreads: 2 } })
defineDynamicRuntimeConfig({ vault: { flushDebounceMs: 25 } })
defineDynamicRuntimeConfig({
	logging: {
		root: { profile: 'typecheck' },
		sinks: {
			store: { kind: 'store', caller: false, caps: { maxMsgChars: 1_000 } },
		},
		routes: {
			runtime: [{ sink: 'store', minLevel: 'info' }],
			plugins: [],
			debug: [],
			meta: [],
		},
	},
})

// @ts-expect-error ConfigService config is closed while environment and Plugin raw config stay open.
defineDynamicRuntimeConfig({ configService: { mode: 'memory', unknown: true } })

// @ts-expect-error ConfigService snapshot records reject unknown structural fields.
defineDynamicRuntimeConfig({
	configService: { snapshot: { plugins: [{ owner, config: {}, unknown: true }] } },
})

// @ts-expect-error RuntimeState config rejects unknown fields.
defineDynamicRuntimeConfig({ runtimeState: { mode: 'memory', unknown: true } })

// @ts-expect-error RuntimeState snapshot entries reject unknown fields.
defineDynamicRuntimeConfig({
	runtimeState: {
		snapshot: { forks: [{ definition: owner.definition, forkIds: [], unknown: true }] },
	},
})

// @ts-expect-error Persistence union members reject unknown fields without closing custom backends.
defineDynamicRuntimeConfig({ persistence: { mode: 'custom', backend, unknown: true } })

// @ts-expect-error Database config rejects unknown fields.
defineDynamicRuntimeConfig({ database: { driver: 'pglite', unknown: true } })

// @ts-expect-error Nested PostgreSQL pool config rejects unknown fields.
defineDynamicRuntimeConfig({
	database: {
		driver: 'postgres',
		connectionString: 'postgres://localhost/db',
		pool: { unknown: true },
	},
})

// @ts-expect-error Worker service config rejects unknown fields.
defineDynamicRuntimeConfig({ workers: { maxThreads: 2, unknown: true } })

// @ts-expect-error Vault service config rejects unknown fields.
defineDynamicRuntimeConfig({ vault: { flushDebounceMs: 25, unknown: true } })

// @ts-expect-error Logging root config rejects unknown fields.
defineDynamicRuntimeConfig({
	logging: {
		root: { profile: 'typecheck', unknown: true },
		sinks: {},
		routes: { runtime: [], plugins: [], debug: [], meta: [] },
	},
})

// @ts-expect-error Logging sink caps reject unknown fields.
defineDynamicRuntimeConfig({
	logging: {
		root: { profile: 'typecheck' },
		sinks: { store: { kind: 'store', caller: false, caps: { unknown: true } } },
		routes: { runtime: [], plugins: [], debug: [], meta: [] },
	},
})

// @ts-expect-error Logging route bindings reject unknown fields.
defineDynamicRuntimeConfig({
	logging: {
		root: { profile: 'typecheck' },
		sinks: {},
		routes: {
			runtime: [{ sink: 'store', minLevel: 'info', unknown: true }],
			plugins: [],
			debug: [],
			meta: [],
		},
	},
})
