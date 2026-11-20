import { describe, expect, it } from 'vitest'

import {
	runWorkbenchFederationBuild,
	runWorkbenchOutputTransaction,
} from '../src/workbench/build-scheduler'

describe('workbench build scheduler', () => {
	it('admits at most two same-application builds at a time', async () => {
		const admitted = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const started: number[] = []
		const builds = Promise.all(
			[0, 1, 2].map((index) =>
				runWorkbenchFederationBuild('/application/a', async () => {
					started.push(index)
					if (index === 1) admitted.resolve()
					await release.promise
				}),
			),
		)
		try {
			await admitted.promise
			expect(started).toEqual([0, 1])
		} finally {
			release.resolve()
			await builds
		}
		expect(started).toEqual([0, 1, 2])
	})

	it('drains the current root before admitting the waiting cohort after failure', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const failure = new Error('expected Federation failure')
		const order: string[] = []
		const builds = Promise.allSettled([
			runWorkbenchFederationBuild('/application/a', async () => {
				order.push('a-start')
				entered.resolve()
				await release.promise
				order.push('a-fail')
				throw failure
			}),
			runWorkbenchFederationBuild('/application/b', async () => order.push('b')),
			runWorkbenchFederationBuild('/application/a', async () => order.push('a-later')),
		])
		try {
			await entered.promise
			expect(order).toEqual(['a-start'])
		} finally {
			release.resolve()
			await builds
		}
		const [failed, waiting, later] = await builds
		expect(failed).toEqual({ status: 'rejected', reason: failure })
		expect([waiting.status, later.status]).toEqual(['fulfilled', 'fulfilled'])
		expect(order).toEqual(['a-start', 'a-fail', 'b', 'a-later'])
	})

	it('queues the same target through failure while permitting independent outputs', async () => {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const failure = new Error('expected transaction failure')
		const order: string[] = []
		const first = runWorkbenchOutputTransaction('/tmp/pluxel-output/a', async () => {
			order.push('a-start')
			entered.resolve()
			await release.promise
			order.push('a-fail')
			throw failure
		})
		const next = runWorkbenchOutputTransaction('/tmp/pluxel-output/a', async () =>
			order.push('a-later'),
		)
		const independent = runWorkbenchOutputTransaction('/tmp/pluxel-output/b', async () =>
			order.push('b'),
		)
		const transactions = Promise.allSettled([first, next, independent])
		try {
			await Promise.all([entered.promise, independent])
			expect(order.toSorted()).toEqual(['a-start', 'b'])
		} finally {
			release.resolve()
			await transactions
		}
		const [failed] = await transactions
		expect(failed).toEqual({ status: 'rejected', reason: failure })
		expect(order.slice(2)).toEqual(['a-fail', 'a-later'])
	})
})
