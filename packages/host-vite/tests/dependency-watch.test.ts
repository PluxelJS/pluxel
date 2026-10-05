import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it, vi } from 'vitest'
import { createHostDependencyWatch } from '../src/dependency-watch'

const pollWatchers = (): number =>
	process.getActiveResourcesInfo().filter((name) => name === 'StatWatcher').length

it('stops filesystem observation when a real Node watcher closes during continuing writes', async () => {
	const result = await promisify(execFile)(
		process.execPath,
		[fileURLToPath(new URL('./watch-policy.smoke.mjs', import.meta.url))],
		{ timeout: 10000 },
	)
	expect(result.stdout).toContain('WATCH_POLICY_EVIDENCE=')
})

it.each([undefined, 'true', '1'] as const)(
	'observes an immediate repair with CHOKIDAR_USEPOLLING=%s',
	async (polling) => {
		await using fixture = await createDiskFixture({ 'app.mjs': 'initial' })
		const file = resolve(fixture.path, 'app.mjs')
		const baseline = pollWatchers()
		const bytes: string[] = []
		const errors: unknown[] = []
		const watcher = createHostDependencyWatch({
			async onChange(path) {
				const input = await readFile(path, 'utf8')
				bytes.push(input)
				if (input === 'broken') await writeFile(path, 'repaired')
			},
			onError: (error) => errors.push(error),
		})
		vi.stubEnv('CHOKIDAR_USEPOLLING', polling)
		vi.stubEnv('CHOKIDAR_INTERVAL', polling ? '100' : undefined)
		try {
			await watcher.replace([file])
			expect(pollWatchers()).toBeGreaterThan(baseline)
			await writeFile(file, 'broken')
			await vi.waitFor(() => expect(bytes).toEqual(['broken', 'repaired']))
			expect(errors).toEqual([])
		} finally {
			await watcher.close()
			vi.unstubAllEnvs()
		}
		await new Promise<void>((resolveClosed) => setImmediate(resolveClosed))
		expect(pollWatchers()).toBeLessThanOrEqual(baseline)
	},
)

it.each(['resolve', 'reject'] as const)(
	'closes the file observer and drains an already accepted callback that will %s',
	async (outcome) => {
		await using fixture = await createDiskFixture({ 'app.mjs': 'initial' })
		const file = resolve(fixture.path, 'app.mjs')
		const baseline = pollWatchers()
		const started = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const failure = new Error('ACCEPTED_CALLBACK_FAILED')
		const errors: unknown[] = []
		let calls = 0
		const watcher = createHostDependencyWatch({
			async onChange() {
				calls++
				started.resolve()
				await release.promise
				if (outcome === 'reject') throw failure
			},
			onError: (error) => errors.push(error),
		})
		try {
			await watcher.replace([file])
			await writeFile(file, 'broken')
			await started.promise
			const closing = watcher.close()
			expect(watcher.close()).toBe(closing)
			let closed = false
			void closing.then(
				() => {
					closed = true
					return undefined
				},
				() => {
					closed = true
					return undefined
				},
			)
			await new Promise<void>((resolveClosed) => setImmediate(resolveClosed))
			expect(closed).toBe(false)
			expect(pollWatchers()).toBeLessThanOrEqual(baseline)
			await writeFile(file, 'after-close')
			release.resolve()
			const results = await Promise.allSettled([closing])
			const failures = results.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			const expectedFailure = expect.objectContaining({ cause: failure, errors: [failure] })
			expect(failures).toEqual(outcome === 'reject' ? [expectedFailure] : [])
			expect(errors).toEqual(outcome === 'reject' ? [failure] : [])
			expect(calls).toBe(1)
		} finally {
			release.resolve()
			await Promise.allSettled([watcher.close()])
		}
	},
)

it.each([
	['CHOKIDAR_USEPOLLING', 'false'],
	['CHOKIDAR_USEPOLLING', '0'],
	['CHOKIDAR_USEPOLLING', ''],
	['CHOKIDAR_INTERVAL', '5'],
	['CHOKIDAR_INTERVAL', '50'],
	['CHOKIDAR_INTERVAL', 'not-a-number'],
] as const)('rejects conflicting %s=%s before opening a watcher', async (name, value) => {
	await using fixture = await createDiskFixture({ 'app.mjs': 'initial' })
	const file = resolve(fixture.path, 'app.mjs')
	const baseline = pollWatchers()
	const onError = vi.fn()
	const watcher = createHostDependencyWatch({ onChange: async () => {}, onError })
	vi.stubEnv(name, value)
	try {
		await expect(watcher.replace([file])).rejects.toThrow(`${name}=${JSON.stringify(value)}`)
		expect(watcher.covers(file)).toBe(false)
		expect(pollWatchers()).toBeLessThanOrEqual(baseline)
		expect(onError).not.toHaveBeenCalled()
	} finally {
		vi.unstubAllEnvs()
		await watcher.close()
	}
})

it('keeps callback replacement separate from final callback draining', async () => {
	await using fixture = await createDiskFixture({ 'app.mjs': 'initial', 'dependency.mjs': 'dep' })
	const file = resolve(fixture.path, 'app.mjs')
	const dependency = resolve(fixture.path, 'dependency.mjs')
	const replaced = Promise.withResolvers<void>()
	const onError = vi.fn()
	const watcher = createHostDependencyWatch({
		async onChange() {
			await watcher.replace([file, dependency])
			replaced.resolve()
		},
		onError,
	})
	try {
		await watcher.replace([file])
		await writeFile(file, 'updated')
		await replaced.promise
		expect(watcher.covers(dependency)).toBe(true)
		expect(onError).not.toHaveBeenCalled()
	} finally {
		await watcher.close()
	}
})
