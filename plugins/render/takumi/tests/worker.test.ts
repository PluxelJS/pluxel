import { BasePlugin, Plugin } from '@pluxel/core'
import { nodeModules } from '@pluxel/services/node'
import { Workers, defineWorkerTask, workers } from '@pluxel/services/workers'
import { createTestHost } from '@pluxel/test'
import { render as renderOnMain } from '../src/worker.ts'
import { TakumiPlugin } from '../src/index.ts'
import type { ProbeInput, ProbeOutput } from './fixtures/probe.ts'
import { describe, expect, it } from 'vitest'

const a = defineWorkerTask<ProbeInput, ProbeOutput>(import.meta.url, './fixtures/probe-a.ts')
const b = defineWorkerTask<ProbeInput, ProbeOutput>(import.meta.url, './fixtures/probe-b.ts')

@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly takumi: TakumiPlugin) {
		super()
	}
	probe(task: 'a' | 'b', input: ProbeInput = {}, signal?: AbortSignal) {
		return this.ctx
			.require(Workers)
			.run(task === 'a' ? a : b, input, { settlement: 'execution', signal })
	}
}

async function fixture() {
	const host = await createTestHost({
		services: [nodeModules(), workers({ maxThreads: 1, maxQueuedTasks: 1 })],
	})
	await host.commit((change) => {
		change.catalog.add([TakumiPlugin, Consumer])
		change.start(Consumer)
	})
	return host
}

describe('Takumi shared Workers', () => {
	it('renders native HTML, Node, SVG and animation through the official task artifact', async () => {
		await using host = await fixture()
		const { takumi } = host.require(Consumer)
		const html = '<div style="width:100%;height:100%;background:#123456"></div>'
		const options = { width: 80, height: 40, emoji: 'from-font' as const }
		expect(await takumi.renderSvgInWorker(html, options)).toBe(
			await takumi.renderSvg(html, options),
		)
		expect(Buffer.from(await takumi.renderInWorker(html, options))).toEqual(
			await takumi.render(html, options),
		)
		const node = { type: 'container' as const, style: { backgroundColor: 'red' } }
		const pending = takumi.renderInWorker(node, { ...options, format: 'webp' })
		node.style.backgroundColor = 'blue'
		expect(Buffer.from(await pending)).toEqual(
			await takumi.render(
				{ ...node, style: { backgroundColor: 'red' } },
				{ ...options, format: 'webp' },
			),
		)
		const animation = await takumi.renderAnimationInWorker({
			width: 16,
			height: 16,
			fps: 2,
			format: 'webp',
			emoji: 'from-font',
			scenes: [{ node: html, durationMs: 500 }],
		})
		expect(Buffer.from(animation).toString('ascii', 8, 12)).toBe('WEBP')
	})

	it('shares native resources across independent task bundles while keeping React in each bundle', async () => {
		await using host = await fixture()
		const consumer = host.require(Consumer)
		const first = await consumer.probe('a')
		const second = await consumer.probe('a')
		const other = await consumer.probe('b')
		expect(first.isMainThread).toBe(false)
		expect(first.threadId).toBeGreaterThan(0)
		expect(second.moduleId).toBe(first.moduleId)
		expect(other.moduleId).not.toBe(first.moduleId)
		expect(other.threadId).toBe(first.threadId)
		expect(other.rendererId).toBe(first.rendererId)
		expect([...other.png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		expect(other.svg).toContain('<svg')
	})

	it('keeps the main loop responsive, rejects excess work, and aborts queued work without parsing', async () => {
		await using host = await fixture()
		const consumer = host.require(Consumer)
		const gate = new Int32Array(new SharedArrayBuffer(12))
		const blocked = consumer.probe('a', { gate })
		try {
			await expect.poll(() => Atomics.load(gate, 0), { timeout: 10_000 }).toBe(1)
			// The component is synchronously blocked inside its Worker; this timer must still run.
			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(Atomics.load(gate, 2)).toBe(0)
			const controller = new AbortController()
			const reason = new Error('cancel queued render')
			const queued = consumer.takumi.renderInWorker('<div/>', { signal: controller.signal })
			await expect(consumer.takumi.renderInWorker('<div/>')).rejects.toMatchObject({
				code: 'QUEUE_FULL',
			})
			controller.abort(reason)
			await expect(queued).rejects.toBe(reason)
		} finally {
			Atomics.store(gate, 1, 1)
			Atomics.notify(gate, 1)
			await blocked
		}
		await expect(
			consumer.takumi.renderInWorker('<div/>', { signal: AbortSignal.abort(new Error('stopped')) }),
		).rejects.toThrow('stopped')
	})

	it('retires a cancelled task thread before accepting replacement work', async () => {
		await using host = await fixture()
		const consumer = host.require(Consumer)
		const first = await consumer.probe('a')
		const gate = new Int32Array(new SharedArrayBuffer(12))
		const controller = new AbortController()
		const reason = new Error('stop worker')
		const pending = consumer.probe('a', { gate }, controller.signal)
		try {
			await expect.poll(() => Atomics.load(gate, 0)).toBe(1)
			controller.abort(reason)
			await expect(pending).rejects.toBe(reason)
			const replacement = await consumer.probe('b')
			expect(replacement.threadId).not.toBe(first.threadId)
			expect(replacement.moduleId).not.toBe(first.moduleId)
			expect([...replacement.png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		} finally {
			Atomics.store(gate, 1, 1)
			Atomics.notify(gate, 1)
			await pending.catch(() => {})
		}
	})

	it('rejects local-only options and main-thread use of the Worker leaf', async () => {
		await using host = await fixture()
		const { takumi } = host.require(Consumer)
		await expect(takumi.renderInWorker('<div/>', { renderer: {} } as never)).rejects.toThrow(
			'worker-local template',
		)
		await expect(
			takumi.renderInWorker('<div/>', {
				images: { sources: [{ src: 'x', data: () => new Uint8Array() }] },
			} as never),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		await expect(renderOnMain('<div/>')).rejects.toThrow('inside a Worker task')
	})
})
