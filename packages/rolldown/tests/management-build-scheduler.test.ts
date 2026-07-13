import { describe, expect, it } from 'vitest'

import {
	runManagementFederationBuild,
	runManagementOutputTransaction,
} from '../src/management/build-scheduler'

const pause = (milliseconds = 20) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

describe('management build scheduler', () => {
	it('treats the Federation builder as a process-wide exclusive resource', async () => {
		let active = 0
		let maximumActive = 0

		await Promise.all(
			Array.from({ length: 3 }, () =>
				runManagementFederationBuild(async () => {
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

		expect(maximumActive).toBe(1)
	})

	it('continues scheduling after a failed Federation build', async () => {
		await expect(
			runManagementFederationBuild(async () => {
				throw new Error('expected build failure')
			}),
		).rejects.toThrow('expected build failure')
		await expect(runManagementFederationBuild(async () => {})).resolves.toBeUndefined()

		await expect(
			runManagementOutputTransaction('/tmp/pluxel-failed-target', async () => {
				throw new Error('expected transaction failure')
			}),
		).rejects.toThrow('expected transaction failure')
		await expect(
			runManagementOutputTransaction('/tmp/pluxel-failed-target', async () => {}),
		).resolves.toBeUndefined()
	})

	it('serializes one output target without blocking independent targets', async () => {
		let sameTargetActive = 0
		let sameTargetMaximum = 0
		await Promise.all(
			Array.from({ length: 2 }, () =>
				runManagementOutputTransaction('/tmp/pluxel-same-target', async () => {
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
				runManagementOutputTransaction(`/tmp/pluxel-target-${target}`, async () => {
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
