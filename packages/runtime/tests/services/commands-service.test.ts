import { defineCommand } from '@pluxel/commands'
import { pluginNodeAddressOf } from '@pluxel/core'
import { Type, obj } from '@pluxel/commands/typebox'
import { createRuntimeInternalTestHarness } from '@pluxel/runtime/internal/test'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

function valueCommand(value: string, name = 'example.value.get') {
	return defineCommand({
		name,
		description: 'Read the value owned by the active plugin generation.',
		behavior: { kind: 'query', world: 'closed' },
		input: obj({}),
		output: obj({ value: Type.String() }),
		execute: () => ({ value }),
	})
}

describe('CommandsService', () => {
	it('aborts and drains owner commands before the plugin stop hook', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const order: string[] = []
			let captured!: { execute(candidate: unknown, context?: {}): Promise<unknown> }
			let started!: () => void
			const didStart = new Promise<void>((resolve) => (started = resolve))

			@Plugin({ displayName: 'LongCommandOwner' })
			class LongCommandOwner extends BasePlugin {
				override init(): void {
					captured = this.ctx.commands.register(
						defineCommand({
							name: 'owner.long.run',
							description: 'Run until the owner stops.',
							behavior: { kind: 'query', world: 'closed' },
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
							},
						}),
					)
					return () => order.push('cleanup')
				}
			}

			lowerTestPlugin(LongCommandOwner)
			host.add(LongCommandOwner)
			host.cfg(LongCommandOwner).setAutoStart(true)
			host.start(LongCommandOwner)
			await host.commit()
			const pending = host.ctx.commands.execute('owner.long.run', {})
			await didStart
			host.remove(LongCommandOwner)
			await host.commit()

			await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
			expect(order).toEqual(['abort', 'cleanup'])
			expect(host.ctx.commands.list().some(({ name }) => name === 'owner.long.run')).toBe(false)
			await expect(captured.execute({}, {})).rejects.toMatchObject({
				code: 'COMMAND_NOT_FOUND',
			})
		} finally {
			await host.dispose()
		}
	})

	it('publishes the built-in plugin management catalog once', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			expect(host.ctx.commands.list().map(({ name }) => name)).toEqual([
				'plugin.auto-start.set',
				'plugin.list',
				'plugin.restart',
				'plugin.start',
				'plugin.status.get',
				'plugin.stop',
			])
			expect(host.ctx.commands.list()).toBe(host.ctx.commands.list())
		} finally {
			await host.dispose()
		}
	})

	it('delegates stable catalog snapshots and publication subscriptions to the registry', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const initial = host.ctx.commands.snapshot()
			expect(host.ctx.commands.snapshot()).toBe(initial)
			expect(host.ctx.commands.list()).toBe(initial.descriptors)
			const revisions: number[] = []
			const unsubscribe = host.ctx.commands.subscribe((snapshot) =>
				revisions.push(snapshot.revision),
			)

			@Plugin({ displayName: 'ObservedCommandOwner' })
			class ObservedCommandOwner extends BasePlugin {
				override init(): void {
					this.ctx.commands.register(valueCommand('observed', 'owner.observed.get'))
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
		} finally {
			await host.dispose()
		}
	})

	it('moves retained installed handles to a compatible replacement without stale ownership', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			let retained!: {
				readonly descriptor: { readonly name: string }
				readonly execute: (candidate: unknown, context?: {}) => Promise<{ value: string }>
				readonly dispose: () => void
			}
			@Plugin({ displayName: 'CommandOwner' })
			class CommandOwnerV1 extends BasePlugin {
				override init() {
					retained = this.ctx.commands.register(valueCommand('v1'))
				}
			}

			@Plugin({ displayName: 'CommandOwner' })
			class CommandOwnerV2 extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('v2'))
				}
			}

			lowerTestPlugin(CommandOwnerV1, { id: 'command-owner-generation' })
			lowerTestPlugin(CommandOwnerV2, { id: 'command-owner-generation' })
			host.add(CommandOwnerV1)
			host.cfg(CommandOwnerV1).setAutoStart(true)
			host.start(CommandOwnerV1)
			await host.commit()
			await expect(host.ctx.commands.execute('example.value.get', {})).resolves.toEqual({
				value: 'v1',
			})

			host.replace(CommandOwnerV1, CommandOwnerV2)
			await host.commit()
			await expect(host.ctx.commands.execute('example.value.get', {})).resolves.toEqual({
				value: 'v2',
			})
			await expect(retained.execute({})).resolves.toEqual({ value: 'v2' })
			retained.dispose()
			await expect(host.ctx.commands.execute('example.value.get', {})).resolves.toEqual({
				value: 'v2',
			})

			host.remove(CommandOwnerV2)
			await host.commit()
			expect(host.ctx.commands.list().some(({ name }) => name === 'example.value.get')).toBe(false)
			await expect(retained.execute({})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
		} finally {
			await host.dispose()
		}
	})

	it('manual dispose revokes cached command wrappers without cancelling entered work', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			let disposeManual!: () => void
			let captured!: { execute(candidate: unknown, context?: {}): Promise<unknown> }
			let started!: () => void
			let release!: () => void
			const didStart = new Promise<void>((resolve) => (started = resolve))
			const gate = new Promise<void>((resolve) => (release = resolve))

			@Plugin({ displayName: 'ManualCommandOwner' })
			class ManualCommandOwner extends BasePlugin {
				override init(): void {
					const registration = this.ctx.commands.register(
						defineCommand({
							name: 'owner.manual.dispose',
							description: 'Run until its manual registration is disposed.',
							behavior: { kind: 'query', world: 'closed' },
							input: obj({}),
							output: obj({ completed: Type.Boolean() }),
							async execute() {
								started()
								await gate
								return { completed: true }
							},
						}),
					)
					captured = registration
					disposeManual = () => registration.dispose()
					this.ctx.commands.register(valueCommand('live', 'owner.manual.sibling'))
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
			expect(host.ctx.commands.list().some(({ name }) => name === 'owner.manual.dispose')).toBe(
				false,
			)
			await expect(captured.execute({}, {})).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
			await expect(host.ctx.commands.execute('owner.manual.dispose', {})).rejects.toMatchObject({
				code: 'COMMAND_NOT_FOUND',
			})
			await expect(host.ctx.commands.execute('owner.manual.sibling', {})).resolves.toEqual({
				value: 'live',
			})

			release()
			await expect(pending).resolves.toEqual({ completed: true })
		} finally {
			await host.dispose()
		}
	})

	it('rolls back registrations when plugin startup fails', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			@Plugin({ displayName: 'BrokenCommandOwner' })
			class BrokenCommandOwner extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('broken'))
					throw new Error('startup failed')
				}
			}

			lowerTestPlugin(BrokenCommandOwner)
			host.add(BrokenCommandOwner)
			host.cfg(BrokenCommandOwner).setAutoStart(true)
			host.start(BrokenCommandOwner)
			await host.commitAllowFail()

			expect(host.isRunning(BrokenCommandOwner)).toBe(false)
			expect(host.ctx.commands.list().some(({ name }) => name === 'example.value.get')).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('keeps cached service views and cleanup isolated between plugin owners', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			@Plugin({ displayName: 'CommandOwnerA' })
			class CommandOwnerA extends BasePlugin {
				override async init() {
					const commands = this.ctx.commands
					await Promise.resolve()
					commands.register(valueCommand('a', 'owner.a.get'))
				}
			}

			@Plugin({ displayName: 'CommandOwnerB' })
			class CommandOwnerB extends BasePlugin {
				override async init() {
					const commands = this.ctx.commands
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

			expect(host.require(CommandOwnerA).ctx.commands).not.toBe(
				host.require(CommandOwnerB).ctx.commands,
			)
			host.remove(CommandOwnerA)
			await host.commit()
			expect(host.ctx.commands.list().some(({ name }) => name === 'owner.a.get')).toBe(false)
			await expect(host.ctx.commands.execute('owner.b.get', {})).resolves.toEqual({
				value: 'b',
			})
		} finally {
			await host.dispose()
		}
	})

	it('executes management commands through the existing lifecycle use case', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			@Plugin({ displayName: 'ManagedPlugin' })
			class ManagedPlugin extends BasePlugin {}

			lowerTestPlugin(ManagedPlugin)
			host.add(ManagedPlugin)
			await host.commit()
			const address = pluginNodeAddressOf(ManagedPlugin)
			const started = await host.ctx.commands.execute('plugin.start', {
				address,
			})
			expect(started).toMatchObject({
				address,
				displayName: 'ManagedPlugin',
				autoStart: false,
				sessionIntent: 'run',
				desiredState: 'running',
				activationReason: 'session',
				lifecycleState: 'running',
			})

			const listed = await host.ctx.commands.execute('plugin.list', {})
			expect(listed).toMatchObject({
				plugins: [expect.objectContaining({ address, lifecycleState: 'running' })],
				summary: { total: 1, running: 1, stopped: 0, autoStart: 0 },
			})

			const stopped = await host.ctx.commands.execute('plugin.stop', {
				address,
			})
			expect(stopped).toMatchObject({
				address,
				autoStart: false,
				sessionIntent: 'inherit',
				desiredState: 'stopped',
				activationReason: null,
				lifecycleState: 'stopped',
			})
		} finally {
			await host.dispose()
		}
	})

	it('restarts the required dependent closure through management commands', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			let providerStarts = 0
			let consumerStarts = 0

			@Plugin({ displayName: 'ManagedProvider' })
			class ManagedProvider extends BasePlugin {
				override init(): void {
					providerStarts++
				}
			}

			@Plugin({ displayName: 'ManagedConsumer' })
			class ManagedConsumer extends BasePlugin {
				constructor(readonly provider: ManagedProvider) {
					super()
				}

				override init(): void {
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
			const restarted = await host.ctx.commands.execute('plugin.restart', {
				address: providerAddress,
			})

			expect(restarted).toMatchObject({
				address: providerAddress,
				autoStart: true,
				sessionIntent: 'inherit',
				desiredState: 'running',
				activationReason: 'auto-start',
				lifecycleState: 'running',
			})
			expect({ providerStarts, consumerStarts }).toEqual({ providerStarts: 2, consumerStarts: 2 })
		} finally {
			await host.dispose()
		}
	})
})
