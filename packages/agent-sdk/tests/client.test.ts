import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
	runScript,
	getScriptResult,
	cancelScript,
	listHosts,
	HostClientError,
} from '@pluxel/agent-sdk/client'
import { decodeScriptReceipt } from '../src/client/receipt'
import { createDevFixture } from './helpers/dev-fixture'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
})
async function fixture(options: Parameters<typeof createDevFixture>[0] = {}) {
	const dev = await createDevFixture(options)
	cleanup.push(() => dev.close())
	const file = join(dev.root, 'task.ts')
	await writeFile(file, 'export default () => null')
	return { ...dev, file, target: { root: dev.root, instance: dev.instance.instanceId } }
}

it('captures options and persists the receipt before admitting one operation', async () => {
	const dev = await fixture()
	const entered = Promise.withResolvers<string>()
	const release = Promise.withResolvers<void>()
	const input = { count: 3 }
	const target = { ...dev.target }
	const pending = runScript({
		target,
		file: dev.file,
		input,
		onPrepared: async (receipt) => {
			entered.resolve(receipt)
			await release.promise
		},
	})
	const receipt = await entered.promise
	try {
		expect(dev.requests.some((request) => request.method === 'submit')).toBe(false)
		input.count = 99
		target.instance = 'replacement'
	} finally {
		release.resolve()
	}
	const result = await pending
	expect(result.receipt).toBe(receipt)
	expect(result.run).toMatchObject({ state: 'succeeded', value: { input: { count: 3 } } })
	expect(decodeScriptReceipt(receipt).instanceId).toBe(dev.instance.instanceId)
	expect(dev.requests.filter((request) => request.method === 'submit')).toHaveLength(1)
})

it('does not submit when persisting the prepared receipt fails', async () => {
	const dev = await fixture()
	const error = await runScript({
		target: dev.target,
		file: dev.file,
		onPrepared: async () => {
			throw new Error('disk full')
		},
	}).catch((cause) => cause)
	expect(error).toBeInstanceOf(HostClientError)
	expect(error).toMatchObject({ code: 'submission_failed', receipt: expect.any(String) })
	expect(dev.requests.some((request) => request.method === 'submit')).toBe(false)
	await expect(getScriptResult(error.receipt)).rejects.toMatchObject({
		code: 'run_not_found',
		receipt: error.receipt,
	})
})

it('keeps Node instance-selection diagnostics while refusing ambiguous targets', async () => {
	const first = await fixture()
	const second = await fixture({ root: first.root })
	await expect(runScript({ target: { root: first.root }, file: first.file })).rejects.toMatchObject(
		{
			code: 'ambiguous_instance',
			failure: {
				hint: expect.stringContaining('target.instance'),
				candidates: expect.arrayContaining([
					expect.objectContaining({ instanceId: first.instance.instanceId }),
					expect.objectContaining({ instanceId: second.instance.instanceId }),
				]),
			},
		},
	)
	expect([...first.requests, ...second.requests].some(({ method }) => method === 'submit')).toBe(
		false,
	)
})

it('stops client waiting while retaining the original run and never cancels or resubmits it', async () => {
	const release = Promise.withResolvers<void>()
	const started = Promise.withResolvers<void>()
	const dev = await fixture({
		execute: async () => {
			started.resolve()
			await release.promise
			return { changed: true }
		},
	})
	const controller = new AbortController()
	let receipt: string | undefined
	try {
		const error = await runScript({
			target: dev.target,
			file: dev.file,
			signal: controller.signal,
			onPrepared: (value) => {
				receipt = value
			},
			onAccepted: async () => {
				await started.promise
				controller.abort()
			},
		}).catch((cause) => cause)
		expect(error).toMatchObject({ code: 'aborted', receipt })
		expect(dev.requests.some((request) => request.method === 'cancel')).toBe(false)
		release.resolve()
		await dev.executor.settled(decodeScriptReceipt(receipt!).runId, dev.instance.instanceId)
		const completed = await getScriptResult(receipt!)
		expect(completed.run).toMatchObject({
			state: 'succeeded',
			value: { changed: true },
		})
		expect(dev.requests.filter((request) => request.method === 'submit')).toHaveLength(1)
	} finally {
		release.resolve()
	}
})

it('cancels by original receipt and observes actual settlement through the same public API', async () => {
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const dev = await fixture({
		execute: async (_input, run) => {
			entered.resolve()
			await release.promise
			run.signal.throwIfAborted()
			return null
		},
	})
	try {
		const { receipt, run } = await runScript({ target: dev.target, file: dev.file, detach: true })
		await entered.promise
		const cancellation = await cancelScript(receipt)
		expect(cancellation.run.state).toBe('cancelling')
		const pending = await getScriptResult(receipt)
		expect(pending.run.state).toBe('cancelling')
		release.resolve()
		await dev.executor.settled(run.runId, dev.instance.instanceId)
		const completed = await getScriptResult(receipt)
		expect(completed.run.state).toBe('cancelled')
	} finally {
		release.resolve()
	}
})

it('rejects cancellation and conflicting target selection before connecting', async () => {
	const dev = await fixture()
	await expect(
		runScript({ target: dev.target, file: dev.file, signal: AbortSignal.abort() }),
	).rejects.toMatchObject({ code: 'aborted' })
	await expect(
		runScript({
			target: { ...dev.target, endpoint: 'https://host.test' } as never,
			file: dev.file,
		}),
	).rejects.toMatchObject({ code: 'invalid_input' })
	expect(dev.requests).toHaveLength(0)
	const listed = await listHosts({ root: dev.root })
	expect(listed.instances).toHaveLength(1)
	expect(listed.instances[0]).not.toHaveProperty('nonce')
	expect(listed.instances[0]).not.toHaveProperty('socketPath')
})

it('aborts discovery while a connected instance has not answered describe', async () => {
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const dev = await fixture({
		beforeDescribe: async () => {
			entered.resolve()
			await release.promise
		},
	})
	const controller = new AbortController()
	const pending = listHosts({ root: dev.root, signal: controller.signal })
	try {
		await entered.promise
		controller.abort()
		await expect(pending).rejects.toMatchObject({ code: 'aborted' })
	} finally {
		release.resolve()
	}
})
