import { envBinding, fileBinding } from '../src/bindings'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHostApplication, resolveHostApplication } from '../src/application'
import { createHost } from '../src/host'
import { configProvenance } from '../src/config-records'
import { resolveInputBindings } from '../src/input-bindings'

const Config = v.object({
	enabled: v.optional(v.boolean(), false),
	limit: v.optional(v.number(), 1),
})
const Credentials = v.object({ credentials: v.object({ token: v.string(), expires: v.number() }) })
@Plugin({ forkable: true })
export class Configured extends BasePlugin {
	readonly config = this.configs.use(Config)
}
const startup = { root: process.cwd(), mode: 'test' as const, bindings: {}, env: {} }
const binding = envBinding(Configured, {
	config: { schema: Config, mapping: { enabled: 'APP_ENABLED', limit: 'APP_LIMIT' } },
})

it('captures binding paths, namespaces and mappings before the first file read', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-binding-snapshot-'))
	try {
		await writeFile(join(root, 'config.json'), JSON.stringify({ limit: 4 }))
		await writeFile(join(root, 'secret.json'), JSON.stringify({ token: 'file-token', expires: 42 }))
		const file = {
			plugin: Configured,
			config: { schema: Config, path: 'config.json' },
			vault: {
				namespace: 'file-selected',
				schema: Credentials,
				paths: { credentials: 'secret.json' },
			},
		}
		const env = {
			plugin: Configured,
			config: { schema: Config, mapping: { limit: 'LIMIT' } },
			vault: {
				namespace: 'env-selected',
				schema: Credentials,
				mapping: { credentials: { token: 'TOKEN', expires: 'EXPIRY' } },
			},
		}
		const resolving = resolveInputBindings(
			{ plugins: [Configured], fileBindings: [file], envBindings: [env] },
			{ ...startup, root, env: { LIMIT: '7', TOKEN: 'env-token', EXPIRY: '12' } },
		)
		file.config.path = 'missing-config.json'
		file.vault.paths.credentials = 'missing-secret.json'
		file.vault.namespace = 'file-changed'
		env.vault.namespace = 'env-changed'
		env.config.mapping.limit = 'CHANGED_LIMIT'
		env.vault.mapping.credentials.token = 'CHANGED_TOKEN'
		const result = await resolving
		expect(result.declarationSources[0]?.name).toBe('config.json')
		expect(result.records[0]?.config).toEqual({ limit: 4 })
		expect(result.overlays[0]?.config).toEqual({ limit: 7 })
		expect(result.vaultBindings).toMatchObject([
			{ namespace: 'file-selected', value: { token: 'file-token', expires: 42 } },
			{ namespace: 'env-selected', value: { token: 'env-token', expires: 12 } },
		])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('decodes explicit config inputs as overlays without ambient PLUXEL_CONFIG or seed mutation', async () => {
	const owner = Configured.nodeAddress()
	const application = defineHostApplication(() => ({
		plugins: [Configured],
		envBindings: [binding],
		config: { records: [{ owner, config: { limit: 1 } }] },
	}))
	const resolved = await resolveHostApplication(application, {
		...startup,
		env: { APP_ENABLED: 'true', APP_LIMIT: '12', PLUXEL_CONFIG: 'invalid and ignored' },
	})
	expect(resolved.config?.records).toEqual([{ owner, config: { enabled: true, limit: 12 } }])
	expect(configProvenance(resolved.config!).sources).toEqual([
		{ owner, path: ['enabled'], kind: 'env', name: 'APP_ENABLED' },
		{ owner, path: ['limit'], kind: 'env', name: 'APP_LIMIT' },
	])
	await expect(
		resolveHostApplication(application, {
			...startup,
			env: { APP_LIMIT: 'private-invalid-value' },
		}),
	).rejects.toThrow('APP_LIMIT')
	const error = await resolveHostApplication(application, {
		...startup,
		env: { APP_LIMIT: 'private-invalid-value' },
	}).catch((failure: unknown) => failure)
	expect(String(error)).not.toContain('private-invalid-value')
	const absent = await resolveHostApplication(application, startup)
	expect(configProvenance(absent.config!).sources).toEqual([])
})

it('passes resolved environment values and source provenance into Host', async () => {
	const owner = Configured.nodeAddress()
	const application = defineHostApplication(() => ({
		plugins: [Configured],
		envBindings: [binding],
		config: { records: [{ owner, config: { limit: 2 } }] },
	}))
	const resolved = await resolveHostApplication(application, {
		...startup,
		env: { APP_LIMIT: '99' },
	})
	const host = await createHost({
		plugins: resolved.plugins,
		runtime: resolved.runtime,
		config: resolved.config,
	})
	try {
		await host.startNode(owner)
		const result = await host.config.get(owner)
		expect(result).toMatchObject({ ok: true, application: 'applied', config: { limit: 99 } })
		if (result.ok === false) throw new Error(result.message)
		expect(result.sources).toContainEqual({
			owner,
			path: ['limit'],
			kind: 'env',
			name: 'APP_LIMIT',
			readonly: false,
		})
	} finally {
		await host.close()
	}
})

it('validates a complete Vault record, rejects partial deployment inputs, and redacts values', async () => {
	const application = defineHostApplication(() => ({
		plugins: [Configured],
		envBindings: [
			envBinding(Configured, {
				vault: {
					schema: Credentials,
					mapping: { credentials: { token: 'TOKEN', expires: 'EXPIRY' } },
				},
			}),
		],
	}))
	const resolved = await resolveHostApplication(application, {
		...startup,
		env: { TOKEN: 'secret', EXPIRY: '12' },
	})
	expect(resolved.vaultBindings).toEqual([
		{
			owner: Configured.nodeAddress(),
			key: 'credentials',
			namespace: undefined,
			source: 'env',
			value: { token: 'secret', expires: 12 },
		},
	])
	await expect(
		resolveHostApplication(application, { ...startup, env: { TOKEN: 'secret' } }),
	).rejects.toMatchObject({ code: 'MISSING_INPUT' })
	await expect(
		resolveHostApplication(application, {
			...startup,
			env: { TOKEN: 'secret', EXPIRY: '12' },
		}).then(({ plugins, services, runtime, vaultBindings }) =>
			createHost({
				plugins,
				services,
				vaultBindings,
				runtime,
			}),
		),
	).rejects.toThrow(/host.vault-bindings/)
})

it('reads config declarations and whole Vault records from explicit JSON files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-bindings-'))
	try {
		await writeFile(join(root, 'config.json'), JSON.stringify({ limit: 4 }))
		await writeFile(join(root, 'secret.json'), JSON.stringify({ token: 'private', expires: 42 }))
		const result = await resolveHostApplication(
			() => ({
				plugins: [Configured],
				fileBindings: [
					fileBinding(Configured, {
						config: { schema: Config, path: 'config.json' },
						vault: { schema: Credentials, paths: { credentials: 'secret.json' } },
					}),
				],
				envBindings: [binding],
			}),
			{ ...startup, root, env: { APP_LIMIT: '7' } },
		)
		expect(result.config?.records?.[0]?.config).toEqual({ limit: 7 })
		expect(configProvenance(result.config!).sources.map((source) => source.kind)).toEqual(['env'])
		expect(result.vaultBindings?.[0]).toMatchObject({
			source: 'file',
			value: { token: 'private', expires: 42 },
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

const OtherConfig = v.object({ title: v.string() })
@Plugin()
class OtherConfigured extends BasePlugin {
	readonly config = this.configs.use(OtherConfig)
}

it('infers heterogeneous async binding arrays without const assertions', async () => {
	const application = defineHostApplication(async () => ({
		plugins: [Configured, OtherConfigured],
		envBindings: [
			envBinding(Configured, { config: { schema: Config, mapping: { enabled: 'ENABLED' } } }),
			envBinding(OtherConfigured, { config: { schema: OtherConfig, mapping: { title: 'TITLE' } } }),
			envBinding(Configured, {
				vault: { schema: Credentials, mapping: { credentials: 'CREDENTIALS' } },
			}),
		],
	}))
	const resolved = await resolveHostApplication(application, {
		...startup,
		env: {
			ENABLED: 'true',
			TITLE: 'example',
			CREDENTIALS: JSON.stringify({ token: 'test', expires: 12 }),
		},
	})
	expect(resolved.config?.records?.map((record) => record.config)).toEqual([
		{ enabled: true },
		{ title: 'example' },
	])
})

it('keeps the Host Vault contract across plugin replacement without repeating transforms', async () => {
	const { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } = await import('@pluxel/test/unsafe')
	const { defineHostService } = await import('../src/services')
	const { installRootCapability } = await import('@pluxel/core/host')
	const { HostVaultBindings } = await import('../src/bindings')
	let validations = 0
	const tokenSchema = v.pipe(
		v.object({ token: v.string() }),
		v.transform((value) => {
			validations++
			return { token: `normalized:${value.token}` }
		}),
	)
	@Plugin()
	class Bound extends BasePlugin {}
	@Plugin()
	class Replacement extends BasePlugin {}
	for (const plugin of [Bound, Replacement])
		__setPluginDefinition(plugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'test', path: 'bound.ts' },
				exportName: 'Bound',
			},
		})
	let installed: unknown
	const service = defineHostService({
		name: 'TestBindings',
		capabilities: [
			installRootCapability(HostVaultBindings, {
				create: () => ({
					install(records) {
						installed = records
					},
				}),
			}),
		],
	})
	const resolved = await resolveHostApplication(
		defineHostApplication(() => ({
			plugins: [Bound],
			services: [service],
			envBindings: [
				envBinding(Bound, {
					vault: {
						schema: v.object({ credentials: tokenSchema }),
						mapping: { credentials: { token: 'TOKEN' } },
					},
				}),
			],
		})),
		{ ...startup, env: { TOKEN: 'one' } },
	)
	const host = await createHost({
		plugins: resolved.plugins,
		services: resolved.services,
		vaultBindings: resolved.vaultBindings,
		runtime: resolved.runtime,
		config: resolved.config,
	})
	await host.start()
	try {
		expect(validations).toBe(1)
		expect(installed).toEqual([expect.objectContaining({ value: { token: 'normalized:one' } })])
		await host.updateCatalog([Replacement])
		expect(validations).toBe(1)
	} finally {
		await host.close()
	}
})

it('requires the same config schema value even when another schema has the same shape', async () => {
	const unrelated = v.object({
		enabled: v.optional(v.boolean(), false),
		limit: v.optional(v.number(), 1),
	})
	await expect(
		resolveHostApplication(
			() => ({
				plugins: [Configured],
				envBindings: [
					envBinding(Configured, {
						config: { schema: unrelated, mapping: { enabled: 'ENABLED' } },
					}),
				],
			}),
			startup,
		),
	).rejects.toThrow('same schema as configs.use()')
})

it('validates Vault root record keys and redacts rejected values', async () => {
	const schema = v.record(
		v.pipe(v.string(), v.regex(/^account-[a-z]+$/)),
		v.object({ token: v.string() }),
	)
	await expect(
		resolveHostApplication(
			() => ({
				plugins: [Configured],
				envBindings: [
					envBinding(Configured, {
						vault: { schema, mapping: { invalid: { token: 'TOKEN' } } },
					}),
				],
			}),
			{ ...startup, env: { TOKEN: 'private-value' } },
		),
	).rejects.toMatchObject({ code: 'INVALID_INPUT' })
	const valid = await resolveHostApplication(
		() => ({
			plugins: [Configured],
			envBindings: [
				envBinding(Configured, {
					vault: { schema, mapping: { 'account-main': { token: 'TOKEN' } } },
				}),
			],
		}),
		{ ...startup, env: { TOKEN: 'private-value' } },
	)
	expect(valid.vaultBindings?.[0]?.key).toBe('account-main')
})

const OriginalConfig = v.object({ enabled: v.optional(v.boolean(), false) })
const ReplacementConfig = v.object({ removed: v.optional(v.boolean(), false) })
it('checks environment paths against replacement config metadata without another static schema', async () => {
	const { __setPluginDefinition, __setPluginConfig, PLUGIN_LOWERING_ABI_VERSION } =
		await import('@pluxel/test/unsafe')
	@Plugin()
	class BeforeConfigReplacement extends BasePlugin {}
	@Plugin()
	class AfterConfigReplacement extends BasePlugin {}
	for (const [plugin, schema] of [
		[BeforeConfigReplacement, OriginalConfig],
		[AfterConfigReplacement, ReplacementConfig],
	] as const) {
		__setPluginConfig(plugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			fieldName: 'settings',
			schema,
		})
		__setPluginDefinition(plugin, {
			abiVersion: PLUGIN_LOWERING_ABI_VERSION,
			kind: 'plugin',
			definition: {
				entry: { kind: 'source-entry', sourceSpace: 'test', path: 'config-bound.ts' },
				exportName: 'Bound',
			},
		})
	}
	const resolved = await resolveHostApplication(
		defineHostApplication(() => ({
			plugins: [BeforeConfigReplacement],
			envBindings: [
				envBinding(BeforeConfigReplacement, {
					config: { schema: OriginalConfig, mapping: { enabled: 'ENABLED' } },
				}),
			],
		})),
		{ ...startup, env: { ENABLED: 'true' } },
	)
	const host = await createHost({
		plugins: resolved.plugins,
		runtime: resolved.runtime,
		config: resolved.config,
	})
	await host.start()
	try {
		await expect(host.updateCatalog([AfterConfigReplacement])).rejects.toMatchObject({
			code: 'INVALID_BINDING',
		})
	} finally {
		await host.close()
	}
})

it.each(['environment', 'file'] as const)(
	'rejects empty Vault %s descriptors rather than silently omitting their target',
	async (kind) => {
		const application = defineHostApplication(() => ({
			plugins: [Configured],
			...(kind === 'environment'
				? { envBindings: [envBinding(Configured, { vault: { schema: Credentials, mapping: {} } })] }
				: {
						fileBindings: [fileBinding(Configured, { vault: { schema: Credentials, paths: {} } })],
					}),
		}))
		await expect(resolveHostApplication(application, startup)).rejects.toMatchObject({
			code: 'INVALID_BINDING',
			message: expect.stringContaining('at least one record'),
		})
	},
)

it('combines disjoint mappings for one node, rejects overlap, and checks canonical fork schema identity', async () => {
	const target = Configured.nodeAddress('east')
	const forkBindings = [
		envBinding(target, { config: { schema: Config, mapping: { enabled: 'ENABLED' } } }),
		envBinding(target, { config: { schema: Config, mapping: { limit: 'LIMIT' } } }),
	]
	const result = await resolveHostApplication(
		() => ({
			plugins: [Configured],
			envBindings: forkBindings,
			config: { mode: 'declared-only', records: [{ owner: target, mode: 'saved-first' }] },
		}),
		{ ...startup, env: { ENABLED: 'true', LIMIT: '7' } },
	)
	expect(result.config?.records).toEqual([
		{ owner: target, mode: 'saved-first', config: { enabled: true, limit: 7 } },
	])
	await expect(
		resolveHostApplication(
			() => ({
				plugins: [Configured],
				envBindings: [
					...forkBindings,
					envBinding(target, { config: { schema: Config, mapping: { limit: 'OTHER' } } }),
				],
			}),
			startup,
		),
	).rejects.toThrow('overlapping')
	await expect(
		resolveHostApplication(
			() => ({
				plugins: [Configured],
				envBindings: [
					envBinding(target, {
						config: { schema: v.object({ enabled: v.boolean() }), mapping: { enabled: 'ENABLED' } },
					}),
				],
			}),
			startup,
		),
	).rejects.toThrow('same schema')
})

const NestedConfig = v.object({ nested: v.object({ value: v.number() }) })
@Plugin()
class NestedConfigured extends BasePlugin {
	readonly config = this.configs.use(NestedConfig)
}
it('attributes empty-object deployment patches only to paths they actually supply', async () => {
	const result = await resolveHostApplication(
		() => ({
			plugins: [NestedConfigured],
			config: { records: [{ owner: NestedConfigured, config: { nested: { value: 4 } } }] },
			envBindings: [
				envBinding(NestedConfigured, { config: { schema: NestedConfig, mapping: 'CONFIG' } }),
			],
		}),
		{ ...startup, env: { CONFIG: '{"nested":{}}' } },
	)
	const host = await createHost({
		plugins: result.plugins,
		config: result.config,
		runtime: { documents: { config: false, state: false } },
	})
	try {
		const snapshot = await host.config.get(NestedConfigured.nodeAddress())
		expect(snapshot).toMatchObject({
			ok: true,
			effectiveInput: { nested: { value: 4 } },
			sources: [{ path: ['nested', 'value'], kind: 'declaration' }],
		})
	} finally {
		await host.close()
	}
})
