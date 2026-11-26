import { expect, it, vi } from 'vitest'
import { Eventure, EvtChannel, observeSubscriptionEnd } from '../src'
import { silentLogger } from './testUtils'

it('releases the removed occurrence of a duplicate listener', () => {
	const events = new Eventure<{ change: [value: string] }>()
	const listener = vi.fn()
	const first = events.on('change', listener)
	const second = events.on('change', listener)
	const firstEnded = vi.fn()
	const secondEnded = vi.fn()
	observeSubscriptionEnd(first, firstEnded)
	observeSubscriptionEnd(second, secondEnded)

	second()
	second()
	expect(secondEnded).toHaveBeenCalledTimes(1)
	expect(firstEnded).not.toHaveBeenCalled()
	expect(events.listeners('change')).toEqual([listener])
	expect(events.off('change', listener)).toBe(true)
	expect(firstEnded).toHaveBeenCalledTimes(1)
	expect(events.emit('change', 'removed')).toBe(0)
})

it('ends both selected and global clears without touching subsequent registrations', () => {
	const other = Symbol('other')
	const events = new Eventure<{ change: []; [other]: [] }>()
	const listener = vi.fn()
	const signal = new AbortController()
	const removeAbort = vi.spyOn(signal.signal, 'removeEventListener')
	const old = events.on('change', listener, { signal: signal.signal })
	const otherEnded = vi.fn()
	observeSubscriptionEnd(events.on(other, listener), otherEnded)
	events.clear('change')
	const oldEnded = vi.fn()
	observeSubscriptionEnd(old, oldEnded)
	expect(oldEnded).toHaveBeenCalledTimes(1)
	expect(removeAbort).toHaveBeenCalledWith('abort', old)
	expect(otherEnded).not.toHaveBeenCalled()

	events.on('change', listener)
	old()
	signal.abort()
	expect(events.count('change')).toBe(1)
	events.clear()
	expect(otherEnded).toHaveBeenCalledTimes(1)
	expect(events.events()).toEqual([])
})

it('observes waiter completion while preserving cancellation after a channel clear', async () => {
	const channel = new EvtChannel<[number]>()
	const waited = channel.waitFor()
	const ended = vi.fn()
	observeSubscriptionEnd(waited.cancel, ended)
	channel.clear()
	expect(ended).not.toHaveBeenCalled()
	const rejection = expect(waited).rejects.toThrow('cancelled')
	waited.cancel()
	await rejection
	expect(ended).toHaveBeenCalledTimes(1)

	const aborted = channel.waitFor({ signal: AbortSignal.abort() })
	const abortedEnded = vi.fn()
	observeSubscriptionEnd(aborted.cancel, abortedEnded)
	await expect(aborted).rejects.toThrow('aborted')
	expect(abortedEnded).toHaveBeenCalledTimes(1)
})

it('releases limited listeners even if the registration warning emits synchronously', async () => {
	const events = new Eventure<{ change: [number] }>({
		logger: {
			...silentLogger,
			warn: () => {
				events.emit('change', 1)
			},
		},
	})
	const channel = new EvtChannel<[number]>({
		logger: {
			...silentLogger,
			warn: () => {
				channel.emit(1)
			},
		},
	})
	events.maxListeners = 1
	channel.maxListeners = 1
	const listener = vi.fn()
	events.on('change', listener)
	channel.on(listener)
	const broadcastEnded = vi.fn()
	const channelEnded = vi.fn()
	observeSubscriptionEnd(events.once('change', listener), broadcastEnded)
	observeSubscriptionEnd(channel.once(listener), channelEnded)
	expect(broadcastEnded).toHaveBeenCalledTimes(1)
	expect(channelEnded).toHaveBeenCalledTimes(1)
	await expect(events.waitFor('change')).resolves.toEqual([1])
	await expect(channel.waitFor()).resolves.toEqual([1])
	expect(events.listeners('change')).toEqual([listener])
	expect(channel.listeners()).toEqual([listener])
})

it('undoes a registration when its warning throws', () => {
	const error = new Error('warning failed')
	const channel = new EvtChannel<[]>({
		logger: {
			...silentLogger,
			warn: () => {
				throw error
			},
		},
	})
	channel.maxListeners = 1
	const listener = vi.fn()
	channel.on(listener)
	const signal = new AbortController()
	const removeAbort = vi.spyOn(signal.signal, 'removeEventListener')
	expect(() => channel.on(() => {}, { signal: signal.signal })).toThrow(error)
	expect(removeAbort).toHaveBeenCalledTimes(1)
	expect(channel.listeners()).toEqual([listener])
})
