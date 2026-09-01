import { defineStaticRuntime } from './application.ts'
import type { StaticRuntimeApplication, StaticRuntimeStartupContext } from './types.ts'

defineStaticRuntime({
	name: 'exact-host-options',
	plugins: [],
	configure: () => ({
		management: true,
		workbench: { enabled: true, uiBasePath: '/admin' },
	}),
})

// @ts-expect-error configure() rejects the removed Workbench access option.
defineStaticRuntime({
	name: 'unknown-workbench-access',
	plugins: [],
	configure: () => ({ workbench: { enabled: true, access: { exposure: 'private' } } }),
})

// @ts-expect-error configure() rejects the removed Workbench pluginGroups option.
defineStaticRuntime({
	name: 'unknown-workbench-plugin-groups',
	plugins: [],
	configure: () => ({ workbench: { enabled: true, pluginGroups: [] } }),
})

// @ts-expect-error configure() rejects unknown top-level host options.
defineStaticRuntime({
	name: 'unknown-host-option',
	plugins: [],
	configure: async () => ({ workbench: false, unknownHostOption: true }),
})

const applicationWithBindings = defineStaticRuntime({
	name: 'typed-bindings',
	plugins: [],
	configure({ bindings }: StaticRuntimeStartupContext<{ serviceUrl: string }>) {
		return { profile: bindings.serviceUrl }
	},
})

const typedApplication: StaticRuntimeApplication<readonly [], { serviceUrl: string }> =
	applicationWithBindings
void typedApplication

defineStaticRuntime<readonly [], { serviceUrl: string }>({
	name: 'explicit-bindings-type-arguments',
	plugins: [],
	configure: ({ bindings }) => ({ profile: bindings.serviceUrl }),
})

defineStaticRuntime<readonly []>({
	name: 'explicit-plugin-type-argument',
	plugins: [],
	configure: () => ({ profile: 'typecheck' }),
})

defineStaticRuntime({
	name: 'valid-logging-options',
	plugins: [],
	configure: () => ({
		logging: {
			root: { profile: 'typecheck' },
			sinks: {
				console: { kind: 'console', format: 'text', caller: false, timezone: 'utc' },
			},
			routes: {
				runtime: [{ sink: 'console', minLevel: 'info' }],
				plugins: [],
				debug: [],
				meta: [],
			},
		},
	}),
})

// @ts-expect-error configure() recursively rejects unknown service configuration fields.
defineStaticRuntime({
	name: 'unknown-database-pool-option',
	plugins: [],
	configure: () => ({
		database: {
			driver: 'postgres',
			connectionString: 'postgres://localhost/db',
			pool: { max: 4, unknown: true },
		},
	}),
})

// @ts-expect-error configure() recursively rejects unknown logging configuration fields.
defineStaticRuntime({
	name: 'unknown-logging-route-option',
	plugins: [],
	configure: () => ({
		logging: {
			root: { profile: 'typecheck' },
			sinks: {},
			routes: {
				runtime: [{ sink: 'console', minLevel: 'info', unknown: true }],
				plugins: [],
				debug: [],
				meta: [],
			},
		},
	}),
})
