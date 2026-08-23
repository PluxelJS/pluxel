import { describe, expect, it, vi } from 'vitest'
import { createLiveQueryClient } from '../../src/workbench/ui-runtime'
import type { WorkbenchLiveQueryResource } from '../../src/workbench/contracts'

type Row = { id: string; value: string }

const contract: WorkbenchLiveQueryResource<undefined, Row> = {
	kind: 'liveQuery',
	key: 'id',
	row: {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate(value) {
				return value && typeof value === 'object' && typeof (value as Row).id === 'string'
					? { value: value as Row }
					: { issues: ['invalid row'] }
			},
		},
	},
}

describe('browser liveQuery runtime', () => {
	it('applies ordered patches, refreshes gaps/invalid patches, and keeps stale rows', async () => {
		let emit: (message: { event: string; payload: unknown }) => void = () => {}
		let failStream: () => void = () => {}
		const close = vi.fn()
		const refreshes = [
			{ generation: 'refresh-gap', revision: 7, rows: [{ id: 'c', value: '3' }] },
			{ generation: 'refresh-invalid', revision: 9, rows: [{ id: 'd', value: '4' }] },
		]
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify(refreshes.shift()), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		)
		const client = createLiveQueryClient(
			{
				fetch,
				workbench: {
					liveQueryUrl: () => '/snapshot',
					modelEventsUrl: () => '/events',
				},
				createSse: () => ({
					onAny(listener: typeof emit) {
						emit = listener
						return () => {}
					},
					onError(listener: () => void) {
						failStream = listener
						return () => {}
					},
					close,
				}),
			} as any,
			'grant',
			contract,
		)
		const listener = vi.fn()
		const unsubscribe = client.subscribe(listener)

		emit({
			event: 'snapshot',
			payload: {
				generation: 'initial',
				revision: 1,
				rows: [
					{ id: 'a', value: '1' },
					{ id: 'b', value: '1' },
				],
			},
		})
		await vi.waitFor(() => expect(client.getSnapshot().state).toBe('ready'))

		emit({
			event: 'patch',
			payload: {
				generation: 'initial',
				fromRevision: 1,
				toRevision: 2,
				upserted: [{ id: 'b', value: '2' }],
				removed: [],
				order: ['b', 'a'],
			},
		})
		await vi.waitFor(() => expect(client.getSnapshot().revision).toBe(2))
		expect(client.getSnapshot().rows).toEqual([
			{ id: 'b', value: '2' },
			{ id: 'a', value: '1' },
		])

		emit({
			event: 'patch',
			payload: {
				generation: 'initial',
				fromRevision: 4,
				toRevision: 5,
				upserted: [],
				removed: [],
				order: [],
			},
		})
		await vi.waitFor(() => expect(client.getSnapshot().revision).toBe(7))
		expect(client.getSnapshot().rows).toEqual([{ id: 'c', value: '3' }])

		emit({
			event: 'patch',
			payload: {
				generation: 'refresh-gap',
				fromRevision: 7,
				toRevision: 8,
				upserted: [],
				removed: [],
				order: ['c', 'c'],
			},
		})
		await vi.waitFor(() => expect(client.getSnapshot().revision).toBe(9))
		expect(fetch).toHaveBeenCalledTimes(2)

		failStream()
		expect(client.getSnapshot()).toMatchObject({
			state: 'stale',
			rows: [{ id: 'd', value: '4' }],
			revision: 9,
		})

		unsubscribe()
		expect(close).toHaveBeenCalledOnce()
	})
})
