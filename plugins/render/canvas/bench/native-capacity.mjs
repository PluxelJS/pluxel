import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { createCanvas, Image } from '@napi-rs/canvas'

const width = 4_096
const height = 4_096
const fsProbeUrl = new URL(import.meta.url)
const decodeConcurrency = boundedInteger(
	process.env.PLUXEL_CANVAS_BENCH_DECODE_CONCURRENCY,
	4,
	1,
	64,
	'PLUXEL_CANVAS_BENCH_DECODE_CONCURRENCY',
)

function gradientCanvas() {
	const canvas = createCanvas(width, height)
	const context = canvas.getContext('2d')
	const gradient = context.createLinearGradient(0, 0, width, height)
	gradient.addColorStop(0, '#123456')
	gradient.addColorStop(1, '#fedcba')
	context.fillStyle = gradient
	context.fillRect(0, 0, width, height)
	return canvas
}

async function observe(operation) {
	let last = performance.now()
	let maxTimerGapMs = 0
	const baselineRssBytes = process.memoryUsage.rss()
	let peakRssBytes = baselineRssBytes
	const timer = setInterval(() => {
		const now = performance.now()
		maxTimerGapMs = Math.max(maxTimerGapMs, now - last)
		last = now
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss())
	}, 2)
	await new Promise((resolve) => setImmediate(resolve))
	const started = performance.now()
	try {
		const value = await operation()
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss())
		return {
			value,
			durationMs: performance.now() - started,
			maxTimerGapMs,
			baselineRssBytes,
			peakRssBytes,
			peakRssDeltaBytes: peakRssBytes - baselineRssBytes,
		}
	} finally {
		clearInterval(timer)
	}
}

async function readLatencyMs() {
	const started = performance.now()
	await readFile(fsProbeUrl)
	return performance.now() - started
}

await readFile(fsProbeUrl)
const baselineFsMs = []
for (let index = 0; index < 5; index += 1) baselineFsMs.push(await readLatencyMs())

const encodeCanvas = gradientCanvas()
let promiseReturnMs = 0
const encode = await observe(async () => {
	const started = performance.now()
	const task = encodeCanvas.encode('png')
	promiseReturnMs = performance.now() - started
	return task
})

const sourceBytes = gradientCanvas().encodeSync('png')
let fsDuringDecodeMs = 0
const decode = await observe(async () => {
	const tasks = Array.from({ length: decodeConcurrency }, () => {
		const image = new Image()
		image.src = sourceBytes
		return image.decode()
	})
	const fsTask = readLatencyMs().then((duration) => void (fsDuringDecodeMs = duration))
	await Promise.all([Promise.all(tasks), fsTask])
})

process.stdout.write(
	`${JSON.stringify(
		{
			uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'node-default',
			dimensions: `${width}x${height}`,
			encodedSourceBytes: sourceBytes.byteLength,
			asyncEncode: {
				promiseReturnMs,
				totalMs: encode.durationMs,
				maxTimerGapMs: encode.maxTimerGapMs,
				baselineRssBytes: encode.baselineRssBytes,
				peakRssBytes: encode.peakRssBytes,
				peakRssDeltaBytes: encode.peakRssDeltaBytes,
				outputBytes: encode.value.byteLength,
			},
			nativeDecodes: {
				concurrency: decodeConcurrency,
				totalMs: decode.durationMs,
				maxTimerGapMs: decode.maxTimerGapMs,
				baselineRssBytes: decode.baselineRssBytes,
				peakRssBytes: decode.peakRssBytes,
				peakRssDeltaBytes: decode.peakRssDeltaBytes,
				baselineFsMs,
				fsDuringDecodeMs,
			},
		},
		null,
		2,
	)}\n`,
)

function boundedInteger(value, fallback, minimum, maximum, name) {
	const resolved = value === undefined ? fallback : Number(value)
	if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
		throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`)
	}
	return resolved
}
