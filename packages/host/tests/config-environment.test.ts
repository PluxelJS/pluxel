import { envBinding, fileBinding } from '../src/bindings'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { pluginNodeAddressOf } from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHostApplication, resolveHostApplication } from '../src/application'
import { createHost } from '../src/host'
import { createDocumentStorage } from './helpers/document-storage'
import { resolveInputBindings } from '../src/input-bindings'

const Config = v.object({
	enabled: v.optional(v.boolean(), false),
	limit: v.optional(v.number(), 1),
})
const Credentials = v.object({ credentials: v.object({ token: v.string(), expires: v.number() }) })
@Plugin()
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
			namespace: 'file-selected',
			config: { schema: Config, path: 'config.json' },
			vault: { schema: Credentials, paths: { credentials: 'secret.json' } },
		}
		const env = {
			plugin: Configured,
			namespace: 'env-selected',
			config: { schema: Config, mapping: { limit: 'LIMIT' } },
			vault: {
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
		file.namespace = 'file-changed'
		env.namespace = 'env-changed'
		env.config.mapping.limit = 'CHANGED_LIMIT'
		env.vault.mapping.credentials.token = 'CHANGED_TOKEN'
		const result = await resolving
		expect(result.baseSources[0]?.name).toBe('config.json')
		expect(result.base[0]?.config).toEqual({ limit: 4 })
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
	const owner = pluginNodeAddressOf(Configured)
	const application = defineHostApplication(() => ({
		plugins: [Configured],
		configRecords: { initial: [{ owner, config: { limit: 1 } }] },
		envBindings: [binding],
	}))
	const resolved = await resolveHostApplication(application, {
		...startup,
		env: { APP_ENABLED: 'true', APP_LIMIT: '12', PLUXEL_CONFIG: 'invalid and ignored' },
	})
	expect(resolved.configRecords?.initial).toEqual([{ owner, config: { limit: 1 } }])
	expect(resolved.configRecords?.overlays).toEqual([
		{
			owner,
			config: { enabled: true, limit: 12 },
			sources: [
				{ path: ['enabled'], kind: 'env', name: 'APP_ENABLED' },
				{ path: ['limit'], kind: 'env', name: 'APP_LIMIT' },
			],
		},
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
	expect(absent.configRecords?.overlays).toEqual([])
})

it('keeps env out of storage and reveals the saved value after env removal', async () => {
	const owner = pluginNodeAddressOf(Configured)
	const storage = createDocumentStorage()
	const application = defineHostApplication(() => ({
		plugins: [Configured],
		configRecords: { storage, initial: [{ owner, config: { limit: 2 } }] },
		envBindings: [binding],
	}))
	const firstApplication = await resolveHostApplication(application, startup)
	const first = await createHost({
		plugins: firstApplication.plugins,
		configRecords: firstApplication.configRecords,
	})
	await first.start()
	const patched = await first.config.patch(owner, { limit: 8 })
	expect(patched.ok).toBe(true)
	await first.close()
	const secondApplication = await resolveHostApplication(application, {
		...startup,
		env: { APP_LIMIT: '99' },
	})
	const second = await createHost({
		plugins: secondApplication.plugins,
		configRecords: secondApplication.configRecords,
	})
	await second.start()
	expect(requireConfigService(second.ctx).getRawConfig(owner).limit).toBe(99)
	const denied = await second.config.patch(owner, { limit: 99 })
	expect(denied.ok).toBe(false)
	const reset = await second.config.reset(owner)
	expect(reset.ok).toBe(false)
	await second.close()
	const thirdApplication = await resolveHostApplication(application, startup)
	const third = await createHost({
		plugins: thirdApplication.plugins,
		configRecords: thirdApplication.configRecords,
	})
	await third.start()
	try {
		expect(requireConfigService(third.ctx).getRawConfig(owner).limit).toBe(8)
	} finally {
		await third.close()
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
			owner: pluginNodeAddressOf(Configured),
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
		}).then(({ plugins, services, configRecords, vaultBindings }) =>
			createHost({ plugins, services, configRecords, vaultBindings }),
		),
	).rejects.toThrow(/host.vault-bindings/)
})

it('reads config base and whole Vault records from explicit JSON files', async () => {
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
		expect(result.configRecords?.initial?.[0]?.config).toEqual({ limit: 4 })
		expect(result.configRecords?.overlays?.[0]?.config).toEqual({ limit: 7 })
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
	expect(resolved.configRecords?.overlays?.map((record) => record.config)).toEqual([
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
		configRecords: resolved.configRecords,
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
		configRecords: resolved.configRecords,
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
