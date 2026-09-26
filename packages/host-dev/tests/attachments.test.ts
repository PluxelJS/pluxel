import { expect, it } from 'vitest'
import { attachHostDevelopmentPlugins, type HostDevelopmentAttachment } from '../src/attachments'

async function attach(attachments: HostDevelopmentAttachment[]) {
	return attachHostDevelopmentPlugins(
		{} as never,
		{
			config: {
				plugins: attachments.map((attachment) => ({
					api: { pluxelHost: { attach: () => attachment } },
				})),
			},
		} as never,
		{} as never,
		{ modules: [], definitions: [] },
	)
}

it.each(['commit', 'rollback'] as const)(
	'settles every candidate once when %s throws',
	async (action) => {
		const calls: string[] = []
		const failures = [new Error('first'), new Error('second')]
		const controller = await attach(
			[0, 1, 2].map((index) => ({
				async prepareCandidate() {
					return {
						commit() {
							calls.push(`commit:${index}`)
							if (index < 2) throw failures[index]
						},
						rollback() {
							calls.push(`rollback:${index}`)
							if (index < 2) throw failures[index]
						},
					}
				},
			})),
		)
		const candidate = await controller.prepareCandidate({ modules: [], definitions: [] })
		const orderedFailures = action === 'commit' ? failures : failures.toReversed()
		expect(() => candidate[action]()).toThrow(
			expect.objectContaining({
				errors: orderedFailures,
				cause: orderedFailures[0],
			}),
		)
		expect(calls).toEqual(
			(action === 'commit' ? [0, 1, 2] : [2, 1, 0]).map((index) => `${action}:${index}`),
		)
		candidate.commit()
		candidate.rollback()
		expect(calls).toHaveLength(3)
	},
)

it('rolls back every prepared candidate and preserves the preparation error', async () => {
	const calls: number[] = []
	const primary = new Error('prepare failed')
	const cleanup = new Error('rollback failed')
	const controller = await attach([
		{
			async prepareCandidate() {
				return {
					commit() {},
					rollback() {
						calls.push(1)
					},
				}
			},
		},
		{
			async prepareCandidate() {
				return {
					commit() {},
					rollback() {
						calls.push(2)
						throw cleanup
					},
				}
			},
		},
		{
			async prepareCandidate() {
				throw primary
			},
		},
	])
	await expect(controller.prepareCandidate({ modules: [], definitions: [] })).rejects.toMatchObject(
		{
			errors: [primary, cleanup],
			cause: primary,
		},
	)
	expect(calls).toEqual([2, 1])
})
