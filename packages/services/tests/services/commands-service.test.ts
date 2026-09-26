import { standardServices } from '@pluxel/services'
import { managementCommands } from '@pluxel/services/management/commands'
import { Commands } from '@pluxel/services/commands'
import { defineCommand, Result } from '@pluxel/commands'
import { pluginNodeAddressOf } from '@pluxel/core'
import { obj } from '@pluxel/commands/typebox'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { describe, expect, it } from 'vitest'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

function valueCommand(value: string, name = 'example.value.get') {
	return defineCommand({
		name,
		description: 'Read the value owned by the active plugin generation.',
		input: obj({}),
		execute: () => Result.ok({ value }),
	})
}

describe('CommandsService', () => {
	it('classifies unreadable trusted context and execution faults as INTERNAL', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		const registration = host.ctx.require(Commands).register(valueCommand('ready'))
		const signalError = new Error('signal getter failed')
		const unreadableSignal = Object.defineProperty({}, 'signal', {
			get() {
				throw signalError
			},
		})
		await expect(registration.execute({}, unreadableSignal)).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INTERNAL', cause: signalError },
		})
		await expect(registration.execute({}, { signal: {} } as never)).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INTERNAL', cause: expect.any(TypeError) },
		})

		const spreadError = new Error('context spread failed')
		const unreadableFields = new Proxy(
			{},
			{
				ownKeys() {
					throw spreadError
				},
			},
		)
		await expect(registration.execute({}, unreadableFields)).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INTERNAL', cause: spreadError },
		})
	})

	it('aborts and drains owner commands before the plugin stop hook', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const order: string[] = []
		let captured!: { execute(candidate: unknown, context?: {}): Promise<unknown> }
		let started!: () => void
		const didStart = new Promise<void>((resolve) => (started = resolve))

		@Plugin({ displayName: 'LongCommandOwner' })
		class LongCommandOwner extends BasePlugin {
			override init() {
				captured = this.ctx.require(Commands).register(
					defineCommand({
						name: 'owner.long.run',
						description: 'Run until the owner stops.',
						input: obj({}),
						async execute(_input, { signal }) {
							started()
							await new Promise<void>((_resolve, reject) => {
								signal?.addEventListener(
									'abort',
									() => {
										order.push('abort')
										reject(signal.reason)
									},
									{ once: true },
								)
							})
							return Result.ok()
						},
					}),
				)
				return () => {
					order.push('cleanup')
				}
			}
		}

		lowerTestPlugin(LongCommandOwner)
		host.add(LongCommandOwner)
		host.cfg(LongCommandOwner).setAutoStart(true)
		host.start(LongCommandOwner)
		await host.commit()
		const pending = host.ctx.require(Commands).execute('owner.long.run', {})
		await didStart
		host.remove(LongCommandOwner)
		await host.commit()

		await expect(pending).resolves.toMatchObject({ status: 'error', error: { code: 'ABORTED' } })
		expect(order).toEqual(['abort', 'cleanup'])
		expect(
			host.ctx
				.require(Commands)
				.list()
				.some(({ name }) => name === 'owner.long.run'),
		).toBe(false)
		await expect(captured.execute({}, {})).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'COMMAND_NOT_FOUND',
			},
		})
	})

	it('publishes the built-in plugin management catalog once during preparation', async () => {
		await using host = await createServiceInternalTestHarness({
			workbench: false,
			services: [...standardServices({ persistence: { mode: 'memory' } }), managementCommands()],
		})

		const prepared = host.ctx.require(Commands).list()
		expect(prepared).toHaveLength(6)
		await host.commit()
		await host.commit()
		expect(host.ctx.require(Commands).list()).toEqual(prepared)
		expect(
			host.ctx
				.require(Commands)
				.list()
				.map(({ name }) => name),
		).toEqual([
			'plugin.auto-start.set',
			'plugin.list',
			'plugin.restart',
			'plugin.start',
			'plugin.status.get',
			'plugin.stop',
		])
		expect(host.ctx.require(Commands).list()).toBe(host.ctx.require(Commands).list())
	})

	it('delegates stable catalog snapshots and publication subscriptions to the registry', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		await host.commit()
		const initial = host.ctx.require(Commands).snapshot()
		expect(host.ctx.require(Commands).snapshot()).toBe(initial)
		expect(host.ctx.require(Commands).list()).toBe(initial.descriptors)
		const revisions: number[] = []
		const unsubscribe = host.ctx
			.require(Commands)
			.subscribe((snapshot) => revisions.push(snapshot.revision))

		@Plugin({ displayName: 'ObservedCommandOwner' })
		class ObservedCommandOwner extends BasePlugin {
			override init() {
				this.ctx.require(Commands).register(valueCommand('observed', 'owner.observed.get'))
			}
		}

		lowerTestPlugin(ObservedCommandOwner)
		host.add(ObservedCommandOwner)
		host.cfg(ObservedCommandOwner).setAutoStart(true)
		host.start(ObservedCommandOwner)
		await host.commit()
		host.remove(ObservedCommandOwner)
		await host.commit()
		unsubscribe()

		expect(revisions).toEqual([initial.revision + 1, initial.revision + 2])
	})

	it('keeps retained registration handles fixed to their original generation', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		let retained!: {
			readonly descriptor: { readonly name: string }
			readonly execute: (candidate: {}) => Promise<unknown>
			readonly dispose: () => void
		}
		@Plugin({ displayName: 'CommandOwner' })
		class CommandOwnerV1 extends BasePlugin {
			override init() {
				retained = this.ctx.require(Commands).register(valueCommand('v1'))
			}
		}

		@Plugin({ displayName: 'CommandOwner' })
		class CommandOwnerV2 extends BasePlugin {
			override init() {
				this.ctx.require(Commands).register(valueCommand('v2'))
			}
		}

		lowerTestPlugin(CommandOwnerV1, { id: 'command-owner-generation' })
		lowerTestPlugin(CommandOwnerV2, { id: 'command-owner-generation' })
		host.add(CommandOwnerV1)
		host.cfg(CommandOwnerV1).setAutoStart(true)
		host.start(CommandOwnerV1)
		await host.commit()
		await expect(
			host.ctx.require(Commands).execute('example.value.get', {}),
		).resolves.toMatchObject({
			status: 'ok',
			value: {
				value: 'v1',
			},
		})

		host.replace(CommandOwnerV1, CommandOwnerV2)
		await host.commit()
		await expect(
			host.ctx.require(Commands).execute('example.value.get', {}),
		).resolves.toMatchObject({
			status: 'ok',
			value: {
				value: 'v2',
			},
		})
		await expect(retained.execute({})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
		retained.dispose()
		await expect(
			host.ctx.require(Commands).execute('example.value.get', {}),
		).resolves.toMatchObject({
			status: 'ok',
			value: {
				value: 'v2',
			},
		})

		host.remove(CommandOwnerV2)
		await host.commit()
		expect(
			host.ctx
				.require(Commands)
				.list()
				.some(({ name }) => name === 'example.value.get'),
		).toBe(false)
		await expect(retained.execute({})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
	})

	it('manual dispose revokes cached command wrappers without cancelling entered work', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		let disposeManual!: () => void
		let captured!: { execute(candidate: unknown, context?: {}): Promise<unknown> }
		let started!: () => void
		let release!: () => void
		const didStart = new Promise<void>((resolve) => (started = resolve))
		const gate = new Promise<void>((resolve) => (release = resolve))

		@Plugin({ displayName: 'ManualCommandOwner' })
		class ManualCommandOwner extends BasePlugin {
			override init() {
				const registration = this.ctx.require(Commands).register(
					defineCommand({
						name: 'owner.manual.dispose',
						description: 'Run until its manual registration is disposed.',
						input: obj({}),
						async execute() {
							started()
							await gate
							return Result.ok({ completed: true })
						},
					}),
				)
				captured = registration
				disposeManual = () => registration[Symbol.dispose]()
				this.ctx.require(Commands).register(valueCommand('live', 'owner.manual.sibling'))
			}
		}

		lowerTestPlugin(ManualCommandOwner)
		host.add(ManualCommandOwner)
		host.cfg(ManualCommandOwner).setAutoStart(true)
		host.start(ManualCommandOwner)
		await host.commit()
		const pending = captured.execute({}, {})
		await didStart

		disposeManual()
		expect(
			host.ctx
				.require(Commands)
				.list()
				.some(({ name }) => name === 'owner.manual.dispose'),
		).toBe(false)
		await expect(captured.execute({}, {})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
		await expect(
			host.ctx.require(Commands).execute('owner.manual.dispose', {}),
		).resolves.toMatchObject({
			status: 'error',
			error: {
				code: 'COMMAND_NOT_FOUND',
			},
		})
		await expect(
			host.ctx.require(Commands).execute('owner.manual.sibling', {}),
		).resolves.toMatchObject({
			status: 'ok',
			value: {
				value: 'live',
			},
		})

		release()
		await expect(pending).resolves.toMatchObject({ status: 'ok', value: { completed: true } })
	})

	it('rolls back registrations when plugin startup fails', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		@Plugin({ displayName: 'BrokenCommandOwner' })
		class BrokenCommandOwner extends BasePlugin {
			override init() {
				this.ctx.require(Commands).register(valueCommand('broken'))
				throw new Error('startup failed')
			}
		}

		lowerTestPlugin(BrokenCommandOwner)
		host.add(BrokenCommandOwner)
		host.cfg(BrokenCommandOwner).setAutoStart(true)
		host.start(BrokenCommandOwner)
		await host.commitAllowFail()

		expect(host.isRunning(BrokenCommandOwner)).toBe(false)
		expect(
			host.ctx
				.require(Commands)
				.list()
				.some(({ name }) => name === 'example.value.get'),
		).toBe(false)
	})

	it('keeps cached service views and cleanup isolated between plugin owners', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		@Plugin({ displayName: 'CommandOwnerA' })
		class CommandOwnerA extends BasePlugin {
			override async init() {
				const commands = this.ctx.require(Commands)
				await Promise.resolve()
				commands.register(valueCommand('a', 'owner.a.get'))
			}
		}

		@Plugin({ displayName: 'CommandOwnerB' })
		class CommandOwnerB extends BasePlugin {
			override async init() {
				const commands = this.ctx.require(Commands)
				await Promise.resolve()
				commands.register(valueCommand('b', 'owner.b.get'))
			}
		}

		lowerTestPlugin(CommandOwnerA)
		lowerTestPlugin(CommandOwnerB)
		host.add([CommandOwnerA, CommandOwnerB])
		host.cfg(CommandOwnerA).setAutoStart(true)
		host.start(CommandOwnerA)
		host.cfg(CommandOwnerB).setAutoStart(true)
		host.start(CommandOwnerB)
		await host.commit()

		expect(host.require(CommandOwnerA).ctx.require(Commands)).not.toBe(
			host.require(CommandOwnerB).ctx.require(Commands),
		)
		host.remove(CommandOwnerA)
		await host.commit()
		expect(
			host.ctx
				.require(Commands)
				.list()
				.some(({ name }) => name === 'owner.a.get'),
		).toBe(false)
		await expect(host.ctx.require(Commands).execute('owner.b.get', {})).resolves.toMatchObject({
			status: 'ok',
			value: {
				value: 'b',
			},
		})
	})

	it('executes management commands through the existing lifecycle use case', async () => {
		await using host = await createServiceInternalTestHarness({
			workbench: false,
			services: [...standardServices({ persistence: { mode: 'memory' } }), managementCommands()],
		})

		@Plugin({ displayName: 'ManagedPlugin' })
		class ManagedPlugin extends BasePlugin {}

		lowerTestPlugin(ManagedPlugin)
		host.add(ManagedPlugin)
		await host.commit()
		const address = pluginNodeAddressOf(ManagedPlugin)
		const started = await host.ctx.require(Commands).execute('plugin.start', {
			address,
		})
		expect(started).toMatchObject({
			status: 'ok',
			value: {
				address,
				displayName: 'ManagedPlugin',
				autoStart: false,
				sessionIntent: 'run',
				desiredState: 'running',
				activationReason: 'session',
				lifecycleState: 'running',
			},
		})

		const listed = await host.ctx.require(Commands).execute('plugin.list', {})
		expect(listed).toMatchObject({
			status: 'ok',
			value: {
				plugins: [expect.objectContaining({ address, lifecycleState: 'running' })],
				summary: { total: 1, running: 1, stopped: 0, autoStart: 0 },
			},
		})

		const stopped = await host.ctx.require(Commands).execute('plugin.stop', {
			address,
		})
		expect(stopped).toMatchObject({
			status: 'ok',
			value: {
				address,
				autoStart: false,
				sessionIntent: 'inherit',
				desiredState: 'stopped',
				activationReason: null,
				lifecycleState: 'stopped',
			},
		})
		host.remove(ManagedPlugin)
		await host.commit()
		await expect(
			host.ctx.require(Commands).execute('plugin.status.get', { address }),
		).resolves.toMatchObject({
			status: 'error',
			error: { code: 'REJECTED', reason: 'plugin_not_found' },
		})
	})

	it('restarts the required dependent closure through management commands', async () => {
		await using host = await createServiceInternalTestHarness({
			workbench: false,
			services: [...standardServices({ persistence: { mode: 'memory' } }), managementCommands()],
		})

		let providerStarts = 0
		let consumerStarts = 0

		@Plugin({ displayName: 'ManagedProvider' })
		class ManagedProvider extends BasePlugin {
			override init() {
				providerStarts++
			}
		}

		@Plugin({ displayName: 'ManagedConsumer' })
		class ManagedConsumer extends BasePlugin {
			constructor(readonly provider: ManagedProvider) {
				super()
			}

			override init() {
				consumerStarts++
			}
		}
		lowerTestPlugin(ManagedProvider)
		lowerTestPlugin(ManagedConsumer, { requires: [ManagedProvider] })
		host.add([ManagedProvider, ManagedConsumer])
		host.cfg(ManagedProvider).setAutoStart(true)
		host.start(ManagedProvider)
		host.cfg(ManagedConsumer).setAutoStart(true)
		host.start(ManagedConsumer)
		await host.commit()

		expect({ providerStarts, consumerStarts }).toEqual({ providerStarts: 1, consumerStarts: 1 })
		const providerAddress = pluginNodeAddressOf(ManagedProvider)
		const restarted = await host.ctx.require(Commands).execute('plugin.restart', {
			address: providerAddress,
		})

		expect(restarted).toMatchObject({
			status: 'ok',
			value: {
				address: providerAddress,
				autoStart: true,
				sessionIntent: 'inherit',
				desiredState: 'running',
				activationReason: 'auto-start',
				lifecycleState: 'running',
			},
		})
		expect({ providerStarts, consumerStarts }).toEqual({ providerStarts: 2, consumerStarts: 2 })
	})
})
