import { describe, expect, it } from 'vitest'

import {
	runWorkbenchIsolatedBuild,
	runWorkbenchOutputTransaction,
	WORKBENCH_ISOLATED_BUILD_CONCURRENCY,
} from '../src/workbench/build-scheduler'

const pause = (milliseconds = 20) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

describe('workbench build scheduler', () => {
	it('allows bounded parallel producer compilers', async () => {
		let active = 0
		let maximumActive = 0

		await Promise.all(
			Array.from({ length: 3 }, () =>
				runWorkbenchIsolatedBuild(async () => {
					active += 1
					maximumActive = Math.max(maximumActive, active)
					try {
						await pause()
					} finally {
						active -= 1
					}
				}),
			),
		)

		expect(maximumActive).toBe(WORKBENCH_ISOLATED_BUILD_CONCURRENCY)
	})

	it('continues scheduling after a failed Federation build', async () => {
		await expect(
			runWorkbenchIsolatedBuild(async () => {
				throw new Error('expected build failure')
			}),
		).rejects.toThrow('expected build failure')
		await expect(runWorkbenchIsolatedBuild(async () => {})).resolves.toBeUndefined()

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
