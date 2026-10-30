import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { build } from 'vite'

const output = await build({
	configFile: false,
	root: fileURLToPath(new URL('..', import.meta.url)),
	logLevel: 'error',
	build: {
		target: 'esnext',
		write: false,
		minify: false,
		lib: {
			entry: fileURLToPath(new URL('./fixtures/zenfs-browser.mjs', import.meta.url)),
			name: 'ZenfsAdmission',
			formats: ['iife'],
		},
	},
})
const builds = Array.isArray(output) ? output : [output]
assert.equal(builds.length, 1, 'Expected one browser fixture build')
assert.ok('output' in builds[0], 'Expected a browser fixture bundle')
const bundle = builds[0].output.find((item) => item.type === 'chunk')
assert.ok(bundle, 'Browser fixture bundle is missing')

const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 10_000 },
)
let context
try {
	context = await browser.newContext()
	await context.route('https://zenfs-admission.test/**', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><title>ZenFS admission</title>',
		}),
	)
	const page = await context.newPage()
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.goto('https://zenfs-admission.test/')
	await page.addScriptTag({ content: bundle.code })

	async function probe(method, argument) {
		let timer
		try {
			return await Promise.race([
				page.evaluate(
					([name, input]) => globalThis.ZenfsAdmission[name](input),
					[method, argument],
				),
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`${method} did not settle within 10 seconds`)),
						10_000,
					)
				}),
			])
		} finally {
			clearTimeout(timer)
		}
	}

	const complete = await probe('run')
	for (const operation of ['afterWrite', 'afterRename', 'afterEmptyWrite', 'afterBinaryWrite']) {
		assert.equal(complete[operation], 0, `${operation} returned before native IDB completion`)
	}
	assert.equal(complete.content, 'NEW-CONTENT')
	assert.equal(complete.reopenedContent, 'NEW-CONTENT')
	assert.equal(complete.reopenedEmpty, '')
	const binary = Array.from({ length: 257 }, (_, index) => index % 256)
	assert.deepEqual(complete.binary, binary)
	assert.deepEqual(complete.reopenedBinary, binary)

	for (const kind of ['abort', 'request', 'quota']) {
		const result = await probe('runFailure', kind)
		assert.equal(result.injected, true, `${kind} injection was not exercised`)
		assert.equal(typeof result.error?.code, 'string', `${kind} must reject with an errno`)
		if (kind === 'quota') assert.equal(result.error.code, 'ENOSPC')
		assert.equal(result.currentContent, 'OLD-CONTENT', `${kind} changed the current document`)
		assert.equal(result.reopenedContent, 'OLD-CONTENT', `${kind} changed the persisted document`)
		assert.equal(result.leakedConnections, 0)
		assert.equal(result.pendingTransactions, 0)
	}

	const preload = await probe('runPreloadFailure')
	assert.equal(preload.injected, true)
	for (const result of [preload, await probe('runCorruptRoot'), await probe('runMissingRoot')]) {
		assert.equal(result.rejected, true, `${result.kind} must fail initialization`)
		assert.equal(result.unchanged, true, `${result.kind} changed the original store bytes`)
		assert.equal(result.leakedConnections, 0)
		assert.equal(result.pendingTransactions, 0)
	}

	const lifecycle = await probe('runProfileLifecycle')
	assert.equal(lifecycle.separateBackings, true)
	assert.equal(lifecycle.separateConnections, true)
	assert.equal(lifecycle.sameProfileConnectionDistinct, true)
	assert.equal(lifecycle.firstValue, 'PROFILE-A')
	assert.equal(lifecycle.secondValue, 'PROFILE-B')
	assert.equal(lifecycle.otherBorrowStillWorks, 'PROFILE-A')
	assert.equal(lifecycle.cycles.length, 12)
	for (const cycle of lifecycle.cycles) {
		assert.equal(cycle.value, String(cycle.cycle))
		assert.equal(cycle.connections, 0)
		assert.equal(cycle.transactions, 0)
		assert.equal(cycle.contexts, 0)
		assert.equal(cycle.caches, 0)
	}

	const readonly = await probe('runReadonly')
	assert.deepEqual(Object.values(readonly.failures), Array(8).fill('EROFS'))
	assert.equal(readonly.missingRead, 'ENOENT')
	assert.deepEqual(readonly.listing, ['seed.txt'])
	assert.equal(readonly.preserved, 'PRESERVE-ME')
	assert.equal(readonly.unchanged, true)
	assert.equal(readonly.missingFailure, 'ENOENT')
	assert.equal(readonly.createdMissing, false)
	assert.equal(readonly.connections, 0)
	assert.equal(readonly.transactions, 0)
	assert.deepEqual(errors, [])
	console.log(
		'ZenFS dependency admission passed: native commits, rollback, readonly and resource cleanup.',
	)
} finally {
	try {
		await context?.close()
	} finally {
		await browser.close()
	}
}
