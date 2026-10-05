import { expect, it } from 'vitest'
import { createHost } from '@pluxel/host'
import {
	attachHostVitePlugins,
	type HostViteAttachment,
	type HostViteCandidate,
} from '../src/attachments'

async function attach(attachments: HostViteAttachment[], cleanups: Array<() => unknown> = []) {
	return attachHostVitePlugins(
		{ ctx: { effects: { defer: (cleanup: () => unknown) => cleanups.push(cleanup) } } } as never,
		{
			config: {
				plugins: attachments.map((attachment, index) => ({
					name: `test:${index}`,
					api: { pluxelHost: { attach: () => attachment } },
				})),
			},
		} as never,
		{} as never,
		{ plugins: [], modules: [], definitions: [] },
		'development',
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
		const candidate = await controller.prepareCandidate({
			plugins: [],
			modules: [],
			definitions: [],
		})
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
	await expect(
		controller.prepareCandidate({ plugins: [], modules: [], definitions: [] }),
	).rejects.toMatchObject({
		errors: [primary, cleanup],
		cause: primary,
	})
	expect(calls).toEqual([2, 1])
})

it('registers attachment cleanup before rejecting malformed callback fields', async () => {
	const cleanups: Array<() => unknown> = []
	let disposed = false
	await expect(
		attach(
			[
				{
					dispose: () => {
						disposed = true
					},
					tracks: false,
				} as never,
			],
			cleanups,
		),
	).rejects.toThrow('test:0: attachment tracks and prepareCandidate must be functions')
	await Promise.all(cleanups.map((cleanup) => cleanup()))
	expect(disposed).toBe(true)
})

it('keeps admitted attachment methods and their owner after the returned object changes', async () => {
	const cleanups: Array<() => unknown> = []
	const calls: string[] = []
	const attachment = {
		owner: 'original',
		dispose() {
			calls.push(`${this.owner}:dispose`)
		},
		tracks() {
			calls.push(`${this.owner}:tracks`)
			return true
		},
		async prepareCandidate(): Promise<HostViteCandidate> {
			calls.push(`${this.owner}:prepare`)
			return {
				commit() {
					calls.push('commit')
				},
				rollback() {},
			}
		},
	}
	const controller = await attach([attachment], cleanups)
	attachment.dispose = () => {
		calls.push('changed:dispose')
	}
	attachment.tracks = () => false
	attachment.prepareCandidate = async () => {
		throw new Error('CHANGED_PREPARATION_CALLED')
	}
	expect(controller.tracks('/app/source.mjs')).toBe(true)
	const candidate = await controller.prepareCandidate({ plugins: [], modules: [], definitions: [] })
	candidate.commit()
	await Promise.all(cleanups.map((cleanup) => cleanup()))
	expect(calls).toEqual(['original:tracks', 'original:prepare', 'commit', 'original:dispose'])
})

it.each(['commit', 'rollback'] as const)(
	'keeps prepared %s bound to its admitted operation and owner',
	async (action) => {
		const calls: string[] = []
		const owned = {
			owner: 'original',
			commit(): undefined {
				calls.push(`${this.owner}:commit`)
			},
			rollback(): undefined {
				calls.push(`${this.owner}:rollback`)
			},
		}
		const controller = await attach([{ prepareCandidate: async () => owned }])
		const candidate = await controller.prepareCandidate({
			plugins: [],
			modules: [],
			definitions: [],
		})
		owned.commit = (): undefined => {
			calls.push('changed:commit')
		}
		owned.rollback = (): undefined => {
			calls.push('changed:rollback')
		}
		candidate[action]()
		expect(calls).toEqual([`original:${action}`])
	},
)

it.each([undefined, null, 0, 1, 'true', {}])(
	'rejects non-boolean tracks result %s',
	async (result) => {
		const controller = await attach([{ tracks: () => result } as never])
		expect(() => controller.tracks('/app/source.mjs')).toThrow(
			'test:0: tracks(/app/source.mjs) must return a boolean synchronously',
		)
	},
)

it('rejects asynchronous tracks and preserves its rejection through Host cleanup', async () => {
	const failure = new Error('ASYNCHRONOUS_TRACKS_FAILED')
	const release = Promise.withResolvers<void>()
	const host = await createHost({ plugins: [], state: { mode: 'memory' } })
	try {
		const controller = await attachHostVitePlugins(
			host,
			{
				config: {
					plugins: [
						{
							name: 'test:async-tracks',
							api: {
								pluxelHost: {
									attach: () => ({
										async tracks() {
											await release.promise
											throw failure
										},
									}),
								},
							},
						},
					],
				},
			} as never,
			{} as never,
			{ plugins: [], modules: [], definitions: [] },
			'development',
		)
		expect(() => controller.tracks('/app/source.mjs')).toThrow(
			'test:async-tracks: tracks(/app/source.mjs) must return a boolean synchronously',
		)
		const closing = host.close()
		let closed = false
		void closing.then(
			() => {
				closed = true
				return undefined
			},
			() => {
				closed = true
				return undefined
			},
		)
		await Promise.resolve()
		expect(closed).toBe(false)
		release.resolve()
		const flatten = (error: unknown): unknown[] =>
			error instanceof AggregateError ? [error, ...error.errors.flatMap(flatten)] : [error]
		const results = await Promise.allSettled([closing])
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? flatten(result.reason) : [],
		)
		expect(failures).toContain(failure)
	} finally {
		release.resolve()
		await Promise.allSettled([host.close()])
	}
})

it.each([undefined, null, false, {}, { commit() {} }])(
	'rejects malformed prepared candidate %s and rolls back earlier preparation',
	async (invalid) => {
		const calls: string[] = []
		const controller = await attach([
			{
				async prepareCandidate() {
					return {
						commit() {},
						rollback() {
							calls.push('rollback')
						},
					}
				},
			},
			{
				async prepareCandidate() {
					return invalid
				},
			} as never,
		])
		await expect(
			controller.prepareCandidate({ plugins: [], modules: [], definitions: [] }),
		).rejects.toThrow('test:1: prepareCandidate must return synchronous commit() and rollback()')
		expect(calls).toEqual(['rollback'])
	},
)

it('rolls back a malformed candidate when its rollback operation is available', async () => {
	let disposed = false
	const controller = await attach([
		{
			async prepareCandidate() {
				return {
					rollback() {
						disposed = true
					},
				}
			},
		} as never,
	])
	await expect(
		controller.prepareCandidate({ plugins: [], modules: [], definitions: [] }),
	).rejects.toThrow('prepareCandidate must return synchronous commit() and rollback()')
	expect(disposed).toBe(true)
})

it.each(['commit', 'rollback'] as const)(
	'rejects asynchronous %s and preserves its rejection through Host cleanup',
	async (action) => {
		const primary = new Error('asynchronous settlement failed')
		const calls: string[] = []
		const cleanups: Array<() => unknown> = []
		const controller = await attach(
			[
				{
					async prepareCandidate() {
						return {
							[action]() {
								calls.push('invalid')
								return Promise.reject(primary)
							},
							[action === 'commit' ? 'rollback' : 'commit']() {},
						}
					},
				} as never,
				{
					async prepareCandidate() {
						return {
							commit() {
								calls.push('remaining')
							},
							rollback() {
								calls.push('remaining')
							},
						}
					},
				},
			],
			cleanups,
		)
		const candidate = await controller.prepareCandidate({
			plugins: [],
			modules: [],
			definitions: [],
		})
		expect(() => candidate[action]()).toThrow(
			expect.objectContaining({
				errors: [
					expect.objectContaining({
						message: expect.stringContaining(`${action} must return undefined synchronously`),
					}),
				],
			}),
		)
		expect(calls).toEqual(action === 'commit' ? ['invalid', 'remaining'] : ['remaining', 'invalid'])
		const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
		expect(results).toEqual([{ status: 'rejected', reason: primary }])
		candidate.commit()
		candidate.rollback()
		expect(calls).toHaveLength(2)
	},
)
