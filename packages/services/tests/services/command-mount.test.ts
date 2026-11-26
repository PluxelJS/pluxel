import {
	CommandError,
	createCommandRegistry,
	defineCommand,
	Result,
	type Command,
	type DirectCommand,
	type Registration,
} from '@pluxel/commands'
import { createArgvRouter, toCli } from '@pluxel/commands/argv'
import { obj } from '@pluxel/commands/typebox'
import { BasePlugin, Plugin } from '@pluxel/core'
import { commands, Commands, type CommandMount } from '@pluxel/services/commands'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it, vi } from 'vitest'

function valueCommand(name: string, value: string) {
	return defineCommand({
		name,
		description: 'Read a value from the mounted command.',
		input: obj({}),
		execute: () => Result.ok(value),
	})
}

const commandHost = () =>
	createServiceInternalTestHost({ services: [commands()], workbench: false })
const mainRoute = 'mount.read'
const peerRoute = 'mount.peer'
const aborted = { status: 'error', error: { code: 'ABORTED' } }
const withdrawn = { status: 'error', error: { code: 'COMMAND_NOT_FOUND' } }

@Plugin()
class Carrier extends BasePlugin {
	readonly version: string = 'first'
	private readonly router = createArgvRouter()
	private mount!: CommandMount

	init() {
		this.mount = this.ctx.service(Commands).createMount()
	}

	publish<I, O>(command: DirectCommand<I, O>, cleanup?: () => void) {
		return this.mount.bind(command, {
			install: (owned) => {
				const route = this.router.bind(toCli(owned, { routes: [owned.name] }))
				return {
					name: route.name,
					dispose() {
						route.dispose()
						cleanup?.()
					},
				}
			},
		})
	}

	resolve(name: string) {
		return this.router.resolve(name)?.command
	}
}

@Plugin()
class Publisher extends BasePlugin {
	constructor(readonly carrier: Carrier) {
		super()
	}

	init() {
		this.publish(valueCommand(mainRoute, this.carrier.version))
	}

	publish<I, O>(command: DirectCommand<I, O>) {
		return this.carrier.publish(command)
	}
}

@Plugin()
class Peer extends BasePlugin {
	constructor(readonly carrier: Carrier) {
		super()
	}

	init() {
		this.carrier.publish(valueCommand(peerRoute, 'peer'))
	}
}

it('activates a mounted command after installation and pins its descriptor and execute function', async () => {
	await using host = await commandHost()
	const service = host.ctx.service(Commands)
	const rootIndex = service.snapshot()
	const mount = service.createMount()
	const original = valueCommand(mainRoute, 'original')
	const mutable = {
		name: original.name,
		descriptor: { ...original.descriptor },
		value: 'original',
		async execute() {
			return Result.ok(this.value)
		},
	}
	let endpoint!: Command<unknown, string>
	let duringInstall!: Promise<unknown>
	mount.bind(mutable, {
		install(owned) {
			endpoint = owned
			duringInstall = owned.execute({})
			mutable.execute = async () => Result.ok('replacement')
			mutable.descriptor.description = 'Edited after installation'
			return { name: owned.name, dispose() {} }
		},
	})

	await expect(duringInstall).resolves.toMatchObject(withdrawn)
	expect(service.snapshot()).toBe(rootIndex)
	expect(endpoint.descriptor.description).toBe(original.descriptor.description)
	mutable.value = 'live receiver'
	await expect(endpoint.execute({})).resolves.toEqual(Result.ok('live receiver'))
})

it('distinguishes malformed trusted context from a rejected caller admission', async () => {
	await using host = await commandHost()
	const mount = host.ctx.service(Commands).createMount()
	let endpoint!: Command<{}, string>
	mount.bind(valueCommand(mainRoute, 'ready'), {
		install(owned) {
			endpoint = owned
			return { name: owned.name, dispose() {} }
		},
	})

	const cause = new Error('signal getter failed')
	const unreadable = {
		get signal(): never {
			throw cause
		},
	}
	await expect(endpoint.execute({}, unreadable)).resolves.toMatchObject({
		status: 'error',
		error: { code: 'INTERNAL', cause },
	})
	await expect(endpoint.execute({}, { signal: {} } as never)).resolves.toMatchObject({
		status: 'error',
		error: { code: 'INTERNAL', cause: expect.any(TypeError) },
	})
	const signal = AbortSignal.abort(new CommandError('TIMEOUT', 'Caller deadline elapsed'))
	await expect(endpoint.execute({}, { signal })).resolves.toMatchObject(aborted)
})

it('rejects installed and malformed command definitions before calling the installer', async () => {
	await using host = await commandHost()
	const mount = host.ctx.service(Commands).createMount()
	const command = valueCommand(mainRoute, 'ready')
	using existing = createCommandRegistry().register(command)
	const unreadable = {
		...command,
		get dispose(): never {
			throw new Error('disposer getter failed')
		},
	}
	const install = vi.fn()
	for (const [definition, reason] of [
		[existing, 'installed_command'],
		[{ ...command, dispose: undefined as undefined }, 'installed_command'],
		[unreadable, 'invalid_command'],
		[{ ...command, name: '' }, undefined],
	] as const) {
		expect(() => mount.bind(definition as DirectCommand, { install })).toThrow(
			expect.objectContaining({
				code: 'COMMAND_CONFIG',
				...(reason && { details: { reason } }),
			}),
		)
	}
	expect(install).not.toHaveBeenCalled()
})

it('replaces a publisher’s route and keeps another publisher’s route live', async () => {
	await using host = await commandHost()
	const [carrier] = await host.start([
		Carrier.nodeAddress(),
		Publisher.nodeAddress(),
		Peer.nodeAddress(),
	])
	const first = carrier.resolve(mainRoute)!
	const peer = carrier.resolve(peerRoute)!
	const NextPublisher = lowerTestReplacement(
		Publisher,
		class extends Publisher {
			override init() {
				this.publish(valueCommand(mainRoute, 'replacement publisher'))
			}
		},
		{ requires: [Carrier] },
	)

	await host.replaceDefinition(Publisher, NextPublisher)

	const replacement = carrier.resolve(mainRoute)!
	expect(replacement).not.toBe(first)
	await expect(replacement.execute({})).resolves.toEqual(Result.ok('replacement publisher'))
	await expect(first.execute({})).resolves.toMatchObject(aborted)
	expect(carrier.resolve(peerRoute)).toBe(peer)
	await expect(peer.execute({})).resolves.toEqual(Result.ok('peer'))
})

it('rebuilds a consumer binding with the replacement provider’s mount', async () => {
	await using host = await commandHost()
	const [carrier] = await host.start([Carrier.nodeAddress(), Publisher.nodeAddress()])
	const first = carrier.resolve(mainRoute)!
	const NextCarrier = lowerTestReplacement(
		Carrier,
		class extends Carrier {
			override readonly version = 'replacement carrier'
		},
	)

	await host.replaceDefinition(Carrier, NextCarrier)

	const replacement = host.require(NextCarrier.nodeAddress()).resolve(mainRoute)!
	expect(carrier.resolve(mainRoute)).toBeUndefined()
	expect(replacement).not.toBe(first)
	await expect(replacement.execute({})).resolves.toEqual(Result.ok('replacement carrier'))
	await expect(first.execute({})).resolves.toMatchObject(aborted)
})

it.each(['provider', 'publisher'] as const)(
	'aborts and drains active work before withdrawing the route on %s stop',
	async (owner) => {
		await using host = await commandHost()
		const carrier = await host.start(Carrier.nodeAddress())
		const providerOwned = owner === 'provider'
		const publisher = providerOwned ? carrier : await host.start(Publisher.nodeAddress())
		const address = providerOwned ? Carrier.nodeAddress() : Publisher.nodeAddress()
		const entered = Promise.withResolvers<void>()
		const abortedCall = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const name = 'mount.wait'
		publisher.publish(
			defineCommand({
				name,
				description: 'Wait for owner withdrawal.',
				input: obj({}),
				async execute(_input, { signal }) {
					signal!.addEventListener('abort', () => abortedCall.resolve(), { once: true })
					entered.resolve()
					await release.promise
					throw signal!.reason
				},
			}),
		)

		const endpoint = carrier.resolve(name)!
		const pending = endpoint.execute({})
		let stopped = false
		try {
			await entered.promise
			const stopping = host.stop(address).then((): undefined => {
				stopped = true
				return undefined
			})
			await abortedCall.promise
			expect(stopped).toBe(false)
			expect(carrier.resolve(name)).toBe(endpoint)
			await expect(endpoint.execute({})).resolves.toMatchObject(aborted)

			release.resolve()
			await expect(pending).resolves.toMatchObject(aborted)
			await stopping
			expect(carrier.resolve(name)).toBeUndefined()
			await expect(endpoint.execute({})).resolves.toMatchObject(aborted)
			expect(host.isRunning(Carrier.nodeAddress())).toBe(!providerOwned)
		} finally {
			release.resolve()
		}
	},
)

it('manual withdrawal removes the route once and lets admitted work finish', async () => {
	await using host = await commandHost()
	const carrier = await host.start(Carrier.nodeAddress())
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const cleanup = vi.fn(() => {
		throw new Error('broken disposer')
	})
	const publication = carrier.publish(
		defineCommand({
			name: mainRoute,
			description: 'Finish admitted work after manual withdrawal.',
			input: obj({}),
			async execute(_input, { signal }) {
				entered.resolve()
				await release.promise
				return Result.ok({ completed: true, aborted: signal!.aborted })
			},
		}),
		cleanup,
	)

	const endpoint = carrier.resolve(mainRoute)!
	const pending = endpoint.execute({})
	try {
		await entered.promise
		expect(() => publication.dispose()).not.toThrow()
		expect(() => publication[Symbol.dispose]()).not.toThrow()
		expect(cleanup).toHaveBeenCalledOnce()
		expect(carrier.resolve(mainRoute)).toBeUndefined()
		await expect(endpoint.execute({})).resolves.toMatchObject(withdrawn)
	} finally {
		release.resolve()
	}
	await expect(pending).resolves.toEqual(Result.ok({ completed: true, aborted: false }))
})

const rollbackCleanup = vi.fn()

@Plugin()
class FailingPublisher extends BasePlugin {
	constructor(readonly carrier: Carrier) {
		super()
	}

	init() {
		this.carrier.publish(valueCommand(mainRoute, 'first'), () => rollbackCleanup(mainRoute))
		this.carrier.publish(valueCommand(peerRoute, 'second'), () => {
			rollbackCleanup(peerRoute)
			throw new Error('rollback disposer failed')
		})
		throw new Error('startup failed')
	}
}

it('withdraws both routes after failed startup even when a disposer throws', async () => {
	await using host = await commandHost()
	const carrier = await host.start(Carrier.nodeAddress())
	await host.commitExpectFail((change) => change.start(FailingPublisher.nodeAddress()))

	expect(carrier.resolve(mainRoute)).toBeUndefined()
	expect(carrier.resolve(peerRoute)).toBeUndefined()
	expect(rollbackCleanup.mock.calls.map(([name]) => name).sort()).toEqual([peerRoute, mainRoute])
})

type InstallerRegistration = Pick<Registration, 'name' | 'dispose'>

it('rejects an asynchronous installer and disposes both immediate and later registrations', async () => {
	await using host = await commandHost()
	const mount = host.ctx.service(Commands).createMount()
	const late = Promise.withResolvers<InstallerRegistration>()
	const immediateCleanup = vi.fn()
	const lateCleanup = vi.fn()
	let thenReads = 0
	const registration = {
		name: mainRoute,
		dispose: immediateCleanup,
		// oxlint-disable-next-line unicorn/no-thenable -- The unsupported hybrid installer has both cleanup paths.
		get then() {
			thenReads++
			return late.promise.then.bind(late.promise)
		},
	}
	expect(() =>
		mount.bind(valueCommand(mainRoute, 'ready'), { install: () => registration }),
	).toThrow(
		expect.objectContaining({
			code: 'COMMAND_CONFIG',
			details: { reason: 'async_installer', command: mainRoute },
		}),
	)
	expect(thenReads).toBe(1)
	expect(immediateCleanup).toHaveBeenCalledOnce()

	late.resolve({ name: mainRoute, dispose: lateCleanup })
	await late.promise
	expect(lateCleanup).toHaveBeenCalledOnce()
})

it('disposes rejected registrations exactly once for invalid names and thenables', async () => {
	await using host = await commandHost()
	const mount = host.ctx.service(Commands).createMount()
	const cleanup = vi.fn(() => {
		throw new Error('rollback failed')
	})
	const readThen = vi.fn(() => {
		throw new Error('then getter failed')
	})
	const self = {
		name: mainRoute,
		dispose: cleanup,
		// oxlint-disable-next-line unicorn/no-thenable -- A self-resolving installer must not be disposed twice.
		then(resolve: (registration: InstallerRegistration) => void) {
			resolve(this)
		},
	}
	const misnamed = { name: 'mount.other', dispose: cleanup }
	const unreadable = { name: mainRoute, dispose: cleanup }
	// oxlint-disable-next-line unicorn/no-thenable -- A then accessor can fail while the installer handle still owns cleanup.
	Object.defineProperty(unreadable, 'then', { get: readThen })

	for (const [registration, reason] of [
		[misnamed, 'registration_name_mismatch'],
		[unreadable, 'invalid_registration'],
		[self, 'async_installer'],
	] as const) {
		cleanup.mockClear()
		expect(() =>
			mount.bind(valueCommand(mainRoute, 'ready'), { install: () => registration }),
		).toThrow(
			expect.objectContaining({ code: 'COMMAND_CONFIG', details: { reason, command: mainRoute } }),
		)
		expect(cleanup).toHaveBeenCalledOnce()
	}
	expect(readThen).toHaveBeenCalledOnce()
})
