import { describe, expect, it, vi } from 'vitest'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import { requireConfigService, requirePluginService } from '@pluxel/core/internal'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { PluginNodeAddress } from '../../plugins/runtime/identity'
import { ConfigService, type PluginConfigRecordSnapshot } from './ConfigService'
import { collectConfigDefaults } from './ops'

const ObjectSchema: StandardSchemaV1<unknown, { answer?: number }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({
			value:
				value && typeof value === 'object' && !Array.isArray(value)
					? (value as { answer?: number })
					: {},
		}),
	},
}

@Plugin()
class P extends BasePlugin {
	readonly config = this.configs.use(ObjectSchema)
}

class SnapshotConfigService extends ConfigService {
	restore(records: readonly PluginConfigRecordSnapshot[]): void {
		this.replaceConfigRecords(records)
	}
}

describe('ConfigService', () => {
	it('injects one validated object config per Plugin node', async () => {
		await withCoreHost(async (host) => {
			host.cfg(P).set({ answer: 42 })
			await host.start(P)
			const plugin = host.require(P)
			expect(plugin.config.answer).toBe(42)
			const configService = requireConfigService(host.ctx)
			expect(configService.getAppliedConfigRevision(host.cfg(P).owner)).toBe(
				configService.getConfigRevision(host.cfg(P).owner),
			)
		})
	})

	it('clears the applied revision when the running generation stops', async () => {
		await withCoreHost(async (host) => {
			host.cfg(P).set({ answer: 42 })
			await host.start(P)
			const owner = host.cfg(P).owner
			const configService = requireConfigService(host.ctx)
			expect(configService.getAppliedConfigRevision(owner)).not.toBeNull()
			host.remove(P)
			await host.commit()
			expect(configService.getAppliedConfigRevision(owner)).toBeNull()
		})
	})

	it('does not bump revision for no-op patches or unsets', async () => {
		await withCoreHost(async (host) => {
			const handle = host.cfg(P)
			handle.set({ answer: 1 })
			const first = handle.rev()
			handle.set({ answer: 1 })
			expect(handle.rev()).toBe(first)
			handle.unset('_missing')
			expect(handle.rev()).toBe(first)
			handle.unset('toString')
			expect(handle.rev()).toBe(first)
			handle.unset('answer')
			expect(handle.rev()).toBeGreaterThan(first)
		})
	})

	it('clones and freezes raw nested patches so revision-bound caches cannot drift', async () => {
		await withCoreHost(async (host) => {
			const handle = host.cfg(P)
			const input = { values: ['first'] }
			handle.set({ nested: input })
			const revision = handle.rev()
			input.values.push('mutated-outside')

			const raw = requireConfigService(host.ctx).getRawConfig<{
				nested: { values: string[] }
			}>(handle.owner)
			expect(raw.nested.values).toEqual(['first'])
			expect(Object.isFrozen(raw)).toBe(true)
			expect(Object.isFrozen(raw.nested)).toBe(true)
			expect(Object.isFrozen(raw.nested.values)).toBe(true)
			expect(handle.rev()).toBe(revision)

			handle.set({ nested: { values: ['second'] } })
			const next = requireConfigService(host.ctx).getRawConfig<{
				nested: { values: string[] }
			}>(handle.owner)
			expect(next).not.toBe(raw)
			expect(raw.nested.values).toEqual(['first'])
			expect(next.nested.values).toEqual(['second'])
		})
	})

	it('rejects executable, hidden and non-portable patch data without invoking accessors', async () => {
		await withCoreHost(async (host) => {
			const owner = host.cfg(P).owner
			const configService = requireConfigService(host.ctx)
			let reads = 0
			const accessor = Object.defineProperty({}, 'answer', {
				enumerable: true,
				get: () => {
					reads++
					return 42
				},
			})
			expect(() => configService.patchConfig(owner, accessor)).toThrow(/data property/i)
			expect(reads).toBe(0)

			const hidden = Object.defineProperty({}, 'answer', { value: 42 })
			expect(() => configService.patchConfig(owner, hidden)).toThrow(/data property/i)
			expect(() =>
				configService.patchConfig(owner, { [Symbol('answer')]: 42 } as Record<string, unknown>),
			).toThrow(/symbol key/i)
			expect(() => configService.patchConfig(owner, { answer: undefined })).toThrow(
				/portable data/i,
			)
			expect(() => configService.patchConfig(owner, { answer: Number.POSITIVE_INFINITY })).toThrow(
				/portable data/i,
			)
			expect(() => configService.patchConfig(owner, null as never)).toThrow(/plain object/i)
			expect(() => configService.patchConfig(owner, [] as never)).toThrow(/plain object/i)
			const arrayAccessor = Object.defineProperty([0], '0', {
				enumerable: true,
				get: () => {
					reads++
					return 1
				},
			})
			expect(() => configService.patchConfig(owner, { values: arrayAccessor })).toThrow(
				/data property/i,
			)
			expect(reads).toBe(0)

			const prototypeKey = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
			configService.patchConfig(owner, prototypeKey)
			const snapshot = configService.getRawConfig(owner)
			expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype)
			expect(Object.hasOwn(snapshot, '__proto__')).toBe(true)
			expect(snapshot.__proto__).toEqual({ polluted: true })
			expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
		})
	})

	it('binds a validated cache entry to both revision and candidate authority', async () => {
		await withCoreHost(async (host) => {
			let validationRuns = 0
			const schema: StandardSchemaV1<unknown, { answer?: number }> = {
				'~standard': {
					version: 1,
					vendor: 'pluxel:test',
					validate: (value: unknown) => {
						validationRuns++
						return { value: value as { answer?: number } }
					},
				},
			}
			const firstAuthority = Object.freeze({ schema })
			const replacementAuthority = Object.freeze({ schema })
			const owner = host.cfg(P).owner
			const configService = requireConfigService(host.ctx)
			configService.patchConfig(owner, { answer: 1 })

			const first = await configService.ensureValidated(owner, firstAuthority)
			expect(await configService.ensureValidated(owner, firstAuthority)).toBe(first)
			expect(validationRuns).toBe(1)

			await configService.ensureValidated(owner, replacementAuthority)
			expect(validationRuns).toBe(2)
		})
	})

	it('stages normalized data until durable confirmation and rejects stale publication', async () => {
		await withCoreHost(async (host) => {
			const owner = host.cfg(P).owner
			const configService = requireConfigService(host.ctx)
			const authority = Object.freeze({ schema: ObjectSchema })
			const expectedRevision = configService.getConfigRevision(owner)
			const input = { nested: { values: [1, 2] } }
			const staged = configService.stageValidatedConfig({
				owner,
				authority,
				expectedRevision,
				value: { answer: 42, input },
			})

			await expect(configService.ensureValidated(owner, authority)).rejects.toThrow(
				/awaiting durable persistence/i,
			)
			input.nested.values.push(3)
			expect(staged.snapshot).toEqual({ answer: 42, input: { nested: { values: [1, 2] } } })
			expect(Object.isFrozen(staged.snapshot)).toBe(true)
			expect(Object.isFrozen((staged.snapshot.input as typeof input).nested)).toBe(true)
			expect(Object.isFrozen((staged.snapshot.input as typeof input).nested.values)).toBe(true)
			expect(() => (staged.snapshot.input as typeof input).nested.values.push(4)).toThrow(TypeError)

			const published = configService.confirmValidatedConfig(staged)
			expect(await configService.ensureValidated(owner, authority)).toBe(published)
			configService.patchConfig(owner, { answer: 43 })
			expect(() => configService.confirmValidatedConfig(staged)).toThrow(/stale/i)
			expect(configService.getRawConfig(owner)).toMatchObject({ answer: 43 })
		})
	})

	it('deep-freezes a normalized schema transform before generation injection', async () => {
		await withCoreHost(async (host) => {
			const owner = host.cfg(P).owner
			const configService = requireConfigService(host.ctx)
			const schema: StandardSchemaV1<unknown, { nested: { values: string[] } }> = {
				'~standard': {
					version: 1,
					vendor: 'pluxel:test',
					validate: () => ({ value: { nested: { values: ['frozen'] } } }),
				},
			}
			const value = (await configService.ensureValidated(
				owner,
				Object.freeze({ schema }),
			)) as Readonly<{ nested: { values: string[] } }>
			expect(Object.isFrozen(value)).toBe(true)
			expect(Object.isFrozen(value.nested)).toBe(true)
			expect(Object.isFrozen(value.nested.values)).toBe(true)
		})
	})

	it('computes and caches defaults from one explicit semantic input', async () => {
		let validationRuns = 0
		const schema: StandardSchemaV1<unknown, { nested: { values: string[] } }> = {
			'~standard': {
				version: 1,
				vendor: 'pluxel:test',
				validate: (input) => {
					validationRuns++
					if (!input || typeof input !== 'object') return { issues: [{ message: 'object' }] }
					return { value: { nested: { values: ['default'] } } }
				},
			},
		}
		const first = await collectConfigDefaults(schema, { missingObjectDefault: {} })
		const second = await collectConfigDefaults(schema, { missingObjectDefault: {} })
		expect(second).toBe(first)
		expect(validationRuns).toBe(1)
		expect(Object.isFrozen(first)).toBe(true)
		expect(Object.isFrozen(first.nested)).toBe(true)
	})

	it('stores structured enable preferences without interpreting them', async () => {
		await withCoreHost(async (host) => {
			const handle = host.cfg(P)
			expect(handle.enabled()).toBe(false)
			handle.enable()
			expect(handle.enabled()).toBe(true)
			handle.disable()
			expect(handle.enabled()).toBe(false)
		})
	})

	it('stores disabled fork config by canonical address without interning a Core node slot', async () => {
		await withCoreHost(async (host) => {
			const definition = host.cfg(P).owner.definition
			const owner = Object.freeze({
				definition,
				variant: 'fork' as const,
				forkId: 'durable-disabled',
			}) satisfies PluginNodeAddress
			const intern = vi.spyOn(requirePluginService(host.ctx), 'internNodeAddress')
			const configService = requireConfigService(host.ctx)

			configService.patchConfig(owner, { answer: 42 })
			const snapshot = configService.getConfigSnapshot()

			expect(intern).not.toHaveBeenCalled()
			expect(snapshot.plugins).toEqual([{ owner, config: { answer: 42 } }])

			const restored = new SnapshotConfigService(host.ctx.root)
			restored.restore(snapshot.plugins)
			expect(restored.getRawConfig(owner)).toEqual({ answer: 42 })
			expect(restored.getConfigSnapshot().plugins[0]?.owner).toBe(owner)
		})
	})
})
