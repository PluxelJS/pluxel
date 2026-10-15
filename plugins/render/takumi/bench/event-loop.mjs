import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { createTestHost } from '@pluxel/test'
import { TakumiPlugin } from '../dist/index.mjs'

// Run after building @pluxel/takumi. Diagnostic data, not a machine-independent threshold.
await using host = await createTestHost({
	services: [
		nodeModules({ root: fileURLToPath(new URL('../dist/artifacts/node', import.meta.url)) }),
		workers({ maxThreads: 1 }),
	],
})
await host.commit((change) => {
	change.catalog.add([TakumiPlugin])
	change.start(TakumiPlugin)
})
const takumi = host.require(TakumiPlugin)
const html = `<div style="display:flex;flex-wrap:wrap">${Array.from({ length: 2000 }, (_, i) => `<span style="font-size:12px;padding:2px">cell-${i}</span>`).join('')}</div>`
const options = { width: 1200, height: 630, emoji: 'from-font' }
const results = []
for (const [execution, render] of [
	['direct', (input, settings) => takumi.renderSvg(input, settings)],
	['shared-worker', (input, settings) => takumi.renderSvgInWorker(input, settings)],
]) {
	await render(html, options)
	let previous = performance.now()
	let maxTimerGapMs = 0
	let ticks = 0
	const timer = setInterval(() => {
		const now = performance.now()
		maxTimerGapMs = Math.max(maxTimerGapMs, now - previous)
		previous = now
		ticks++
	}, 1)
	const start = performance.now()
	try {
		for (let i = 0; i < 3; i++) await render(html, options)
		await new Promise((resolve) => setTimeout(resolve, 5))
		results.push({
			execution,
			renders: 3,
			durationMs: +(performance.now() - start).toFixed(1),
			maxTimerGapMs: +maxTimerGapMs.toFixed(1),
			ticks,
		})
	} finally {
		clearInterval(timer)
	}
}
console.log(JSON.stringify({ htmlBytes: Buffer.byteLength(html), maxThreads: 1, results }, null, 2))
