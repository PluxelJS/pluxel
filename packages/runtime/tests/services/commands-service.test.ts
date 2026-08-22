import { defineCommand } from '@pluxel/commands'
import { pluginNodeAddressOf } from '@pluxel/core'
import { Type, obj } from '@pluxel/commands/typebox'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
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
		const host = createRuntimeHost({ workbench: false })
		try {
			const order: string[] = []
			let started!: () => void
			const didStart = new Promise<void>((resolve) => (started = resolve))

			@Plugin({ displayName: 'LongCommandOwner' })
			class LongCommandOwner extends BasePlugin {
				override init(): void {
					this.ctx.commands.register(
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
			host.cfg(LongCommandOwner).enable()
			await host.commit()
			const captured = host.ctx.commands.get('owner.long.run')!
			const pending = host.ctx.commands.execute('owner.long.run', {})
			await didStart
			host.remove(LongCommandOwner)
			await host.commit()

			await expect(pending).resolves.toMatchObject({
				ok: false,
				error: { code: 'ABORTED' },
			})
			expect(order).toEqual(['abort', 'cleanup'])
			expect(host.ctx.commands.get('owner.long.run')).toBeUndefined()
			await expect(captured.execute({}, {})).resolves.toMatchObject({
				ok: false,
				error: { code: 'ABORTED' },
			})
		} finally {
			await host.dispose()
		}
	})

	it('publishes the built-in plugin management catalog once', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			expect(host.ctx.commands.list().map(({ name }) => name)).toEqual([
				'plugin.disable',
				'plugin.enable',
				'plugin.list',
				'plugin.restart',
				'plugin.status.get',
			])
			expect(host.ctx.commands.list()).toBe(host.ctx.commands.list())
		} finally {
			await host.dispose()
		}
	})

	it('reclaims plugin commands on stop and replaces them without stale handlers', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ displayName: 'CommandOwner' })
			class CommandOwnerV1 extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('v1'))
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
			host.cfg(CommandOwnerV1).enable()
			await host.commit()
			await expect(host.ctx.commands.executeOrThrow('example.value.get', {})).resolves.toEqual({
				value: 'v1',
			})

			host.replace(CommandOwnerV1, CommandOwnerV2)
			await host.commit()
			await expect(host.ctx.commands.executeOrThrow('example.value.get', {})).resolves.toEqual({
				value: 'v2',
			})

			host.remove(CommandOwnerV2)
			await host.commit()
			expect(host.ctx.commands.get('example.value.get')).toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

	it('manual dispose revokes cached command wrappers without cancelling entered work', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			let disposeManual!: () => void
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
					disposeManual = () => registration.dispose()
					this.ctx.commands.register(valueCommand('live', 'owner.manual.sibling'))
				}
			}

			lowerTestPlugin(ManualCommandOwner)
			host.add(ManualCommandOwner)
			host.cfg(ManualCommandOwner).enable()
			await host.commit()
			const captured = host.ctx.commands.get('owner.manual.dispose')!
			const pending = captured.executeOrThrow({}, {})
			await didStart

			disposeManual()
			expect(host.ctx.commands.get('owner.manual.dispose')).toBeUndefined()
			await expect(captured.execute({}, {})).resolves.toMatchObject({
				ok: false,
				error: { code: 'COMMAND_NOT_FOUND' },
			})
			await expect(host.ctx.commands.execute('owner.manual.dispose', {})).resolves.toMatchObject({
				ok: false,
				error: { code: 'COMMAND_NOT_FOUND' },
			})
			await expect(host.ctx.commands.executeOrThrow('owner.manual.sibling', {})).resolves.toEqual({
				value: 'live',
			})

			release()
			await expect(pending).resolves.toEqual({ completed: true })
		} finally {
			await host.dispose()
		}
	})

	it('rolls back registrations when plugin startup fails', async () => {
		const host = createRuntimeHost({ workbench: false })
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
			host.cfg(BrokenCommandOwner).enable()
			await host.commitAllowFail()

			expect(host.isRunning(BrokenCommandOwner)).toBe(false)
			expect(host.ctx.commands.get('example.value.get')).toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

	it('keeps cached service views and cleanup isolated between plugin owners', async () => {
		const host = createRuntimeHost({ workbench: false })
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
			host.cfg(CommandOwnerA).enable()
			host.cfg(CommandOwnerB).enable()
			await host.commit()

			expect(host.require(CommandOwnerA).ctx.commands).not.toBe(
				host.require(CommandOwnerB).ctx.commands,
			)
			host.remove(CommandOwnerA)
			await host.commit()
			expect(host.ctx.commands.get('owner.a.get')).toBeUndefined()
			await expect(host.ctx.commands.executeOrThrow('owner.b.get', {})).resolves.toEqual({
				value: 'b',
			})
		} finally {
			await host.dispose()
		}
	})

	it('executes management commands through the existing lifecycle use case', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ displayName: 'ManagedPlugin' })
			class ManagedPlugin extends BasePlugin {}

			lowerTestPlugin(ManagedPlugin)
			host.add(ManagedPlugin)
			await host.commit()
			const address = pluginNodeAddressOf(ManagedPlugin)
			const started = await host.ctx.commands.executeOrThrow('plugin.enable', {
				address,
			})
			expect(started).toMatchObject({
				address,
				displayName: 'ManagedPlugin',
				isRunning: true,
				isEnabled: true,
				lifecycleStage: 'running',
			})

			const listed = await host.ctx.commands.executeOrThrow('plugin.list', {})
			expect(listed).toMatchObject({
				plugins: [expect.objectContaining({ address, isRunning: true })],
				summary: { total: 1, running: 1, stopped: 0, disabled: 0 },
			})

			const stopped = await host.ctx.commands.executeOrThrow('plugin.disable', {
				address,
			})
			expect(stopped).toMatchObject({
				address,
				isRunning: false,
				isEnabled: false,
				lifecycleStage: 'disabled',
			})
		} finally {
			await host.dispose()
		}
	})

	it('restarts the required dependent closure through management commands', async () => {
		const host = createRuntimeHost({ workbench: false })
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
			host.cfg(ManagedProvider).enable()
			host.cfg(ManagedConsumer).enable()
			await host.commit()

			expect({ providerStarts, consumerStarts }).toEqual({ providerStarts: 1, consumerStarts: 1 })
			const providerAddress = pluginNodeAddressOf(ManagedProvider)
			const restarted = await host.ctx.commands.executeOrThrow('plugin.restart', {
				address: providerAddress,
			})

			expect(restarted).toMatchObject({
				address: providerAddress,
				isRunning: true,
				isEnabled: true,
				lifecycleStage: 'running',
			})
			expect({ providerStarts, consumerStarts }).toEqual({ providerStarts: 2, consumerStarts: 2 })
		} finally {
			await host.dispose()
		}
	})
})
