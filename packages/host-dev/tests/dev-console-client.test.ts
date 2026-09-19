import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startDevConsoleServer } from '../src/console/server'
import { requestDev, runDevFile, selectDevInstance } from '../../cli/src/dev/client'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
})

describe('dev console wire interoperability', () => {
	it('interoperates with the real console server for repeated runs, results and cancellation', async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'px-interop-'))
		cleanup.push(() => rm(root, { recursive: true, force: true }))
		await writeFile(resolve(root, 'package.json'), '{}')
		const file = resolve(root, 'operation.ts')
		await writeFile(file, 'export default () => 1')
		let calls = 0
		const server = await startDevConsoleServer({
			root,
			async execute(input, run) {
				calls++
				run.phase('execute')
				if (input.exportName === 'wait') {
					await new Promise<void>((done) =>
						run.signal.addEventListener('abort', () => done(), { once: true }),
					)
					return null
				}
				return { calls, input: input.input }
			},
		})
		cleanup.push(() => server.close())
		const first = await runDevFile({
			root,
			file,
			exportName: 'default',
			input: { count: 3 },
			timeoutMs: 1000,
			detach: false,
		})
		expect(first).toMatchObject({ state: 'succeeded', value: { calls: 1, input: { count: 3 } } })
		const second = await runDevFile({
			root,
			file,
			exportName: 'default',
			timeoutMs: 1000,
			detach: false,
		})
		expect(second).toMatchObject({ state: 'succeeded', value: { calls: 2 } })
		const waiting = await runDevFile({
			root,
			file,
			exportName: 'wait',
			timeoutMs: 1000,
			detach: true,
		})
		const instance = await selectDevInstance({ root })
		expect(await requestDev(instance, { method: 'cancel', runId: waiting.runId })).toMatchObject({
			state: 'cancelling',
		})
		expect(await server.executor.settled(waiting.runId)).toMatchObject({ state: 'cancelled' })
		expect(await requestDev(instance, { method: 'result', runId: first.runId })).toMatchObject({
			value: { calls: 1 },
		})
	})
})
