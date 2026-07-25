import { describe, expect, it } from 'vitest'
import { KeyedSerialExecutor } from '../src/keyed-serial.ts'

describe('KeyedSerialExecutor', () => {
	it('orders one key, keeps other keys concurrent, and recovers after failure', async () => {
		const executor = new KeyedSerialExecutor<string>()
		const release = deferred<void>()
		const seen: string[] = []
		const first = executor.run('same', async () => {
			seen.push('same:first:start')
			await release.promise
			seen.push('same:first:end')
		})
		const second = executor.run('same', async () => {
			seen.push('same:second')
			throw new Error('expected')
		})
		const other = executor.run('other', async (): Promise<void> => {
			seen.push('other')
		})
		await other
		expect(seen).toEqual(['same:first:start', 'other'])
		release.resolve()
		await first
		await expect(second).rejects.toThrow('expected')
		await executor.run('same', async (): Promise<void> => {
			seen.push('same:third')
		})
		expect(seen).toEqual([
			'same:first:start',
			'other',
			'same:first:end',
			'same:second',
			'same:third',
		])
	})
})

function deferred<Value>() {
	let resolve!: (value: Value | PromiseLike<Value>) => void
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}
