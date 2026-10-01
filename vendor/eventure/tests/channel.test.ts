import { EvtChannel } from 'eventure'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { silentLogger } from './testUtils'

type StringEvent = (value: string) => string | Promise<string> | void

describe('EvtChannel core', () => {
	let channel: EvtChannel<StringEvent>

	beforeEach(() => {
		channel = new EvtChannel({ logger: silentLogger })
	})

	it('registers listeners, supports abort signals and clearing', () => {
		const calls: string[] = []
		const controller = new AbortController()

		const unsub = channel.on((value) => {
			calls.push(`first:${value}`)
		})
		channel.on(
			(value) => {
				calls.push(`second:${value}`)
			},
			{ signal: controller.signal },
		)
		expect(channel.emit('alpha')).toBe(2)
		controller.abort()
		expect(channel.emit('beta')).toBe(1)

		unsub()
		expect(channel.count()).toBe(0)
		channel.clear()
		expect(channel.count()).toBe(0)
		expect(calls).toEqual(['first:alpha', 'second:alpha', 'first:beta'])
	})

	it('supports once/many/when and waitFor', async () => {
		const seen: string[] = []

		channel.once((value) => {
			seen.push(`once:${value}`)
		})
		channel.many(2, (value) => {
			seen.push(`many:${value}`)
		})

		const guard = channel.when((value) => value.startsWith('OK'))
		guard.once((value) => {
			seen.push(`guard:${value}`)
		})

		const waiting = channel.waitFor()
		channel.emit('OK-1')
		channel.emit('skip')
		channel.emit('OK-2')

		await expect(waiting).resolves.toEqual(['OK-1'])
		expect(seen).toEqual(['once:OK-1', 'many:OK-1', 'guard:OK-1', 'many:skip'])
		expect(channel.count()).toBe(0)
	})

	it('supports maxListeners=0 as unlimited and rejects invalid limits', () => {
		const warn = vi.fn((..._args: unknown[]) => {})
		const local = new EvtChannel<StringEvent>({
			logger: { ...silentLogger, warn },
		})
		local.maxListeners = 0

		for (let i = 0; i < 20; i++) {
			local.on(() => {})
		}

		expect(warn.mock.calls.length).toBe(0)
		expect(() => {
			local.maxListeners = Number.NaN
		}).toThrow(RangeError)
		expect(() => {
			local.maxListeners = 2.1
		}).toThrow(RangeError)

		local.maxListeners = Infinity
		local.on(() => {})
		expect(warn.mock.calls.length).toBe(0)
	})
})

describe('EvtChannel fire & waterfall helpers', () => {
	it('emits listener snapshots through fire/fireAsync', async () => {
		const chan = new EvtChannel<StringEvent>()
		const syncFn = (value: string) => value.toUpperCase()
		const asyncFn = async (value: string) => value.repeat(2)
		const boomFn = () => {
			throw new Error('boom')
		}

		chan.on(syncFn)
		chan.on(asyncFn)
		chan.on(boomFn)

		const subset = chan.listeners().slice(0, 2)
		const subsetRecords = Array.from(chan.fireFrom(subset, 'hi'))

		expect(subsetRecords).toHaveLength(2)
		expect(subsetRecords[0]).toMatchObject({
			type: 'success',
			result: 'HI',
		})
		const second = subsetRecords[1]
		expect(second?.type).toBe('async')
		if (!second || second.type !== 'async') {
			throw new Error('Expected async record')
		}
		await expect(second.promise).resolves.toBe('hihi')

		const gen = chan.fireFrom(chan.listeners(), 'ok')
		expect(Array.from(gen)).toHaveLength(3)

		const asyncTypes: string[] = []
		for await (const record of chan.fireAsync('zz')) {
			asyncTypes.push(record.type)
			if (record.type === 'error') break
		}
		expect(asyncTypes).toEqual(['success', 'success', 'error'])
	})

	it('executes waterfall pipelines and reports interruption', () => {
		type PipelineEvent = (
			value: number,
			next: (value: number) => number,
		) => number
		const pipeline = new EvtChannel<PipelineEvent>()

		pipeline.on((value, next) => next(value + 1))
		pipeline.on((value, next) => next(value * 2))

		const ok = pipeline.waterfall(2, (value: number) => value)
		expect(ok).toEqual({ ok: true, value: 6 })

		pipeline.on((value) => value - 10)
		const interrupted = pipeline.waterfall(3)
		expect(interrupted).toEqual({ ok: false, value: -2 })

		const snapshot = pipeline.listeners().slice(0, 2)
		const withInner = pipeline.waterfallFrom(
			snapshot,
			1,
			(final: number) => final * 10,
		)
		expect(withInner).toEqual({ ok: true, value: 40 })
	})

	it('does not confuse array payloads with listener snapshots', async () => {
		const arrays = new EvtChannel<(values: string[]) => number>()
		arrays.on((values) => values.length)

		const records = Array.from(arrays.fire(['a', 'b']))
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({ type: 'success', result: 2 })

		const asyncRecords: string[] = []
		for await (const record of arrays.fireAsync(['x'])) {
			asyncRecords.push(record.type)
			expect(record).toMatchObject({ type: 'success', result: 1 })
		}
		expect(asyncRecords).toEqual(['success'])

		type ArrayPipeline = (
			values: string[],
			next: (values: string[]) => number,
		) => number
		const pipeline = new EvtChannel<ArrayPipeline>()
		pipeline.on((values, next) => next([...values, 'tail']))

		expect(
			pipeline.waterfall(['head'], (values: string[]) => values.length),
		).toEqual({ ok: true, value: 2 })
	})
})
