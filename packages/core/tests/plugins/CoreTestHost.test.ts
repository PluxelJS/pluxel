import { expect, it } from 'vitest'
import { BasePlugin, parsePluginNodeAddress, Plugin } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	createCoreTestHost,
	getCoreTestHostContext,
	PluginLifecycleAssertionError,
	type CorePluginTestChange,
} from '@pluxel/core/internal/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'

@Plugin({ forkable: true })
export class SearchIndex extends BasePlugin {}

const primary = SearchIndex.nodeAddress()
const shard = SearchIndex.nodeAddress('shard')

it('requires exact source evidence to install a node and withdraws old addresses on replacement', async () => {
	await using host = createCoreTestHost()
	const root = getCoreTestHostContext(host)
	const revisions: Array<BasePlugin | undefined> = []
	root.effects.defer(
		requirePluginService(root).watchInstance(shard, (instance) => revisions.push(instance)),
	)
	for (const detached of [parsePluginNodeAddress(shard), { ...shard }]) {
		await expect(host.add(detached as never)).rejects.toThrow(/nodeAddress|copied|detached/i)
	}
	expect(host.isRunning(shard)).toBe(false)

	class RevisedIndex extends BasePlugin {}
	lowerTestReplacement(SearchIndex, RevisedIndex, { plugin: { forkable: true } })
	await expect(
		host.commit((change) => {
			change.add(shard)
			return change.add(RevisedIndex.nodeAddress('shard'))
		}),
	).rejects.toThrow(/conflicting.*implementations/i)

	await host.commit((change) => {
		change.add(primary)
		change.add(shard)
		return change.add(shard)
	})
	const first = host.require(primary)
	const originalShard = host.require(shard)
	expect(originalShard.constructor).toBe(SearchIndex)
	expect(await host.add(primary)).toBe(first)
	await host.replaceDefinition(SearchIndex, RevisedIndex)
	for (const obsolete of [primary, shard]) {
		expect(() => host.require(obsolete)).toThrow(/stale plugin target/i)
	}
	const currentShard = RevisedIndex.nodeAddress('shard')
	const revised = host.require(currentShard)
	expect(revised).toBeInstanceOf(RevisedIndex)
	await host.remove(currentShard)
	expect(revisions).toEqual([undefined, originalShard, revised, undefined])
})

it('discards an invalid draft and rejects commands retained past the callback', async () => {
	await using host = createCoreTestHost()
	await expect(
		host.commit((async (draft: CorePluginTestChange) => draft.add(primary)) as never),
	).rejects.toThrow(/synchronous/i)
	await expect(host.commit(() => undefined)).rejects.toThrow(/at least one change/i)
	await expect(
		host.commit((change) => {
			change.add(primary)
			return change.remove(primary)
		}),
	).rejects.toThrow(/conflicting/i)
	expect(host.isRunning(primary)).toBe(false)

	let retained: CorePluginTestChange | undefined
	await host.commit((change) => {
		retained = change
		return change.add(primary)
	})
	expect(() => retained!.remove(primary)).toThrow(/cannot escape/i)
	expect(host.isRunning(primary)).toBe(true)
})

let loadStarted: ReturnType<typeof Promise.withResolvers<void>>
let finishLoad: ReturnType<typeof Promise.withResolvers<void>>
let readerReleased: boolean

@Plugin()
export class SnapshotReader extends BasePlugin {
	protected override async init() {
		loadStarted.resolve()
		await finishLoad.promise
		return () => {
			readerReleased = true
		}
	}
}

it('closes the test host after its admitted load and rejects later operations', async () => {
	loadStarted = Promise.withResolvers()
	finishLoad = Promise.withResolvers()
	readerReleased = false
	await using host = createCoreTestHost()
	const reader = SnapshotReader.nodeAddress()
	const loading = host.add(reader)
	let releasedAtClose: Promise<boolean> | undefined
	try {
		await loadStarted.promise
		expect(() => host.isRunning(reader)).toThrow(/in progress/i)
		await expect(host.add(primary)).rejects.toThrow(/literal batch|commit\(callback\)/i)
		const closing = host.dispose()
		releasedAtClose = closing.then(() => readerReleased)
		expect(host[Symbol.asyncDispose]()).toBe(closing)
		await expect(host.add(primary)).rejects.toThrow(/closing or closed/i)
	} finally {
		finishLoad.resolve()
		await Promise.all([loading, host.dispose()])
	}
	expect(await releasedAtClose).toBe(true)
	expect(() => host.isRunning(reader)).toThrow(/closing or closed/i)
})

@Plugin()
export class OfflineReader extends BasePlugin {
	protected override init() {
		throw new Error('snapshot unavailable')
	}
}

it('reports strict add failure with a portable lifecycle summary', async () => {
	await using host = createCoreTestHost()
	const root = getCoreTestHostContext(host)
	const reports: string[] = []
	root.effects.defer(
		requirePluginService(root).subscribeCommitted((summary) => {
			reports.push(...summary.lifecycleReport.issues.map((issue) => issue.kind))
		}),
	)
	const reader = OfflineReader.nodeAddress()
	const failure = await host.add(reader).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(PluginLifecycleAssertionError)
	expect(failure).toMatchObject({
		code: 'PLUGIN_TEST_LIFECYCLE_ASSERTION_FAILED',
		operation: 'add',
	})
	const { summary } = failure as PluginLifecycleAssertionError
	const [issue] = summary.lifecycleReport.issues
	expect(issue).toMatchObject({
		kind: 'start-failed',
		phase: 'start',
		message: 'snapshot unavailable',
	})
	expect(issue?.plugin).toEqual(parsePluginNodeAddress(reader))
	expect(Object.isFrozen(summary.lifecycleReport.issues)).toBe(true)
	expect(reports).toEqual(['start-failed'])
	expect(host.isRunning(reader)).toBe(false)
})
