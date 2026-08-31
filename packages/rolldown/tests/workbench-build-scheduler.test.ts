import { describe, expect, it } from 'vitest'

import {
	runWorkbenchFederationBuild,
	runWorkbenchOutputTransaction,
} from '../src/workbench/build-scheduler'

const pause = (milliseconds = 20) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

describe('workbench build scheduler', () => {
	it('bounds same-application builds and never overlaps different application roots', async () => {
		let active = 0
		let maximum = 0
		let activeRoot: string | undefined
		let crossedRoots = false
		const run = (root: string) =>
			runWorkbenchFederationBuild(root, async () => {
				if (activeRoot !== undefined && activeRoot !== root) crossedRoots = true
				activeRoot = root
				active += 1
				maximum = Math.max(maximum, active)
				try {
					await pause()
				} finally {
					active -= 1
					if (active === 0) activeRoot = undefined
				}
			})

		await Promise.all([run('/application/a'), run('/application/b'), run('/application/a')])
		expect(crossedRoots).toBe(false)
		expect(maximum).toBe(2)
	})

	it('continues with the next application root after a Federation build fails', async () => {
		await expect(
			runWorkbenchFederationBuild('/application/failure', async () => {
				throw new Error('expected Federation failure')
			}),
		).rejects.toThrow('expected Federation failure')
		await expect(
			runWorkbenchFederationBuild('/application/recovery', async () => 'recovered'),
		).resolves.toBe('recovered')
	})

	it('continues scheduling after a failed Federation build', async () => {
		await expect(
			runWorkbenchOutputTransaction('/tmp/pluxel-failed-target', async () => {
				throw new Error('expected transaction failure')
			}),
		).rejects.toThrow('expected transaction failure')
		await expect(
			runWorkbenchOutputTransaction('/tmp/pluxel-failed-target', async () => {}),
		).resolves.toBeUndefined()
	})

	it('serializes one output target without blocking independent targets', async () => {
		let sameTargetActive = 0
		let sameTargetMaximum = 0
		await Promise.all(
			Array.from({ length: 2 }, () =>
				runWorkbenchOutputTransaction('/tmp/pluxel-same-target', async () => {
					sameTargetActive += 1
					sameTargetMaximum = Math.max(sameTargetMaximum, sameTargetActive)
					try {
						await pause()
					} finally {
						sameTargetActive -= 1
					}
				}),
			),
		)
		expect(sameTargetMaximum).toBe(1)

		let differentTargetActive = 0
		let differentTargetMaximum = 0
		await Promise.all(
			['a', 'b'].map((target) =>
				runWorkbenchOutputTransaction(`/tmp/pluxel-target-${target}`, async () => {
					differentTargetActive += 1
					differentTargetMaximum = Math.max(differentTargetMaximum, differentTargetActive)
					try {
						await pause()
					} finally {
						differentTargetActive -= 1
					}
				}),
			),
		)
		expect(differentTargetMaximum).toBe(2)
	})
})
