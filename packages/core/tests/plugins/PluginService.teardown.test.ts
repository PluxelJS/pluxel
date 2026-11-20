import {
	BasePlugin,
	Plugin,
	assertPluginLifecycleIssue,
	createCoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'

let cleanupEntered: ReturnType<typeof Promise.withResolvers<void>>
let releaseCleanup: ReturnType<typeof Promise.withResolvers<void>>
const lifecycle: string[] = []

@Plugin()
class Provider extends BasePlugin {
	override init() {
		lifecycle.push('provider:init')
		return () => {
			lifecycle.push('provider:stop')
		}
	}
}

@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly provider: Provider) {
		super()
	}

	override init() {
		lifecycle.push('consumer:init')
		return async () => {
			cleanupEntered.resolve()
			await releaseCleanup.promise
			lifecycle.push('consumer:stop')
			this.ctx.effects.defer(() => {
				lifecycle.push('consumer:reentrant')
			})
			throw new Error('consumer cleanup failed')
		}
	}
}

it('leaves a rejected graph running and drains a committed cascade consumer first', async () => {
	cleanupEntered = Promise.withResolvers()
	releaseCleanup = Promise.withResolvers()
	lifecycle.length = 0
	await using host = createCoreInternalTestHost()
	host.add([Consumer, Provider])
	const first = await host.commit()
	const consumer = host.require(Consumer)
	expect(lifecycle).toEqual(['provider:init', 'consumer:init'])

	host.remove(Provider, { cascadeDependents: false })
	await expect(host.commit()).rejects.toMatchObject({
		issues: [expect.objectContaining({ kind: 'MissingDependency' })],
	})
	expect(host.last()).toBe(first)
	expect(host.require(Consumer)).toBe(consumer)
	expect(host.isRunning(Provider)).toBe(true)
	expect(lifecycle).toEqual(['provider:init', 'consumer:init'])

	host.remove(Provider)
	const removing = host.commitAllowFail()
	try {
		await cleanupEntered.promise
		expect(lifecycle).toEqual(['provider:init', 'consumer:init'])
	} finally {
		releaseCleanup.resolve()
		await removing
	}
	assertPluginLifecycleIssue(await removing, Consumer, {
		kind: 'drain-failed',
		message: 'consumer cleanup failed',
	})
	expect(lifecycle.slice(2)).toEqual(['consumer:stop', 'consumer:reentrant', 'provider:stop'])
	expect(host.has(Consumer)).toBe(false)
	expect(host.has(Provider)).toBe(false)
})

let drainTogether: () => Promise<void>

@Plugin({ forkable: true })
class IndependentWorker extends BasePlugin {
	override init() {
		return drainTogether
	}
}

it('drains independent generations in parallel within the Host stop limit', async () => {
	const twoStarted = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let active = 0
	let finished = 0
	drainTogether = async () => {
		if (++active === 2) twoStarted.resolve()
		await release.promise
		active--
		finished++
	}
	await using host = createCoreInternalTestHost({ execution: { stopConcurrency: 2 } })
	const workers = ['east', 'west', 'south'].map((fork) => host.fork(IndependentWorker, fork))
	await host.commit()

	host.remove(workers)
	const removing = host.commit()
	try {
		await twoStarted.promise
		expect(active).toBe(2)
	} finally {
		release.resolve()
		await removing
	}
	expect(finished).toBe(workers.length)
})
