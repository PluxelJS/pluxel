import { Commands, type CommandMount, type MountedCommand } from '@pluxel/services/commands'
import {
	defineCommand,
	Result,
	snapshotCommand,
	type CommandContext,
	type DirectCommand,
} from '@pluxel/commands'
import { obj } from '@pluxel/commands/typebox'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { describe, expect, it } from 'vitest'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

interface RequestContext extends CommandContext {
	readonly actor: string
}
interface BusinessContext extends CommandContext {
	readonly actorId: string
}

function readCommand() {
	return defineCommand({
		name: 'handler.read',
		description: 'Read for the authenticated actor.',
		input: obj({}),
		execute(_input, context: BusinessContext) {
			return Result.ok(context.actorId)
		},
	})
}

describe('carrier command handlers', () => {
	it('keeps publisher resources alive through asynchronous failure presentation', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		const presenting = Promise.withResolvers<void>()
		const aborted = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let cleaned = false
		let endpoint!: MountedCommand<{}, string, RequestContext>

		@Plugin({ displayName: 'Handler carrier' })
		class Carrier extends BasePlugin {
			private mount!: CommandMount<RequestContext>
			override init() {
				this.mount = this.ctx.require(Commands).createMount<RequestContext>()
			}
			publish(definition: DirectCommand<{}, string, BusinessContext>) {
				return this.mount.bind(definition, {
					async handle(command, candidate, context) {
						const result = await command.execute(candidate as {}, {
							actorId: context.actor,
							signal: context.signal,
						})
						expect(result.isErr()).toBe(true)
						context.signal!.addEventListener('abort', () => aborted.resolve(), { once: true })
						presenting.resolve()
						await release.promise
						expect(cleaned).toBe(false)
						return Result.ok('failure rendered')
					},
					install(owned) {
						endpoint = owned
						return { name: owned.name, dispose() {} }
					},
				})
			}
		}
		@Plugin({ displayName: 'Handler publisher' })
		class Publisher extends BasePlugin {
			constructor(readonly carrier: Carrier) {
				super()
			}
			override init() {
				this.ctx.effects.defer(() => {
					cleaned = true
				})
				this.carrier.publish(readCommand())
			}
		}
		lowerTestPlugin(Carrier)
		lowerTestPlugin(Publisher, { requires: [Carrier] })
		host.add([Carrier, Publisher])
		host.start(Publisher)
		await host.commit()
		// Invalid input must still be rendered while the publisher is admitted.
		const pending = endpoint.execute({ unexpected: true }, { actor: 'alice' })
		await presenting.promise
		host.remove(Publisher)
		const stopping = host.commit()
		try {
			await aborted.promise
			expect(cleaned).toBe(false)
			await expect(endpoint.execute({}, { actor: 'late' })).resolves.toMatchObject({
				status: 'error',
				error: { code: 'ABORTED' },
			})
		} finally {
			release.resolve()
		}
		await expect(pending).resolves.toMatchObject({ status: 'ok', value: 'failure rendered' })
		await stopping
		expect(cleaned).toBe(true)
	})

	it('isolates trusted contexts, protects presentation after withdrawal, and rejects re-mounting', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		const mount = host.ctx.require(Commands).createMount<RequestContext>()
		const started = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let endpoint!: MountedCommand<{}, string, RequestContext>
		const registration = mount.bind(readCommand(), {
			async handle(command, candidate, context) {
				const result = await command.execute(candidate as {}, {
					actorId: context.actor,
					signal: context.signal,
				})
				if (result.isErr()) return result
				if (context.actor === 'alice') {
					started.resolve()
					await release.promise
				}
				return Result.ok(`reply:${result.value}`)
			},
			install(owned) {
				endpoint = owned
				return { name: owned.name, dispose() {} }
			},
		})
		for (const command of [endpoint, snapshotCommand(endpoint)]) {
			expect(() =>
				mount.bind(command as unknown as DirectCommand<{}, string, RequestContext>, {
					install: () => {
						throw new Error('must not install')
					},
				}),
			).toThrow(expect.objectContaining({ code: 'COMMAND_CONFIG' }))
		}
		const alice = endpoint.execute({}, { actor: 'alice' })
		await started.promise
		try {
			await expect(endpoint.execute({}, { actor: 'bob' })).resolves.toMatchObject({
				status: 'ok',
				value: 'reply:bob',
			})
			registration.dispose()
			await expect(endpoint.execute({}, { actor: 'late' })).resolves.toMatchObject({
				status: 'error',
				error: { code: 'COMMAND_NOT_FOUND' },
			})
		} finally {
			release.resolve()
		}
		await expect(alice).resolves.toMatchObject({ status: 'ok', value: 'reply:alice' })
	})
	it('supervises invalid handler results and distinguishes cancellation from unrelated faults', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		const mount = host.ctx.require(Commands).createMount<RequestContext>()
		let endpoint!: MountedCommand<{}, unknown, RequestContext>
		const failure = new Error('presentation failed')
		const abort = new AbortController()
		mount.bind(readCommand(), {
			async handle(_command, _candidate, context) {
				if (context.actor === 'raw') return 'raw' as never
				if (context.actor === 'invalid-error')
					return Result.err({ code: 'REJECTED', message: 'missing reason' }) as never
				if (context.actor === 'cancelled') {
					abort.abort(new Error('request ended'))
					throw context.signal!.reason
				}
				throw failure
			},
			install(owned) {
				endpoint = owned
				return { name: owned.name, dispose() {} }
			},
		})
		for (const actor of ['raw', 'invalid-error']) {
			await expect(endpoint.execute({}, { actor })).resolves.toMatchObject({
				status: 'error',
				error: { code: 'INTERNAL' },
			})
		}
		await expect(endpoint.execute({}, { actor: 'fault' })).resolves.toMatchObject({
			status: 'error',
			error: { code: 'INTERNAL', cause: failure },
		})
		await expect(
			endpoint.execute({}, { actor: 'cancelled', signal: abort.signal }),
		).resolves.toMatchObject({ status: 'error', error: { code: 'ABORTED' } })
	})
})
