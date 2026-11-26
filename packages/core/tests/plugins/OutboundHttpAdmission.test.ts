import { expect, it } from 'vitest'
import { RequestAdmission } from '../../src/http/admission'

it('serves waiting attempts FIFO when slots release out of order and a middle waiter cancels', async () => {
	const admission = new RequestAdmission(2, 3)
	const signal = new AbortController().signal
	const first = admission.acquire(signal)
	const second = admission.acquire(signal)
	if (typeof first !== 'function' || typeof second !== 'function')
		throw new Error('Free slots must be synchronous')
	const cancelled = new AbortController()
	const order: string[] = []
	const wait = async (id: string, lifetime = signal) => {
		const release = await admission.acquire(lifetime)
		order.push(id)
		return release
	}
	const a = wait('a')
	const b = wait('b', cancelled.signal)
	const c = wait('c')
	expect(() => admission.acquire(signal)).toThrow(expect.objectContaining({ code: 'queue_full' }))
	const reason = new Error('cancel b')
	cancelled.abort(reason)
	const d = wait('d')
	await expect(b).rejects.toBe(reason)

	second()
	const releaseA = await a
	expect(order).toEqual(['a'])
	first()
	releaseA()
	const e = wait('e')
	const [releaseC, releaseD] = await Promise.all([c, d])
	expect(order).toEqual(['a', 'c', 'd'])
	releaseD()
	const releaseE = await e
	expect(order).toEqual(['a', 'c', 'd', 'e'])
	releaseC()
	releaseE()
	const final = admission.acquire(signal)
	expect(typeof final).toBe('function')
	const releaseFinal = await final
	releaseFinal()
})

it('re-arms a saturated slot when successive heads cancel', async () => {
	const admission = new RequestAdmission(1, 1)
	const signal = new AbortController().signal
	const held = await admission.acquire(signal)
	const attempts = Array.from({ length: 5 }, () => {
		const controller = new AbortController()
		const waiting = admission.acquire(controller.signal)
		controller.abort('cancelled')
		return expect(waiting).rejects.toBe('cancelled')
	})
	const waiting = admission.acquire(signal)
	await Promise.all(attempts)
	expect(() => admission.acquire(signal)).toThrow(expect.objectContaining({ code: 'queue_full' }))
	held()
	const release = await waiting
	release()
})
