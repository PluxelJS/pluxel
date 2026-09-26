import { Commands, type CommandMount } from '@pluxel/services/commands'
import {
	CommandError,
	createCommandRegistry,
	defineCommand,
	Result,
	type CommandContext,
	type Command,
	type DirectCommand,
	type Registration,
} from '@pluxel/commands'
import { obj } from '@pluxel/commands/typebox'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { describe, expect, it } from 'vitest'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

function valueCommand(value: string, name: string) {
	return defineCommand({
		name,
		description: 'Return the value captured by this command implementation.',
		input: obj({}),
		execute: () => Result.ok({ value }),
	})
}

interface CarrierCommandContext extends CommandContext {
	readonly channel: string
}

type MountedCommand = Command<unknown, unknown, CarrierCommandContext>

function carrierProviderClass() {
	@Plugin({ displayName: 'Command mount carrier' })
	class CommandMountCarrier extends BasePlugin {
		private mount!: CommandMount<CarrierCommandContext>
		private readonly routes = new Map<string, MountedCommand>()

		override init(): void {
			this.mount = this.ctx.require(Commands).createMount<CarrierCommandContext>()
		}

		register<I, O>(command: DirectCommand<I, O, CarrierCommandContext>): Registration {
			const routes = this.routes
			return this.mount.bind(command, {
				install: (owned) => {
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
				},
			})
		}

		resolve<I, O>(name: string): Command<I, O, CarrierCommandContext> | undefined {
			return this.routes.get(name) as Command<I, O, CarrierCommandContext> | undefined
		}
	}

	lowerTestPlugin(CommandMountCarrier)
	return CommandMountCarrier
}

describe('CommandMount', () => {
	it('classifies an unreadable trusted context as INTERNAL', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		const mount = host.ctx.require(Commands).createMount()
		let installed!: Command<{}, { value: string }>
		mount.bind(valueCommand('ready', 'mount.context.get'), {
			install: (owned) => {
				installed = owned
				return { name: owned.name, dispose() {} }
			},
		})
		const signalError = new Error('signal getter failed')
		const unreadableSignal = Object.defineProperty({}, 'signal', {
			get() {
				throw signalError
			},
		})
		await expect(installed.execute({}, unreadableSignal)).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INTERNAL', cause: signalError },
		})
		await expect(installed.execute({}, { signal: {} } as never)).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INTERNAL', cause: expect.any(TypeError) },
		})
	})

	it('linearizes publication after install and pins one exact command implementation', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const rootSnapshot = host.ctx.require(Commands).snapshot()
		const mount = host.ctx.require(Commands).createMount()
		const original = valueCommand('original', 'mount.snapshot.get')
		const replacement = valueCommand('replacement', 'mount.snapshot.get')
		const mutable = {
			name: original.name,
			descriptor: { ...original.descriptor },
			execute: original.execute,
		}
		let installed!: Command<unknown, { value: string }>
		let preparing!: Promise<unknown>
		const registration = mount.bind(mutable, {
			install: (owned) => {
				installed = owned
				preparing = owned.execute({})
				mutable.execute = replacement.execute
				mutable.descriptor.description = 'mutated after bind'
				return { name: owned.name, dispose() {} }
			},
		})

		await expect(preparing).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
		expect(host.ctx.require(Commands).snapshot()).toBe(rootSnapshot)
		expect(installed.descriptor.description).toBe(original.descriptor.description)
		await expect(installed.execute({})).resolves.toMatchObject({
			status: 'ok',
			value: { value: 'original' },
		})

		const catalog = createCommandRegistry()
		const catalogHandle = catalog.register(valueCommand('catalog', 'mount.catalog.get'))
		expect(() =>
			mount.bind(catalogHandle as unknown as DirectCommand, {
				install: (owned) => ({
					name: owned.name,
					dispose() {},
				}),
			}),
		).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
		let invalidInstallerCalled = false
		expect(() =>
			mount.bind({ ...original, dispose: undefined } as unknown as DirectCommand, {
				install: (owned) => {
					invalidInstallerCalled = true
					return { name: owned.name, dispose() {} }
				},
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
			mount.bind(unreadableDisposer as unknown as DirectCommand, {
				install: (owned) => ({
					name: owned.name,
					dispose() {},
				}),
			}),
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
				inputSchema: { type: 'object' },
			},
			execute: async (): Promise<undefined> => undefined,
		} as unknown as DirectCommand
		expect(() =>
			mount.bind(malformed, { install: (owned) => ({ name: owned.name, dispose() {} }) }),
		).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))

		registration.dispose()
		await expect(installed.execute({})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
	})

	it('preserves a hand-authored command receiver while pinning its execute function', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const mount = host.ctx.require(Commands).createMount()
		const descriptor = valueCommand('descriptor', 'mount.receiver.get').descriptor
		const command = {
			name: descriptor.name,
			descriptor,
			value: 'original',
			async execute() {
				return Result.ok({ value: this.value })
			},
		}
		let retained!: Command<unknown, { value: string }>
		mount.bind(command, {
			install: (owned) => {
				retained = owned
				return { name: owned.name, dispose() {} }
			},
		})

		command.execute = async () => Result.ok({ value: 'replacement' })
		await expect(retained.execute({})).resolves.toMatchObject({
			status: 'ok',
			value: { value: 'original' },
		})
	})

	it('normalizes every admission rejection to ABORTED', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const mount = host.ctx.require(Commands).createMount()
		let retained!: Command<unknown, { value: string }>
		mount.bind(valueCommand('active', 'mount.admission.abort'), {
			install: (owned) => {
				retained = owned
				return { name: owned.name, dispose() {} }
			},
		})
		const call = new AbortController()
		call.abort(new CommandError('TIMEOUT', 'Caller deadline elapsed'))

		await expect(retained.execute({}, { signal: call.signal })).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'ABORTED',
			},
		})
	})

	it('binds each carrier publication to its consumer generation', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

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
		await expect(oldA.execute({}, { channel: 'a' })).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'ABORTED',
			},
		})
		await expect(b.execute({}, { channel: 'b' })).resolves.toMatchObject({
			status: 'ok',
			value: { value: 'b' },
		})
	})

	it('aborts and drains work through the publication owner before cleanup', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

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
		const stopping = host.commit().then((): void => {
			stopped = true
			return undefined
		})
		await aborted.promise
		await Promise.resolve()
		expect(stopped).toBe(false)
		await expect(retained.execute({}, { channel: 'late' })).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'ABORTED',
			},
		})

		release.resolve()
		await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'ABORTED' } })
		await stopping
		expect(carrier.resolve('mount.consumer.long')).toBeUndefined()
		await expect(retained.execute({}, { channel: 'withdrawn' })).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'ABORTED',
			},
		})
	})

	it('uses one admission and drains a provider-owned binding on provider stop', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const started = Promise.withResolvers<void>()
		const aborted = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let retained!: Command<unknown, unknown>
		let published = false

		@Plugin({ displayName: 'Provider-owned mount' })
		class ProviderOwnedMount extends BasePlugin {
			override init(): void {
				const mount = this.ctx.require(Commands).createMount()
				mount.bind(
					defineCommand({
						name: 'mount.provider.long',
						description: 'Wait until the provider stops.',
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
					{
						install: (owned) => {
							retained = owned
							published = true
							return { name: owned.name, dispose: () => (published = false) }
						},
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
		const stopping = host.commit().then((): void => {
			stopped = true
			return undefined
		})
		await aborted.promise
		expect(stopped).toBe(false)
		expect(published).toBe(true)
		await expect(retained.execute({})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'ABORTED' },
		})

		release.resolve()
		await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'ABORTED' } })
		await stopping
		expect(published).toBe(false)
		await expect(retained.execute({})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'ABORTED' },
		})
	})

	it('never revives an old wrapper across consumer replacement', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

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
		await expect(replacement.execute({}, { channel: 'new' })).resolves.toMatchObject({
			status: 'ok',
			value: { value: 'v2' },
		})
		await expect(old.execute({}, { channel: 'old' })).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'ABORTED',
			},
		})
	})

	it('creates a fresh mount and wrapper across provider replacement', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		@Plugin({ displayName: 'Replaceable mount provider' })
		class MountProviderV1 extends BasePlugin {
			private mount!: CommandMount<CarrierCommandContext>
			private readonly routes = new Map<string, MountedCommand>()

			override init(): void {
				this.mount = this.ctx.require(Commands).createMount<CarrierCommandContext>()
			}

			register<I, O>(command: DirectCommand<I, O, CarrierCommandContext>): Registration {
				const routes = this.routes
				return this.mount.bind(command, {
					install: (owned) => {
						routes.set(owned.name, owned as MountedCommand)
						return {
							name: owned.name,
							dispose: () => {
								if (routes.get(owned.name) === owned) routes.delete(owned.name)
							},
						}
					},
				})
			}

			resolve<I, O>(name: string): Command<I, O, CarrierCommandContext> | undefined {
				return this.routes.get(name) as Command<I, O, CarrierCommandContext> | undefined
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
		await expect(replacement.execute({}, { channel: 'new' })).resolves.toMatchObject({
			status: 'ok',
			value: {
				value: 'generation-2',
			},
		})
		await expect(old.execute({}, { channel: 'old' })).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'ABORTED',
			},
		})
	})

	it('manual disposal is no-throw, exactly once, and does not cancel admitted work', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const mount = host.ctx.require(Commands).createMount()
		const started = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let cleanupCalls = 0
		let retained!: Command<unknown, { completed: boolean }>
		const registration = mount.bind(
			defineCommand({
				name: 'mount.manual.long',
				description: 'Finish after manual publication withdrawal.',
				input: obj({}),
				async execute() {
					started.resolve()
					await release.promise
					return Result.ok({ completed: true })
				},
			}),
			{
				install: (owned) => {
					retained = owned
					return {
						name: owned.name,
						dispose() {
							cleanupCalls++
							throw new Error('broken disposer')
						},
					}
				},
			},
		)

		const pending = retained.execute({})
		await started.promise
		expect(() => registration.dispose()).not.toThrow()
		expect(() => registration.dispose()).not.toThrow()
		expect(cleanupCalls).toBe(1)
		await expect(retained.execute({})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
		release.resolve()
		await expect(pending).resolves.toMatchObject({ status: 'ok', value: { completed: true } })
	})

	it('rolls back all bindings even when one installer disposer throws', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		let cleanupCalls = 0
		@Plugin({ displayName: 'Failing mount owner' })
		class FailingMountOwner extends BasePlugin {
			override init(): void {
				const mount = this.ctx.require(Commands).createMount()
				for (const name of ['mount.rollback.first', 'mount.rollback.second']) {
					mount.bind(valueCommand(name, name), {
						install: (owned) => ({
							name: owned.name,
							dispose() {
								cleanupCalls++
								if (name.endsWith('second')) throw new Error('rollback disposer failed')
							},
						}),
					})
				}
				throw new Error('startup failed')
			}
		}

		lowerTestPlugin(FailingMountOwner)
		host.add(FailingMountOwner)
		host.start(FailingMountOwner)
		await host.commitAllowFail()
		expect(cleanupCalls).toBe(2)
	})

	it('rejects asynchronous installers and consumes every late outcome', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const mount = host.ctx.require(Commands).createMount()
		let lateCleanupCalls = 0
		let thenReads = 0
		const lateRegistration = {
			// oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercises thenable rejection.
			get then() {
				thenReads++
				return (resolve: (registration: Pick<Registration, 'name' | 'dispose'>) => void) =>
					resolve({
						name: 'mount.async.install',
						dispose() {
							lateCleanupCalls++
						},
					})
			},
		}

		expect(() =>
			mount.bind(valueCommand('async', 'mount.async.install'), {
				install: () => lateRegistration as never,
			}),
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
			mount.bind(valueCommand('then', 'mount.then.throw'), { install: () => unreadableThen }),
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
			then(resolve: (registration: Pick<Registration, 'name' | 'dispose'>) => void) {
				resolve({
					name: 'mount.then.hybrid',
					dispose() {
						hybridResolvedCleanupCalls++
					},
				})
			},
		}
		expect(() =>
			mount.bind(valueCommand('hybrid', 'mount.then.hybrid'), {
				install: () => hybridThenable as never,
			}),
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
			then(resolve: (registration: Pick<Registration, 'name' | 'dispose'>) => void) {
				resolve(this)
			},
		}
		expect(() =>
			mount.bind(valueCommand('self', 'mount.then.self'), {
				install: () => selfResolvingThenable as never,
			}),
		).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
		expect(selfCleanupCalls).toBe(1)

		let mismatchCleanupCalls = 0
		expect(() =>
			mount.bind(valueCommand('mismatch', 'mount.name.expected'), {
				install: () => ({
					name: 'mount.name.other',
					dispose() {
						mismatchCleanupCalls++
						throw new Error('mismatch cleanup failed')
					},
				}),
			}),
		).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
		expect(mismatchCleanupCalls).toBe(1)
	})
})
