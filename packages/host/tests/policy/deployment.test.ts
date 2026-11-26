import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'
import { createHost, defineHostService } from '../../src/index'
import { createDocumentStorage } from '../support/document-storage'

let drainArchive: (() => Promise<void>) | undefined

@Plugin({ forkable: true })
class Archive extends BasePlugin {
	init() {
		return drainArchive
	}

	location(): string {
		const address = this.ctx.pluginInfo.nodeAddress
		return address.variant === 'fork' ? address.forkId : 'default'
	}
}

const destinations: string[] = []

@Plugin()
class Reports extends BasePlugin {
	constructor(private readonly archive: Archive) {
		super()
	}

	init() {
		destinations.push(this.archive.location())
	}
}

it('carries startup choices to the next Host while session Stop stays local', async () => {
	const disk = createDocumentStorage()
	const address = Archive.nodeAddress()
	const options = {
		plugins: [{ plugin: Archive }],
		config: { document: false as const },
		policy: {
			document: { storage: () => disk },
			execution: { startConcurrency: 1 },
			modes: { startConcurrency: 'saved-first' as const },
		},
	}
	await using host = await createHost(options)
	await host.start()
	await host.startNode(address)
	await expect(host.setAutoStart(address, true)).resolves.toMatchObject({
		writtenFields: ['autoStart'],
	})
	await host.stopNode(address)
	await expect(host.policy.patch({ startConcurrency: 2 })).resolves.toMatchObject({
		ok: true,
		application: 'requires-host-recreation',
		appliedExecution: { startConcurrency: 1 },
	})
	const started: string[] = []
	const Replacement = lowerTestReplacement(
		Archive,
		class extends Archive {
			override init() {
				started.push('new archive')
				return super.init()
			}
		},
		{ plugin: { forkable: true } },
	)
	const selection = [Replacement]
	const refreshing = host.updateCatalog(selection)
	selection.length = 0
	await refreshing
	await expect(host.status()).resolves.toMatchObject({
		statuses: [{ address, autoStart: true, lifecycleState: 'stopped' }],
	})
	expect(started).toEqual([])
	await host.startNode(address)
	expect(started).toEqual(['new archive'])
	await host.stopNode(address)
	await host.close()

	await using next = await createHost(options)
	await next.start()
	await expect(next.policy.get()).resolves.toMatchObject({
		ok: true,
		application: 'applied',
		appliedExecution: { startConcurrency: 2 },
	})
	await expect(next.status()).resolves.toMatchObject({
		statuses: [{ address, autoStart: true, lifecycleState: 'running' }],
	})
})

it('allows saving a shadowed choice but rejects an action that promises to change effective policy', async () => {
	const address = Archive.nodeAddress()
	await using host = await createHost({
		plugins: [{ plugin: Archive, autoStart: false, policyMode: 'declared-first' }],
		policy: { document: false },
	})
	await host.start()
	const choice = { node: address, autoStart: true }
	await expect(host.policy.patch({ autoStart: [choice] })).resolves.toMatchObject({
		ok: true,
		managedInput: { autoStart: [choice] },
		effective: { autoStart: [] },
	})
	await expect(host.setAutoStart(address, true)).rejects.toMatchObject({ code: 'policy_shadowed' })
	await expect(host.setAutoStart(address, false)).resolves.toMatchObject({
		persistence: { status: 'unchanged' },
	})
	await host.startNode(address)
	await expect(host.status()).resolves.toMatchObject({
		statuses: [{ address, autoStart: false, lifecycleState: 'running' }],
	})
	await expect(host.policy.reset([{ field: 'autoStart', node: address }])).resolves.toMatchObject({
		ok: true,
		managedInput: {},
		effective: { autoStart: [] },
	})
})

it('keeps a stored fork selection through removal and reappearance of its provider definition', async () => {
	const consumer = parsePluginNodeAddress(Reports.nodeAddress())
	const provider = parsePluginNodeAddress(Archive.nodeAddress('regional'))
	const requirement = Archive.address()
	const disk = createDocumentStorage()
	destinations.length = 0
	await using host = await createHost({
		plugins: [
			{ plugin: Reports, autoStart: true },
			{ plugin: Archive, forks: { regional: {} } },
		],
		policy: { document: { storage: () => disk } },
	})
	await host.start()
	expect(await disk.getText('state.json')).toBeUndefined()
	await expect(host.setDependencyOverride(consumer, requirement, provider)).resolves.toMatchObject({
		writtenFields: ['dependencyOverrides'],
	})
	const saved = await disk.getText('state.json')
	expect(destinations).toEqual(['default', 'regional'])
	await host.updateCatalog([Reports])
	await expect(host.status()).resolves.toMatchObject({
		statuses: expect.arrayContaining([
			expect.objectContaining({
				address: consumer,
				desiredState: 'running',
				lifecycleState: 'stopped',
			}),
		]),
	})
	await expect(host.policy.get()).resolves.toMatchObject({
		managedInput: {
			dependencyOverrides: [
				{ consumerAddress: consumer, requirementAddress: requirement, providerAddress: provider },
			],
		},
	})
	await host.updateCatalog([Reports, Archive])
	expect(destinations).toEqual(['default', 'regional', 'regional'])
	expect(await disk.getText('state.json')).toBe(saved)
})

export abstract class Mailbox extends BasePlugin {
	abstract addressLabel(): string
}

@Plugin(Mailbox)
class EastMailbox extends Mailbox {
	addressLabel() {
		return 'east'
	}
}

@Plugin(Mailbox)
class WestMailbox extends Mailbox {
	addressLabel() {
		return 'west'
	}
}

const mailboxUsed: string[] = []

@Plugin()
class Digest extends BasePlugin {
	constructor(private readonly mailbox: Mailbox) {
		super()
	}
	init() {
		mailboxUsed.push(this.mailbox.addressLabel())
	}
}

it.each([false, true])(
	'infers a provider and uses the remaining implementation without saving a selection (readOnly=%s)',
	async (readOnly) => {
		const disk = createDocumentStorage()
		mailboxUsed.length = 0
		await using host = await createHost({
			plugins: [
				{ plugin: WestMailbox },
				{ plugin: Digest, autoStart: true },
				{ plugin: EastMailbox },
			],
			policy: { document: { storage: () => disk, readOnly } },
		})
		await host.start()
		expect(mailboxUsed).toEqual(['east'])
		await host.updateCatalog([Digest, WestMailbox])
		expect(mailboxUsed).toEqual(['east', 'west'])
		expect(await disk.getText('state.json')).toBeUndefined()
	},
)

it('rechecks a queued startup choice and fork request after their catalog entry is removed', async () => {
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	await using host = await createHost({
		plugins: [{ plugin: Archive }],
		policy: { document: false },
	})
	const address = Archive.nodeAddress()
	drainArchive = async () => {
		entered.resolve()
		await release.promise
	}
	try {
		await host.startNode(address)
		const removing = host.updateCatalog([])
		await entered.promise
		const choosing = host.setAutoStart(address, true).catch((error: unknown) => error)
		const creating = host.forks.ensure(Archive.nodeAddress('late'))
		release.resolve()
		await removing
		expect(await choosing).toMatchObject({ code: 'node_unavailable' })
		await expect(creating).resolves.toMatchObject({ ok: false, code: 'definition_unavailable' })
		await expect(host.policy.get()).resolves.toMatchObject({ managedInput: {} })
	} finally {
		drainArchive = undefined
		release.resolve()
	}
})

it('protects referenced fork metadata and serializes later overrides behind its removal', async () => {
	const fork = Archive.nodeAddress('retired')
	const consumer = Reports.nodeAddress()
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let cleanups = 0
	await using host = await createHost({
		plugins: [{ plugin: Archive }, { plugin: Reports }],
		policy: { document: false },
		services: [
			defineHostService({
				name: 'fork-metadata',
				provides: [],
				async removeNodeMetadata() {
					cleanups++
					entered.resolve()
					await release.promise
				},
			}),
		],
	})
	await expect(host.forks.ensure(fork)).resolves.toMatchObject({ ok: true })
	const bind = () => host.setDependencyOverride(consumer, Archive.address(), fork)
	try {
		const initial = bind()
		const refused = host.forks.remove(fork)
		await initial
		await expect(refused).resolves.toMatchObject({
			ok: false,
			code: 'fork_referenced',
			state: 'unchanged',
			references: [{ consumer: parsePluginNodeAddress(consumer), requirement: Archive.address() }],
		})
		expect(cleanups).toBe(0)
		await host.setDependencyOverride(consumer, Archive.address(), null)
		const removing = host.forks.remove(fork)
		await entered.promise
		const stale = bind().catch((error: unknown) => error)
		release.resolve()
		await expect(removing).resolves.toMatchObject({ ok: true, status: 'removed' })
		expect(await stale).toMatchObject({ code: 'provider_unavailable' })
		expect(cleanups).toBe(1)
	} finally {
		release.resolve()
	}
})

it('rejects a replacement that would invalidate a saved fork and leaves it startable', async () => {
	const fork = Archive.nodeAddress('existing')
	const Next = lowerTestReplacement(Archive, class extends Archive {})
	await using host = await createHost({
		plugins: [{ plugin: Archive }],
		policy: { document: false },
	})
	await expect(host.forks.ensure(fork)).resolves.toMatchObject({ ok: true })
	await expect(host.updateCatalog([Next])).rejects.toMatchObject({ code: 'graph_rejected' })
	await host.startNode(fork)
	const status = await host.status()
	expect(status.statuses).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ address: parsePluginNodeAddress(fork), lifecycleState: 'running' }),
		]),
	)
	await expect(host.forks.remove(fork)).resolves.toMatchObject({ ok: true, status: 'removed' })
	await host.updateCatalog([Next])
	await expect(host.forks.ensure(Archive.nodeAddress('late'))).resolves.toMatchObject({
		ok: false,
		code: 'not_forkable',
	})
})
