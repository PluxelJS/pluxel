import type { EmitSettledRecord } from 'eventure'
import { Eventure, EvtChannel } from 'eventure'
import { beforeEach, describe, expect, it } from 'vitest'

import { silentLogger } from './testUtils'

type Result = string | Error
type Listener = (value: string) => Result | Promise<Result>

type StringEventMap = { ev: Listener }
type ChannelEvent = Listener

type EmitHarness = {
	name: string
	create: () => {
		on: (listener: Listener) => void
		emitAll: (value: string) => Promise<Result[]>
		emitSettled: (
			value: string,
		) => Promise<EmitSettledRecord<Listener, Result>[]>
	}
}

const harnesses: EmitHarness[] = [
	{
		name: 'Eventure',
		create: () => {
			const emitter = new Eventure<StringEventMap>({ logger: silentLogger })
			return {
				on: (listener) => {
					emitter.on('ev', listener)
				},
				emitAll: (value) => emitter.emitAll('ev', value),
				emitSettled: (value) => emitter.emitSettled('ev', value),
			}
		},
	},
	{
		name: 'EvtChannel',
		create: () => {
			const channel = new EvtChannel<ChannelEvent>({ logger: silentLogger })
			return {
				on: (listener) => {
					channel.on(listener)
				},
				emitAll: (value) => channel.emitAll(value),
				emitSettled: (value) => channel.emitSettled(value),
			}
		},
	},
]

describe.each(harnesses)('emitAll/emitSettled ($name)', ({ create }) => {
	let h: ReturnType<EmitHarness['create']>

	beforeEach(() => {
		h = create()
	})

	it('emitSettled never throws and preserves fn references', async () => {
		const syncOk: Listener = (value) => value + '!'
		const syncReturnError: Listener = (_value) => new Error('bad-value')
		const asyncThrow: Listener = async () => {
			throw new Error('boom')
		}

		h.on(syncOk)
		h.on(syncReturnError)
		h.on(asyncThrow)

		const results = await h.emitSettled('x')
		expect(results).toHaveLength(3)

		const r0 = results[0]
		if (!r0) throw new Error('Expected result[0]')
		expect(r0).toMatchObject({ status: 'fulfilled', value: 'x!' })
		expect(r0.fn).toBe(syncOk)

		const r1 = results[1]
		if (!r1) throw new Error('Expected result[1]')
		expect(r1).toMatchObject({ status: 'fulfilled' })
		expect(r1.fn).toBe(syncReturnError)
		if (r1.status !== 'fulfilled')
			throw new Error('Expected fulfilled result[1]')
		expect(r1.value).toBeInstanceOf(Error)
		expect((r1.value as Error).message).toBe('bad-value')

		const r2 = results[2]
		if (!r2) throw new Error('Expected result[2]')
		expect(r2).toMatchObject({ status: 'rejected' })
		expect(r2.fn).toBe(asyncThrow)
		if (r2.status !== 'rejected') throw new Error('Expected rejected result[2]')
		expect(r2.reason).toBeInstanceOf(Error)
		expect((r2.reason as Error).message).toBe('boom')
	})

	it.each([
		...([
			{
				label: 'sync throw',
				listener: (_value: string) => {
					throw new Error('boom')
				},
			},
			{
				label: 'promise reject',
				listener: (_value: string) => Promise.reject(new Error('boom')),
			},
		] satisfies Array<{ label: string; listener: Listener }>),
	])('emitAll rejects when: $label', async ({ listener }) => {
		h.on((_value) => 'ok')
		h.on(listener)
		await expect(h.emitAll('x')).rejects.toThrow('boom')
	})

	it('emitAll preserves Error objects returned as values', async () => {
		const syncError = new Error('sync-value')
		const asyncError = new Error('async-value')

		h.on(() => syncError)
		h.on(() => Promise.resolve(asyncError))

		await expect(h.emitAll('x')).resolves.toEqual([syncError, asyncError])
	})
})
