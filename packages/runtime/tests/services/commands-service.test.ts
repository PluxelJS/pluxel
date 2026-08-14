import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import type { PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	createRuntimeHost,
	Plugin,
	setParamToken,
	type RuntimeHost,
} from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'

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

			@Plugin({ name: 'LongCommandOwner' })
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
				}

				override stop(): void {
					order.push('stop')
				}
			}

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
			expect(order).toEqual(['abort', 'stop'])
			expect(host.ctx.commands.get('owner.long.run')).toBeUndefined()
			await expect(captured.execute({}, {})).resolves.toMatchObject({
				ok: false,
				error: { code: 'ABORTED' },
			})
		} finally {
			await host.dispose()
		}
	})

	it('withdraws a manual registration without cancelling its admitted invocation', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			let registration!: { dispose(): void }
			let started!: () => void
			const didStart = new Promise<void>((resolve) => (started = resolve))
			let release!: () => void
			const released = new Promise<void>((resolve) => (release = resolve))

			@Plugin({ name: 'WithdrawnCommandOwner' })
			class WithdrawnCommandOwner extends BasePlugin {
				override init(): void {
					registration = this.ctx.commands.register(
						defineCommand({
							name: 'owner.withdraw.run',
							description: 'Finish an admitted call after publication is withdrawn.',
							behavior: { kind: 'query', world: 'closed' },
							input: obj({}),
							async execute() {
								started()
								await released
							},
						}),
					)
				}
			}

			host.add(WithdrawnCommandOwner)
			host.cfg(WithdrawnCommandOwner).enable()
			await host.commit()
			const pending = host.ctx.commands.executeOrThrow('owner.withdraw.run', {})
			await didStart
			registration.dispose()
			expect(host.ctx.commands.get('owner.withdraw.run')).toBeUndefined()
			release()
			await expect(pending).resolves.toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

	it('schedules owner self-shutdown after its command invocation releases', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'SelfStoppingCommandOwner' })
			class SelfStoppingCommandOwner extends BasePlugin {
				override init(): void {
					this.ctx.commands.register(
						defineCommand({
							name: 'owner.self.stop',
							description: 'Stop this command owner.',
							behavior: {
								kind: 'mutation',
								destructive: false,
								idempotent: true,
								world: 'closed',
							},
							input: obj({}),
							execute: () => this.ctx.registry.shutdownSelf(),
						}),
					)
				}
			}

			host.add(SelfStoppingCommandOwner)
			host.cfg(SelfStoppingCommandOwner).enable()
			await host.commit()
			await expect(host.ctx.commands.executeOrThrow('owner.self.stop', {})).resolves.toBeUndefined()
			await host.commit()
			expect(host.isRunning(SelfStoppingCommandOwner)).toBe(false)
			expect(host.ctx.commands.get('owner.self.stop')).toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

	it('publishes the built-in plugin management catalog once', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			expect(host.ctx.commands.list().map(({ name }) => name)).toEqual([
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

	it('reclaims plugin commands on stop and replaces them without stale handlers', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'CommandOwner' })
			class CommandOwnerV1 extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('v1'))
				}
			}

			@Plugin({ name: 'CommandOwner' })
			class CommandOwnerV2 extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('v2'))
				}
			}

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

	it('rejects a cached owner command first invoked after its generation stops', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'UnusedCommandOwner' })
			class UnusedCommandOwner extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('unused', 'owner.unused.get'))
				}
			}

			host.add(UnusedCommandOwner)
			host.cfg(UnusedCommandOwner).enable()
			await host.commit()
			const captured = host.ctx.commands.get('owner.unused.get')!

			host.remove(UnusedCommandOwner)
			await host.commit()

			await expect(captured.execute({}, {})).resolves.toMatchObject({
				ok: false,
				error: { code: 'ABORTED' },
			})
		} finally {
			await host.dispose()
		}
	})

	it('rolls back registrations when plugin startup fails', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'BrokenCommandOwner' })
			class BrokenCommandOwner extends BasePlugin {
				override init() {
					this.ctx.commands.register(valueCommand('broken'))
					throw new Error('startup failed')
				}
			}

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
			@Plugin({ name: 'CommandOwnerA' })
			class CommandOwnerA extends BasePlugin {
				override async init() {
					const commands = this.ctx.commands
					await Promise.resolve()
					commands.register(valueCommand('a', 'owner.a.get'))
				}
			}

			@Plugin({ name: 'CommandOwnerB' })
			class CommandOwnerB extends BasePlugin {
				override async init() {
					const commands = this.ctx.commands
					await Promise.resolve()
					commands.register(valueCommand('b', 'owner.b.get'))
				}
			}

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
			@Plugin({ name: 'ManagedPlugin' })
			class ManagedPlugin extends BasePlugin {}

			installTestRoute(host, new Map([['ManagedPlugin', ManagedPlugin]]))
			const started = await host.ctx.commands.executeOrThrow('plugin.start', {
				name: 'ManagedPlugin',
			})
			expect(started).toMatchObject({
				name: 'ManagedPlugin',
				isRunning: true,
				isEnabled: true,
				lifecycleStage: 'running',
			})

			const listed = await host.ctx.commands.executeOrThrow('plugin.list', {})
			expect(listed).toMatchObject({
				plugins: [expect.objectContaining({ name: 'ManagedPlugin', isRunning: true })],
				summary: { total: 1, running: 1, stopped: 0, disabled: 0 },
			})

			const stopped = await host.ctx.commands.executeOrThrow('plugin.stop', {
				name: 'ManagedPlugin',
			})
			expect(stopped).toMatchObject({
				name: 'ManagedPlugin',
				isRunning: false,
				isEnabled: true,
				lifecycleStage: 'stopped',
			})
		} finally {
			await host.dispose()
		}
	})

	it('restarts the required dependent closure through management commands', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'ManagedProvider' })
			class ManagedProvider extends BasePlugin {}

			@Plugin({ name: 'ManagedConsumer' })
			class ManagedConsumer extends BasePlugin {
				constructor(readonly provider: ManagedProvider) {
					super()
				}
			}
			setParamToken(ManagedConsumer, 0, ManagedProvider)

			installTestRoute(
				host,
				new Map([
					['ManagedProvider', ManagedProvider],
					['ManagedConsumer', ManagedConsumer],
				]),
			)
			host.add([ManagedProvider, ManagedConsumer])
			host.cfg(ManagedProvider).enable()
			host.cfg(ManagedConsumer).enable()
			await host.commit()

			const firstProvider = host.require(ManagedProvider)
			const firstConsumer = host.require(ManagedConsumer)
			const restarted = await host.ctx.commands.executeOrThrow('plugin.restart', {
				name: 'ManagedProvider',
			})

			expect(restarted).toMatchObject({
				name: 'ManagedProvider',
				isRunning: true,
				isEnabled: true,
				lifecycleStage: 'running',
			})
			expect(host.require(ManagedProvider)).not.toBe(firstProvider)
			expect(host.require(ManagedConsumer)).not.toBe(firstConsumer)
			expect(Object.getPrototypeOf(host.require(ManagedConsumer).provider)).toBe(
				host.require(ManagedProvider),
			)
		} finally {
			await host.dispose()
		}
	})
})

function installTestRoute(
	host: RuntimeHost,
	catalog: ReadonlyMap<string, PluginConstructor>,
): void {
	host.ctx.runtimeRoute = {
		catalog: {
			resolve(target) {
				return typeof target === 'string' ? catalog.get(target) : target
			},
			resolveOrRegistered(name) {
				return catalog.get(name)
			},
			require(name) {
				const plugin = catalog.get(name)
				if (!plugin) throw new Error(`Plugin not found: ${name}`)
				return plugin
			},
			listRegistered: () => catalog,
			listLoadedNames: () => [...catalog.keys()],
		},
		lifecycle: {
			isRunning: (target) => host.isRunning(target),
			enable(name, plugin) {
				if (!host.has(plugin)) host.add(plugin)
				host.cfg(name).enable()
			},
			enablePersisted(name) {
				host.cfg(name).enable()
			},
			deactivate(name, plugin, { runtimeOnly }) {
				if (host.has(plugin)) host.remove(plugin)
				if (!runtimeOnly) host.cfg(name).disable()
			},
			stop(_name, plugin) {
				if (host.has(plugin)) host.remove(plugin)
			},
		},
	}
}
