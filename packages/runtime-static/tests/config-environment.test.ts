import { access } from 'node:fs/promises'

import { pluginNodeAddressOf, type PluginConstructor, type PluginNodeAddress } from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import { BasePlugin, Plugin, v } from '@pluxel/runtime'
import { requireRuntimePluginGraphCoordinator } from '@pluxel/runtime/internal'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { describe, expect, it } from 'vitest'

import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'

import { resolveStaticRuntimeHostOptions } from '../src/application'
import { resolveConfigEnvironmentBootstrap } from '../src/config-environment'

const EnvironmentConfig = v.object({
	text: v.optional(v.string(), 'schema-default'),
	count: v.optional(v.pipe(v.number(), v.integer()), 5),
	enabled: v.optional(v.boolean(), true),
	nullable: v.optional(v.nullable(v.string()), 'nullable-default'),
	nested: v.object({
		left: v.optional(v.string(), 'left-default'),
		right: v.optional(v.string(), 'right-default'),
	}),
	subtree: v.optional(
		v.object({
			label: v.string(),
			items: v.optional(v.array(v.string()), []),
		}),
		{ label: 'subtree-default', items: [] },
	),
})

type EnvironmentOutput = v.InferOutput<typeof EnvironmentConfig>
let environmentOutput: EnvironmentOutput | undefined

@Plugin({ displayName: 'Environment owner' })
class EnvironmentPlugin extends BasePlugin {
	private readonly arbitrarilyNamedSettings = this.configs.use(EnvironmentConfig)

	override init(): void {
		environmentOutput = this.arbitrarilyNamedSettings
	}
}

const RootConfig = v.object({
	name: v.string(),
	nested: v.object({ value: v.number() }),
})

type RootOutput = v.InferOutput<typeof RootConfig>
let rootOutput: RootOutput | undefined

@Plugin({ displayName: 'Root environment owner' })
class RootPlugin extends BasePlugin {
	private readonly privateConfig = this.configs.use(RootConfig)

	override init(): void {
		rootOutput = this.privateConfig
	}
}

const FanoutConfig = v.object({ url: v.string() })
let fanoutUrl: string | undefined

@Plugin({ displayName: 'Fanout owner' })
class FanoutPlugin extends BasePlugin {
	private readonly settings = this.configs.use(FanoutConfig)

	override init(): void {
		fanoutUrl = this.settings.url
	}
}

const NumberConfig = v.object({ value: v.number() })

@Plugin({ displayName: 'Number owner' })
class NumberPlugin extends BasePlugin {
	private readonly settings = this.configs.use(NumberConfig)
}

const UnsupportedConfig = v.object({ value: v.unknown() })

@Plugin({ displayName: 'Unsupported owner' })
class UnsupportedPlugin extends BasePlugin {
	private readonly settings = this.configs.use(UnsupportedConfig)
}

const TransformConfig = v.pipe(
	v.object({ amount: v.number() }),
	v.transform(({ amount }) => ({ doubled: amount * 2 })),
)
let transformedOutput: v.InferOutput<typeof TransformConfig> | undefined

@Plugin({ displayName: 'Transform owner' })
class TransformPlugin extends BasePlugin {
	private readonly settings = this.configs.use(TransformConfig)

	override init(): void {
		transformedOutput = this.settings
	}
}

const SameShapeWrongSchema = v.object({
	text: v.optional(v.string(), 'schema-default'),
	count: v.optional(v.pipe(v.number(), v.integer()), 5),
	enabled: v.optional(v.boolean(), true),
	nullable: v.optional(v.nullable(v.string()), 'nullable-default'),
	nested: v.object({
		left: v.optional(v.string(), 'left-default'),
		right: v.optional(v.string(), 'right-default'),
	}),
	subtree: v.optional(v.object({ label: v.string(), items: v.optional(v.array(v.string()), []) }), {
		label: 'subtree-default',
		items: [],
	}),
})

const ownerOf = (plugin: PluginConstructor): PluginNodeAddress => pluginNodeAddressOf(plugin)

const startup = (env: Readonly<Record<string, string | undefined>> = {}) => ({
	mode: 'test' as const,
	env,
	bindings: {},
})

const snapshotEnvironment = (owner: PluginNodeAddress, config: Readonly<Record<string, unknown>>) =>
	JSON.stringify({ version: 3, plugins: [{ owner, config }] })

describe('static config environment bootstrap', () => {
	it('creates opaque immutable bindings and rejects empty, non-portable, and reserved names', () => {
		const mapping = { nested: { left: 'APP_LEFT' } }
		const binding = bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, mapping)

		expect(Object.isFrozen(binding)).toBe(true)
		expect(Object.keys(binding)).toEqual([])
		mapping.nested.left = 'APP_CHANGED_AFTER_BIND'
		expect(
			resolveConfigEnvironmentBootstrap(
				defineStaticRuntime({
					name: 'immutable-binding',
					plugins: [EnvironmentPlugin],
					configEnvironmentBootstrap: [binding],
				}),
				{ APP_LEFT: 'kept' },
			),
		).toEqual([
			expect.objectContaining({
				owner: ownerOf(EnvironmentPlugin),
				config: { nested: { left: 'kept' } },
			}),
		])

		expect(() => bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {})).toThrow(
			/must contain at least one binding/i,
		)
		expect(() =>
			bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, { text: 'lower_case' }),
		).toThrow(/must match \[A-Z_\]/i)
		expect(() =>
			bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, { text: 'PLUXEL_PRIVATE' }),
		).toThrow(/reserved/i)
	})

	it('requires the catalog implementation, exact schema identity, and one binding per Plugin', async () => {
		const binding = bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
			text: 'APP_TEXT',
		})

		await expect(
			resolveStaticRuntimeHostOptions(
				defineStaticRuntime({
					name: 'outside-catalog',
					plugins: [],
					configEnvironmentBootstrap: [binding],
				}),
				startup(),
			),
		).rejects.toThrow(/outside the static application catalog/i)

		await expect(
			resolveStaticRuntimeHostOptions(
				defineStaticRuntime({
					name: 'wrong-schema',
					plugins: [EnvironmentPlugin],
					configEnvironmentBootstrap: [
						bindConfigEnvironment(EnvironmentPlugin, SameShapeWrongSchema, {
							text: 'APP_TEXT',
						}),
					],
				}),
				startup(),
			),
		).rejects.toThrow(/schema does not match/i)

		await expect(
			resolveStaticRuntimeHostOptions(
				defineStaticRuntime({
					name: 'duplicate-owner',
					plugins: [EnvironmentPlugin],
					configEnvironmentBootstrap: [binding, binding],
				}),
				startup(),
			),
		).rejects.toThrow(/duplicate config environment binding/i)
	})

	it('targets the canonical default owner and validates root, subtree, nested, and fan-out values', async () => {
		environmentOutput = undefined
		rootOutput = undefined
		fanoutUrl = undefined
		const environmentOwner = ownerOf(EnvironmentPlugin)
		const rootOwner = ownerOf(RootPlugin)
		const fanoutOwner = ownerOf(FanoutPlugin)
		const application = defineStaticRuntime({
			name: 'compound-bindings',
			plugins: [EnvironmentPlugin, RootPlugin, FanoutPlugin],
			configEnvironmentBootstrap: [
				bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
					text: 'APP_SHARED_TEXT',
					nullable: 'APP_NULLABLE',
					nested: { left: 'APP_LEFT' },
					subtree: 'APP_SUBTREE',
				}),
				bindConfigEnvironment(RootPlugin, RootConfig, 'APP_ROOT'),
				bindConfigEnvironment(FanoutPlugin, FanoutConfig, { url: 'APP_SHARED_TEXT' }),
			],
			configure: () => ({
				configService: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: [environmentOwner, rootOwner, fanoutOwner] },
				},
			}),
		})
		const runtime = await createStaticRuntimeTestHost(application, {
			env: {
				APP_SHARED_TEXT: 'https://service.example.test',
				APP_NULLABLE: 'null',
				APP_LEFT: 'nested-left',
				APP_SUBTREE: JSON.stringify({ label: 'from-subtree', items: ['a', 'b'] }),
				APP_ROOT: JSON.stringify({ name: 'root', nested: { value: 42 } }),
			},
		})
		try {
			expect(environmentOutput).toEqual({
				text: 'https://service.example.test',
				count: 5,
				enabled: true,
				nullable: null,
				nested: { left: 'nested-left', right: 'right-default' },
				subtree: { label: 'from-subtree', items: ['a', 'b'] },
			})
			expect(rootOutput).toEqual({ name: 'root', nested: { value: 42 } })
			expect(fanoutUrl).toBe('https://service.example.test')
			const records = requireConfigService(runtime.ctx).getConfigSnapshot().plugins
			expect(records.map((record) => record.owner.variant)).toEqual([
				'default',
				'default',
				'default',
			])
		} finally {
			await runtime.stop()
		}
		expect(() => resolveConfigEnvironmentBootstrap(application, { APP_ROOT: '[]' })).toThrow(
			/must decode to a plain object/i,
		)
	})

	it('passes present raw input through the Plugin schema transform before injection', async () => {
		transformedOutput = undefined
		const owner = ownerOf(TransformPlugin)
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'schema-transform',
				plugins: [TransformPlugin],
				configEnvironmentBootstrap: [
					bindConfigEnvironment(TransformPlugin, TransformConfig, { amount: 'APP_AMOUNT' }),
				],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [owner] } },
				}),
			}),
			{ env: { APP_AMOUNT: '21' } },
		)
		try {
			expect(transformedOutput).toEqual({ doubled: 42 })
		} finally {
			await runtime.stop()
		}
	})

	it('fails closed on conflicting or unsupported derived transports before reading values', async () => {
		await expect(
			resolveStaticRuntimeHostOptions(
				defineStaticRuntime({
					name: 'transport-conflict',
					plugins: [EnvironmentPlugin, NumberPlugin],
					configEnvironmentBootstrap: [
						bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
							text: 'APP_SHARED',
						}),
						bindConfigEnvironment(NumberPlugin, NumberConfig, { value: 'APP_SHARED' }),
					],
				}),
				startup(),
			),
		).rejects.toThrow(/conflicting derived transports string and number/i)

		await expect(
			resolveStaticRuntimeHostOptions(
				defineStaticRuntime({
					name: 'unsupported-transport',
					plugins: [UnsupportedPlugin],
					configEnvironmentBootstrap: [
						bindConfigEnvironment(UnsupportedPlugin, UnsupportedConfig, {
							value: 'APP_UNKNOWN',
						}),
					],
				}),
				startup(),
			),
		).rejects.toThrow(/cannot bind APP_UNKNOWN.*unsupported/i)
	})

	it('distinguishes absent, empty, and null values without leaking malformed input', async () => {
		const application = defineStaticRuntime({
			name: 'decode-semantics',
			plugins: [EnvironmentPlugin],
			configEnvironmentBootstrap: [
				bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
					text: 'APP_TEXT',
					count: 'APP_COUNT',
					enabled: 'APP_ENABLED',
					nullable: 'APP_NULLABLE',
					subtree: 'APP_SUBTREE',
				}),
			],
		})

		expect(resolveConfigEnvironmentBootstrap(application, {})).toEqual([])
		expect(resolveConfigEnvironmentBootstrap(application, { APP_TEXT: '' })[0]?.config).toEqual({
			text: '',
		})
		expect(
			resolveConfigEnvironmentBootstrap(application, { APP_NULLABLE: 'null' })[0]?.config,
		).toEqual({ nullable: null })

		for (const [name, value] of [
			['APP_COUNT', 'sensitive-number-value'],
			['APP_ENABLED', 'sensitive-boolean-value'],
			['APP_SUBTREE', 'sensitive-json-value'],
		] as const) {
			let error: unknown
			try {
				resolveConfigEnvironmentBootstrap(application, { [name]: value })
			} catch (caught) {
				error = caught
			}
			expect(error).toBeInstanceOf(Error)
			expect(String(error)).toContain(name)
			expect(String(error)).not.toContain(value)
		}

		expect(() => resolveConfigEnvironmentBootstrap(application, { APP_COUNT: '' })).toThrow(
			/APP_COUNT/,
		)
		expect(() => resolveConfigEnvironmentBootstrap(application, { APP_ENABLED: '' })).toThrow(
			/APP_ENABLED/,
		)
		expect(() => resolveConfigEnvironmentBootstrap(application, { APP_SUBTREE: '' })).toThrow(
			/APP_SUBTREE/,
		)
	})

	it('merges configure below environment below PLUXEL_CONFIG without losing nested siblings', async () => {
		environmentOutput = undefined
		const owner = ownerOf(EnvironmentPlugin)
		const application = defineStaticRuntime({
			name: 'bootstrap-precedence',
			plugins: [EnvironmentPlugin],
			configEnvironmentBootstrap: [
				bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
					text: 'APP_TEXT',
					nested: { left: 'APP_LEFT' },
				}),
			],
			configure: () => ({
				configService: {
					mode: 'memory',
					snapshot: {
						plugins: [
							{
								owner,
								config: {
									text: 'configure',
									nested: { left: 'configure-left', right: 'configure-right' },
								},
							},
						],
					},
				},
				runtimeState: { mode: 'memory', snapshot: { enabled: [owner] } },
			}),
		})
		const runtime = await createStaticRuntimeTestHost(application, {
			env: {
				APP_TEXT: 'environment',
				APP_LEFT: 'environment-left',
				PLUXEL_CONFIG: snapshotEnvironment(owner, {
					text: 'pluxel-config',
					nested: { right: 'pluxel-right' },
				}),
			},
		})
		try {
			expect(requireConfigService(runtime.ctx).getRawConfig(owner)).toMatchObject({
				text: 'pluxel-config',
				nested: { left: 'environment-left', right: 'pluxel-right' },
			})
			expect(environmentOutput?.nested).toEqual({
				left: 'environment-left',
				right: 'pluxel-right',
			})
		} finally {
			await runtime.stop()
		}
	})

	it('re-seeds memory hosts from the current environment', async () => {
		const owner = ownerOf(EnvironmentPlugin)
		const application = defineStaticRuntime({
			name: 'memory-bootstrap',
			plugins: [EnvironmentPlugin],
			configEnvironmentBootstrap: [
				bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, { text: 'APP_TEXT' }),
			],
			configure: () => ({
				configService: { mode: 'memory' },
				runtimeState: { mode: 'memory' },
			}),
		})

		for (const value of ['first', 'second']) {
			const runtime = await createStaticRuntimeTestHost(application, { env: { APP_TEXT: value } })
			try {
				expect(requireConfigService(runtime.ctx).getRawConfig(owner)).toEqual({ text: value })
			} finally {
				await runtime.stop()
			}
		}
	})

	it('keeps the seeded config editable through the existing restart path', async () => {
		environmentOutput = undefined
		const owner = ownerOf(EnvironmentPlugin)
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'editable-bootstrap',
				plugins: [EnvironmentPlugin],
				configEnvironmentBootstrap: [
					bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
						text: 'APP_TEXT',
						nested: { left: 'APP_LEFT' },
					}),
				],
				configure: () => ({
					configService: { mode: 'memory' },
					runtimeState: { mode: 'memory', snapshot: { enabled: [owner] } },
				}),
			}),
			{ env: { APP_TEXT: 'bootstrap', APP_LEFT: 'left' } },
		)
		try {
			expect(environmentOutput?.text).toBe('bootstrap')
			requireConfigService(runtime.ctx).patchConfig(owner, { text: 'edited' })
			await requireRuntimePluginGraphCoordinator(runtime.ctx).restartNode(owner)
			expect(environmentOutput?.text).toBe('edited')
		} finally {
			await runtime.stop()
		}
	})

	it('persists the first writable seed and lets an existing file override later environment', async () => {
		await using fixture = await createDiskFixture()
		const owner = ownerOf(EnvironmentPlugin)
		const application = (readonly: boolean) =>
			defineStaticRuntime({
				name: readonly ? 'readonly-existing' : 'file-bootstrap',
				plugins: [EnvironmentPlugin],
				configEnvironmentBootstrap: [
					bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
						text: 'APP_TEXT',
						subtree: 'APP_SUBTREE',
					}),
				],
				configure: () => ({
					persistence: readonly ? { mode: 'readonly' as const, dir: fixture.path } : fixture.path,
					configService: { mode: readonly ? ('readonly' as const) : ('file' as const) },
					runtimeState: { mode: 'memory' as const },
				}),
			})

		const first = await createStaticRuntimeTestHost(application(false), {
			env: { APP_TEXT: 'persisted-first' },
		})
		await first.stop()

		const second = await createStaticRuntimeTestHost(application(true), {
			env: {
				APP_TEXT: 'later-environment',
				PLUXEL_CONFIG: snapshotEnvironment(owner, { text: 'later-pluxel-config' }),
			},
		})
		try {
			expect(requireConfigService(second.ctx).getRawConfig(owner)).toEqual({
				text: 'persisted-first',
			})
			expect(() =>
				requireConfigService(second.ctx).patchConfig(owner, { text: 'changed' }),
			).toThrow(/readonly mode/i)
		} finally {
			await second.stop()
		}

		const malformed = 'persisted-file-must-not-hide-this-private-value'
		let startupError: unknown
		try {
			await createStaticRuntimeTestHost(application(true), {
				env: { APP_SUBTREE: malformed },
			})
		} catch (error) {
			startupError = error
		}
		expect(startupError).toBeInstanceOf(Error)
		expect(String(startupError)).toContain('APP_SUBTREE')
		expect(String(startupError)).not.toContain(malformed)
	})

	it('uses a readonly seed when the file is absent without creating the file', async () => {
		await using fixture = await createDiskFixture()
		const owner = ownerOf(EnvironmentPlugin)
		const runtime = await createStaticRuntimeTestHost(
			defineStaticRuntime({
				name: 'readonly-absent',
				plugins: [EnvironmentPlugin],
				configEnvironmentBootstrap: [
					bindConfigEnvironment(EnvironmentPlugin, EnvironmentConfig, {
						text: 'APP_TEXT',
					}),
				],
				configure: () => ({
					persistence: { mode: 'readonly', dir: fixture.path },
					configService: { mode: 'readonly' },
					runtimeState: { mode: 'memory' },
				}),
			}),
			{ env: { APP_TEXT: 'readonly-seed' } },
		)
		try {
			expect(requireConfigService(runtime.ctx).getRawConfig(owner)).toEqual({
				text: 'readonly-seed',
			})
			expect(() =>
				requireConfigService(runtime.ctx).patchConfig(owner, { text: 'changed' }),
			).toThrow(/readonly mode/i)
		} finally {
			await runtime.stop()
		}
		await expect(access(`${fixture.path}/config/config.json`)).rejects.toMatchObject({
			code: 'ENOENT',
		})
	})
})
