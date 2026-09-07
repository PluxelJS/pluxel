import {
	CommandError,
	createCommandRegistry,
	defineCommand,
	type CommandContext,
	type DirectCommand,
	type Registration,
} from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import type { CommandMount } from '@pluxel/runtime'
import { createRuntimeInternalTestHarness } from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

function valueCommand(value: string, name: string) {
	return defineCommand({
		name,
		description: 'Return the value captured by this command implementation.',
		behavior: { kind: 'query', world: 'closed' },
		input: obj({}),
		output: obj({ value: Type.String() }),
		execute: () => ({ value }),
	})
}

interface CarrierCommandContext extends CommandContext {
	readonly channel: string
}

type MountedCommand = DirectCommand<unknown, unknown, CarrierCommandContext>

function carrierProviderClass() {
	@Plugin({ displayName: 'Command mount carrier' })
	class CommandMountCarrier extends BasePlugin {
		private mount!: CommandMount<CarrierCommandContext>
		private readonly routes = new Map<string, MountedCommand>()

		override init(): void {
			this.mount = this.ctx.commands.createMount<CarrierCommandContext>()
		}

		register<I, O>(command: DirectCommand<I, O, CarrierCommandContext>): Registration {
			const routes = this.routes
			return this.mount.bind(command, (owned) => {
				if (routes.has(owned.name)) throw new Error(`duplicate route: ${owned.name}`)
				routes.set(owned.name, owned as MountedCommand)
				let active = true
				return {
					name: owned.name,
					dispose() {
						if (!active) return
						active = false
						if (routes.get(owned.name) === owned) routes.delete(owned.name)
					},
				}
			})
		}

		resolve<I, O>(name: string): DirectCommand<I, O, CarrierCommandContext> | undefined {
			return this.routes.get(name) as DirectCommand<I, O, CarrierCommandContext> | undefined
		}
	}

	lowerTestPlugin(CommandMountCarrier)
	return CommandMountCarrier
}

describe('CommandMount', () => {
	it('linearizes publication after install and pins one exact command implementation', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const rootSnapshot = host.ctx.commands.snapshot()
			const mount = host.ctx.commands.createMount()
			const original = valueCommand('original', 'mount.snapshot.get')
			const replacement = valueCommand('replacement', 'mount.snapshot.get')
			const mutable = {
				name: original.name,
				descriptor: { ...original.descriptor },
				execute: original.execute,
			}
			let installed!: DirectCommand<unknown, { value: string }>
			let preparing!: Promise<unknown>
			const registration = mount.bind(mutable, (owned) => {
				installed = owned
				preparing = owned.execute({})
				mutable.execute = replacement.execute
				mutable.descriptor.description = 'mutated after bind'
				return { name: owned.name, dispose() {} }
			})

			await expect(preparing).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
			expect(host.ctx.commands.snapshot()).toBe(rootSnapshot)
			expect(installed.descriptor.description).toBe(original.descriptor.description)
			await expect(installed.execute({})).resolves.toEqual({ value: 'original' })

			const catalog = createCommandRegistry()
			const catalogHandle = catalog.register(valueCommand('catalog', 'mount.catalog.get'))
			expect(() =>
				mount.bind(catalogHandle as unknown as DirectCommand, (owned) => ({
					name: owned.name,
					dispose() {},
				})),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
			let invalidInstallerCalled = false
			expect(() =>
				mount.bind({ ...original, dispose: undefined } as unknown as DirectCommand, (owned) => {
					invalidInstallerCalled = true
					return { name: owned.name, dispose() {} }
				}),
			).toThrow(
				expect.objectContaining({
					code: 'COMMAND_CONFIG',
					details: expect.objectContaining({ reason: 'installed_command' }),
				}),
			)
			expect(invalidInstallerCalled).toBe(false)

			const unreadableDisposer = Object.defineProperty({ ...original }, 'dispose', {
				get() {
					throw new Error('dispose getter failed')
				},
			})
			expect(() =>
				mount.bind(unreadableDisposer as unknown as DirectCommand, (owned) => ({
					name: owned.name,
					dispose() {},
				})),
			).toThrow(
				expect.objectContaining({
					code: 'COMMAND_CONFIG',
					details: expect.objectContaining({ reason: 'invalid_command' }),
				}),
			)

			const malformed = {
				name: '',
				descriptor: {
					name: '',
					description: 'Invalid empty name.',
					behavior: { kind: 'query', world: 'closed' },
					inputSchema: { type: 'object' },
				},
				execute: async () => undefined,
			} as unknown as DirectCommand
			expect(() => mount.bind(malformed, (owned) => ({ name: owned.name, dispose() {} }))).toThrow(
				expect.objectContaining({ code: 'COMMAND_CONFIG' }),
			)

			registration.dispose()
			await expect(installed.execute({})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
		} finally {
			await host.dispose()
		}
	})

	it('preserves a hand-authored command receiver while pinning its execute function', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const mount = host.ctx.commands.createMount()
			const descriptor = valueCommand('descriptor', 'mount.receiver.get').descriptor
			const command = {
				name: descriptor.name,
				descriptor,
				value: 'original',
				async execute() {
					return { value: this.value }
				},
			}
			let retained!: DirectCommand<unknown, { value: string }>
			mount.bind(command, (owned) => {
				retained = owned
				return { name: owned.name, dispose() {} }
			})

			command.execute = async () => ({ value: 'replacement' })
			await expect(retained.execute({})).resolves.toEqual({ value: 'original' })
		} finally {
			await host.dispose()
		}
	})

	it('normalizes every admission rejection to ABORTED', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const mount = host.ctx.commands.createMount()
			let retained!: DirectCommand<unknown, { value: string }>
			mount.bind(valueCommand('active', 'mount.admission.abort'), (owned) => {
				retained = owned
				return { name: owned.name, dispose() {} }
			})
			const call = new AbortController()
			call.abort(new CommandError('TIMEOUT', 'Caller deadline elapsed'))

			await expect(retained.execute({}, { signal: call.signal })).rejects.toMatchObject({
				code: 'ABORTED',
			})
		} finally {
			await host.dispose()
		}
	})

	it('binds each carrier publication to its consumer generation', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const CommandMountCarrier = carrierProviderClass()

			@Plugin({ displayName: 'Mount consumer A' })
			class MountConsumerA extends BasePlugin {
				constructor(readonly carrier: InstanceType<typeof CommandMountCarrier>) {
					super()
				}

				override init(): void {
					this.carrier.register(valueCommand('a', 'mount.consumer.a'))
				}
			}

			@Plugin({ displayName: 'Mount consumer B' })
			class MountConsumerB extends BasePlugin {
				constructor(readonly carrier: InstanceType<typeof CommandMountCarrier>) {
					super()
				}

				override init(): void {
					this.carrier.register(valueCommand('b', 'mount.consumer.b'))
				}
			}

			lowerTestPlugin(MountConsumerA, { requires: [CommandMountCarrier] })
			lowerTestPlugin(MountConsumerB, { requires: [CommandMountCarrier] })
			host.add([CommandMountCarrier, MountConsumerA, MountConsumerB])
			host.start(MountConsumerA)
			host.start(MountConsumerB)
			await host.commit()

			const carrier = host.require(CommandMountCarrier)
			const oldA = carrier.resolve<unknown, { value: string }>('mount.consumer.a')!
			const b = carrier.resolve<unknown, { value: string }>('mount.consumer.b')!
			host.remove(MountConsumerA)
			await host.commit()

			expect(carrier.resolve('mount.consumer.a')).toBeUndefined()
			expect(carrier.resolve('mount.consumer.b')).toBe(b)
			await expect(oldA.execute({}, { channel: 'a' })).rejects.toMatchObject({
				code: 'COMMAND_NOT_FOUND',
			})
			await expect(b.execute({}, { channel: 'b' })).resolves.toEqual({ value: 'b' })
		} finally {
			await host.dispose()
		}
	})

	it('aborts and drains work through the publication owner before cleanup', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const CommandMountCarrier = carrierProviderClass()
			const started = Promise.withResolvers<void>()
			const aborted = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()

			@Plugin({ displayName: 'Long mounted command consumer' })
			class LongMountConsumer extends BasePlugin {
				constructor(readonly carrier: InstanceType<typeof CommandMountCarrier>) {
					super()
				}

				override init(): void {
					this.carrier.register(
						defineCommand({
							name: 'mount.consumer.long',
							description: 'Wait until the publication owner stops.',
							behavior: { kind: 'query', world: 'closed' },
							input: obj({}),
							async execute(_input, { signal }) {
								started.resolve()
								if (!signal?.aborted) {
									await new Promise<void>((resolve) =>
										signal?.addEventListener('abort', () => resolve(), { once: true }),
									)
								}
								aborted.resolve()
								await release.promise
								throw signal?.reason
							},
						}),
					)
				}
			}

			lowerTestPlugin(LongMountConsumer, { requires: [CommandMountCarrier] })
			host.add([CommandMountCarrier, LongMountConsumer])
			host.start(LongMountConsumer)
			await host.commit()

			const carrier = host.require(CommandMountCarrier)
			const retained = carrier.resolve('mount.consumer.long')!
			const pending = retained.execute({}, { channel: 'long' })
			await started.promise

			host.remove(LongMountConsumer)
			let stopped = false
			const stopping = host.commit().then(() => {
				stopped = true
				return undefined
			})
			await aborted.promise
			await Promise.resolve()
			expect(stopped).toBe(false)
			await expect(retained.execute({}, { channel: 'late' })).rejects.toMatchObject({
				code: 'ABORTED',
			})

			release.resolve()
			await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
			await stopping
			expect(carrier.resolve('mount.consumer.long')).toBeUndefined()
			await expect(retained.execute({}, { channel: 'withdrawn' })).rejects.toMatchObject({
				code: 'COMMAND_NOT_FOUND',
			})
		} finally {
			await host.dispose()
		}
	})

	it('uses one admission and drains a provider-owned binding on provider stop', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const started = Promise.withResolvers<void>()
			const aborted = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			let retained!: DirectCommand<unknown, void>
			let published = false

			@Plugin({ displayName: 'Provider-owned mount' })
			class ProviderOwnedMount extends BasePlugin {
				override init(): void {
					const mount = this.ctx.commands.createMount()
					mount.bind(
						defineCommand({
							name: 'mount.provider.long',
							description: 'Wait until the provider stops.',
							behavior: { kind: 'query', world: 'closed' },
							input: obj({}),
							async execute(_input, { signal }) {
								started.resolve()
								if (!signal?.aborted) {
									await new Promise<void>((resolve) =>
										signal?.addEventListener('abort', () => resolve(), { once: true }),
									)
								}
								aborted.resolve()
								await release.promise
								throw signal?.reason
							},
						}),
						(owned) => {
							retained = owned
							published = true
							return { name: owned.name, dispose: () => (published = false) }
						},
					)
				}
			}

			lowerTestPlugin(ProviderOwnedMount)
			host.add(ProviderOwnedMount)
			host.start(ProviderOwnedMount)
			await host.commit()
			const pending = retained.execute({})
			await started.promise

			host.remove(ProviderOwnedMount)
			let stopped = false
			const stopping = host.commit().then(() => {
				stopped = true
				return undefined
			})
			await aborted.promise
			expect(stopped).toBe(false)
			expect(published).toBe(true)
			await expect(retained.execute({})).rejects.toMatchObject({ code: 'ABORTED' })

			release.resolve()
			await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
			await stopping
			expect(published).toBe(false)
			await expect(retained.execute({})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
		} finally {
			await host.dispose()
		}
	})

	it('never revives an old wrapper across consumer replacement', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const CommandMountCarrier = carrierProviderClass()

			@Plugin({ displayName: 'Mounted consumer v1' })
			class MountedConsumerV1 extends BasePlugin {
				constructor(readonly carrier: InstanceType<typeof CommandMountCarrier>) {
					super()
				}
				override init(): void {
					this.carrier.register(valueCommand('v1', 'mount.replacement.get'))
				}
			}

			@Plugin({ displayName: 'Mounted consumer v2' })
			class MountedConsumerV2 extends BasePlugin {
				constructor(readonly carrier: InstanceType<typeof CommandMountCarrier>) {
					super()
				}
				override init(): void {
					this.carrier.register(valueCommand('v2', 'mount.replacement.get'))
				}
			}

			lowerTestPlugin(MountedConsumerV1, {
				id: 'mounted-consumer-replacement',
				requires: [CommandMountCarrier],
			})
			lowerTestPlugin(MountedConsumerV2, {
				id: 'mounted-consumer-replacement',
				requires: [CommandMountCarrier],
			})
			host.add([CommandMountCarrier, MountedConsumerV1])
			host.start(MountedConsumerV1)
			await host.commit()
			const carrier = host.require(CommandMountCarrier)
			const old = carrier.resolve<unknown, { value: string }>('mount.replacement.get')!

			host.replace(MountedConsumerV1, MountedConsumerV2)
			await host.commit()
			const replacement = carrier.resolve<unknown, { value: string }>('mount.replacement.get')!
			expect(replacement).not.toBe(old)
			await expect(replacement.execute({}, { channel: 'new' })).resolves.toEqual({ value: 'v2' })
			await expect(old.execute({}, { channel: 'old' })).rejects.toMatchObject({
				code: 'COMMAND_NOT_FOUND',
			})
		} finally {
			await host.dispose()
		}
	})

	it('creates a fresh mount and wrapper across provider replacement', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			@Plugin({ displayName: 'Replaceable mount provider' })
			class MountProviderV1 extends BasePlugin {
				private mount!: CommandMount<CarrierCommandContext>
				private readonly routes = new Map<string, MountedCommand>()

				override init(): void {
					this.mount = this.ctx.commands.createMount<CarrierCommandContext>()
				}

				register<I, O>(command: DirectCommand<I, O, CarrierCommandContext>): Registration {
					const routes = this.routes
					return this.mount.bind(command, (owned) => {
						routes.set(owned.name, owned as MountedCommand)
						return {
							name: owned.name,
							dispose: () => {
								if (routes.get(owned.name) === owned) routes.delete(owned.name)
							},
						}
					})
				}

				resolve<I, O>(name: string): DirectCommand<I, O, CarrierCommandContext> | undefined {
					return this.routes.get(name) as DirectCommand<I, O, CarrierCommandContext> | undefined
				}
			}

			@Plugin({ displayName: 'Replacement mount provider' })
			class MountProviderV2 extends MountProviderV1 {}

			let consumerGeneration = 0
			@Plugin({ displayName: 'Provider replacement consumer' })
			class ProviderReplacementConsumer extends BasePlugin {
				constructor(readonly provider: MountProviderV1) {
					super()
				}

				override init(): void {
					consumerGeneration++
					this.provider.register(
						valueCommand(`generation-${consumerGeneration}`, 'mount.provider.replace'),
					)
				}
			}

			lowerTestPlugin(MountProviderV1, { id: 'replaceable-mount-provider' })
			lowerTestPlugin(MountProviderV2, { id: 'replaceable-mount-provider' })
			lowerTestPlugin(ProviderReplacementConsumer, { requires: [MountProviderV1] })
			host.add([MountProviderV1, ProviderReplacementConsumer])
			host.start(ProviderReplacementConsumer)
			await host.commit()
			const firstProvider = host.require(MountProviderV1)
			const old = firstProvider.resolve<unknown, { value: string }>('mount.provider.replace')!

			host.replace(MountProviderV1, MountProviderV2)
			await host.commit()
			const replacementProvider = host.require(MountProviderV1)
			const replacement = replacementProvider.resolve<unknown, { value: string }>(
				'mount.provider.replace',
			)!
			expect(replacementProvider).not.toBe(firstProvider)
			expect(replacement).not.toBe(old)
			await expect(replacement.execute({}, { channel: 'new' })).resolves.toEqual({
				value: 'generation-2',
			})
			await expect(old.execute({}, { channel: 'old' })).rejects.toMatchObject({
				code: 'COMMAND_NOT_FOUND',
			})
		} finally {
			await host.dispose()
		}
	})

	it('manual disposal is no-throw, exactly once, and does not cancel admitted work', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const mount = host.ctx.commands.createMount()
			const started = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			let cleanupCalls = 0
			let retained!: DirectCommand<unknown, { completed: boolean }>
			const registration = mount.bind(
				defineCommand({
					name: 'mount.manual.long',
					description: 'Finish after manual publication withdrawal.',
					behavior: { kind: 'query', world: 'closed' },
					input: obj({}),
					output: obj({ completed: Type.Boolean() }),
					async execute() {
						started.resolve()
						await release.promise
						return { completed: true }
					},
				}),
				(owned) => {
					retained = owned
					return {
						name: owned.name,
						dispose() {
							cleanupCalls++
							throw new Error('broken disposer')
						},
					}
				},
			)

			const pending = retained.execute({})
			await started.promise
			expect(() => registration.dispose()).not.toThrow()
			expect(() => registration.dispose()).not.toThrow()
			expect(cleanupCalls).toBe(1)
			await expect(retained.execute({})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
			release.resolve()
			await expect(pending).resolves.toEqual({ completed: true })
		} finally {
			await host.dispose()
		}
	})

	it('rolls back all bindings even when one installer disposer throws', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			let cleanupCalls = 0
			@Plugin({ displayName: 'Failing mount owner' })
			class FailingMountOwner extends BasePlugin {
				override init(): void {
					const mount = this.ctx.commands.createMount()
					for (const name of ['mount.rollback.first', 'mount.rollback.second']) {
						mount.bind(valueCommand(name, name), (owned) => ({
							name: owned.name,
							dispose() {
								cleanupCalls++
								if (name.endsWith('second')) throw new Error('rollback disposer failed')
							},
						}))
					}
					throw new Error('startup failed')
				}
			}

			lowerTestPlugin(FailingMountOwner)
			host.add(FailingMountOwner)
			host.start(FailingMountOwner)
			await host.commitAllowFail()
			expect(cleanupCalls).toBe(2)
		} finally {
			await host.dispose()
		}
	})

	it('rejects asynchronous installers and consumes every late outcome', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const mount = host.ctx.commands.createMount()
			let lateCleanupCalls = 0
			let thenReads = 0
			const lateRegistration = {
				// oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercises thenable rejection.
				get then() {
					thenReads++
					return (resolve: (registration: Registration) => void) =>
						resolve({
							name: 'mount.async.install',
							dispose() {
								lateCleanupCalls++
							},
						})
				},
			}

			expect(() =>
				mount.bind(valueCommand('async', 'mount.async.install'), () => lateRegistration as never),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
			expect(thenReads).toBe(1)
			expect(lateCleanupCalls).toBe(1)

			let throwingThenReads = 0
			let throwingThenCleanupCalls = 0
			const unreadableThen = Object.defineProperty(
				{
					name: 'mount.then.throw',
					dispose() {
						throwingThenCleanupCalls++
						throw new Error('then getter rollback failed')
					},
				},
				// oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercises an unreadable thenable.
				'then',
				{
					get() {
						throwingThenReads++
						throw new Error('then getter failed')
					},
				},
			)
			expect(() =>
				mount.bind(valueCommand('then', 'mount.then.throw'), () => unreadableThen),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
			expect(throwingThenReads).toBe(1)
			expect(throwingThenCleanupCalls).toBe(1)

			let hybridCleanupCalls = 0
			let hybridResolvedCleanupCalls = 0
			const hybridThenable = {
				name: 'mount.then.hybrid',
				dispose() {
					hybridCleanupCalls++
				},
				// oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercises a disposable thenable.
				then(resolve: (registration: Registration) => void) {
					resolve({
						name: 'mount.then.hybrid',
						dispose() {
							hybridResolvedCleanupCalls++
						},
					})
				},
			}
			expect(() =>
				mount.bind(valueCommand('hybrid', 'mount.then.hybrid'), () => hybridThenable as never),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
			expect(hybridCleanupCalls).toBe(1)
			expect(hybridResolvedCleanupCalls).toBe(1)

			let selfCleanupCalls = 0
			const selfResolvingThenable = {
				name: 'mount.then.self',
				dispose() {
					selfCleanupCalls++
				},
				// oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercises self-resolution.
				then(resolve: (registration: Registration) => void) {
					resolve(this)
				},
			}
			expect(() =>
				mount.bind(valueCommand('self', 'mount.then.self'), () => selfResolvingThenable as never),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
			expect(selfCleanupCalls).toBe(1)

			let mismatchCleanupCalls = 0
			expect(() =>
				mount.bind(valueCommand('mismatch', 'mount.name.expected'), () => ({
					name: 'mount.name.other',
					dispose() {
						mismatchCleanupCalls++
						throw new Error('mismatch cleanup failed')
					},
				})),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
			expect(mismatchCleanupCalls).toBe(1)
		} finally {
			await host.dispose()
		}
	})
})
