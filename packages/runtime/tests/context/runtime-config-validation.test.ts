import {
	assertRuntimeHostConfig,
	assertRuntimeLoggingInput,
} from '@pluxel/runtime/internal/config-validation'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { describe, expect, it } from 'vitest'

const owner = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/config-validation' },
		exportName: 'ConfigValidationPlugin',
	},
	variant: 'default',
} as const

const routes = {
	runtime: [],
	plugins: [],
	debug: [],
	meta: [],
}

describe('Runtime host configuration validation', () => {
	it.each([
		['host', { profile: 'legacy' }, 'profile'],
		['Core logger', { logger: { rootId: 'root', legacy: true } }, 'legacy'],
		['Core events', { events: { legacy: true } }, 'legacy'],
		['Core plugins', { plugins: { legacy: true } }, 'legacy'],
		['ConfigService', { configService: { legacy: true } }, 'legacy'],
		[
			'ConfigService snapshot',
			{ configService: { snapshot: { plugins: [], legacy: true } } },
			'legacy',
		],
		[
			'ConfigService record',
			{
				configService: {
					snapshot: { plugins: [{ owner, config: {}, legacy: true }] },
				},
			},
			'legacy',
		],
		['RuntimeState', { runtimeState: { legacy: true } }, 'legacy'],
		[
			'RuntimeState snapshot',
			{ runtimeState: { snapshot: { autoStart: [], legacy: true } } },
			'legacy',
		],
		[
			'RuntimeState fork',
			{
				runtimeState: {
					snapshot: { forks: [{ definition: owner.definition, forkIds: [], legacy: true }] },
				},
			},
			'legacy',
		],
		['persistence', { persistence: { mode: 'memory', legacy: true } }, 'legacy'],
		['database', { database: { driver: 'pglite', legacy: true } }, 'legacy'],
		[
			'database pool',
			{
				database: {
					driver: 'postgres',
					connectionString: 'postgres://localhost/db',
					pool: { legacy: true },
				},
			},
			'legacy',
		],
		['workers', { workers: { legacy: true } }, 'legacy'],
		['HTTP assets', { http: { legacy: true } }, 'legacy'],
		['Workbench', { workbench: { enabled: true, legacy: true } }, 'legacy'],
		['Vault', { vault: { legacy: true } }, 'legacy'],
	] as const)('rejects unknown %s fields', (_name, config, field) => {
		expect(() => assertRuntimeHostConfig(config)).toThrow(new RegExp(`unsupported .*${field}`, 'i'))
	})

	it('keeps explicit extension contracts open', () => {
		const backend = createMemoryPersistenceBackend()
		expect(() =>
			assertRuntimeHostConfig({
				configService: {
					environment: { HOST_DEFINED_NAME: 'value' },
					snapshot: {
						plugins: [{ owner, config: { pluginOwned: { nested: true } } }],
					},
				},
				runtimeState: { snapshot: { autoStart: new Set([owner]) } },
				persistence: {
					mode: 'custom',
					backend: {
						...backend,
						backendOwnedExtension: true,
					},
				},
			}),
		).not.toThrow()
	})
})

describe('Runtime logging configuration validation', () => {
	it.each([
		['root', { root: { profile: 'test', legacy: true }, sinks: {}, routes }, 'legacy'],
		[
			'initial policy',
			{
				root: {
					profile: 'test',
					initialPluginPolicy: {
						version: 3,
						defaultLevel: 'info',
						overrides: [],
						legacy: true,
					},
				},
				sinks: {},
				routes,
			},
			'legacy',
		],
		[
			'policy override',
			{
				root: {
					profile: 'test',
					initialPluginPolicy: {
						version: 3,
						defaultLevel: 'info',
						overrides: [{ owner, level: 'debug', legacy: true }],
					},
				},
				sinks: {},
				routes,
			},
			'legacy',
		],
		[
			'sink',
			{
				root: { profile: 'test' },
				sinks: {
					console: {
						kind: 'console',
						format: 'text',
						caller: false,
						timezone: 'utc',
						legacy: true,
					},
				},
				routes,
			},
			'legacy',
		],
		[
			'sink caps',
			{
				root: { profile: 'test' },
				sinks: {
					store: { kind: 'store', caller: false, caps: { legacy: true } },
				},
				routes,
			},
			'legacy',
		],
		[
			'routes',
			{
				root: { profile: 'test' },
				sinks: {},
				routes: { ...routes, legacy: [] },
			},
			'legacy',
		],
		[
			'route binding',
			{
				root: { profile: 'test' },
				sinks: {},
				routes: {
					...routes,
					runtime: [{ sink: 'console', minLevel: 'info', legacy: true }],
				},
			},
			'legacy',
		],
	] as const)('rejects unknown %s fields', (_name, config, field) => {
		expect(() => assertRuntimeLoggingInput(config)).toThrow(
			new RegExp(`unsupported .*${field}`, 'i'),
		)
	})

	it('accepts dynamic sink ids and custom sink implementations', () => {
		expect(() =>
			assertRuntimeLoggingInput({
				root: { profile: 'test' },
				sinks: {
					hostDefinedSink: {
						kind: 'logtape',
						label: 'host-defined',
						sink: () => undefined,
						caller: false,
					},
				},
				routes,
			}),
		).not.toThrow()
	})
})
