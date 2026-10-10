import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { WorkerTaskError } from '@pluxel/services/workers'
import { afterEach, describe, expect, it } from 'vitest'
import type { TypstPluginConfig } from '../src/config.ts'
import { DocumentSession } from '../src/session.ts'
import type { TypstWorkerInput, TypstWorkerOutput } from '../src/worker.ts'

const config: TypstPluginConfig = {
	maxSessions: 2,
	maxQueuedUpdates: 2,
	maxFiles: 100,
	maxTemplateBytes: 1_000_000,
	maxInputBytes: 1_000_000,
	maxFontBytes: 1_000_000,
	maxOutputBytes: 1_000_000,
	maxJsonDepth: 32,
	maxJsonValues: 10_000,
}
const directories: string[] = []
const sessions: DocumentSession[] = []
const output = (): TypstWorkerOutput => ({
	ok: true,
	vector: new Uint8Array([1]),
	pdf: new Uint8Array([2, 3]),
	diagnostics: [],
})
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((yes) => {
		resolve = yes
	})
	return { promise, resolve }
}
async function template() {
	const root = await mkdtemp(join(tmpdir(), 'typst-session-test-'))
	directories.push(root)
	await writeFile(join(root, 'main.typ'), root)
	return { root, entry: 'main.typ' }
}
type Runner = ConstructorParameters<typeof DocumentSession>[1]
function session(run: Runner, released: () => void = () => {}) {
	const instance = new DocumentSession(config, run, released)
	sessions.push(instance)
	return instance
}
afterEach(async () => {
	await Promise.all(sessions.splice(0).map((instance) => instance.dispose()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('document session ownership', () => {
	it('replaces the complete input set, fixes template contents, and returns independent PDF copies', async () => {
		const source = await template()
		const observed: { files: string[]; template: string }[] = []
		const instance = session(async (prepare, signal) => {
			const input = await prepare(signal)
			observed.push({
				files: await readdir(join(input.root, 'inputs')),
				template: await readFile(join(input.root, input.entry), 'utf8'),
			})
			return output()
		})
		await instance.initialize(source, async () => [], {})
		await writeFile(join(source.root, source.entry), 'changed')
		const first = await instance.update({
			files: { '/inputs/first.json': { kind: 'json', value: 1 } },
		})
		const copy = await instance.exportPdf(first.revision)
		copy.fill(0)
		expect([...(await instance.exportPdf(first.revision))]).toEqual([2, 3])
		const second = await instance.update({
			files: { '/inputs/second.json': { kind: 'json', value: 2 } },
		})
		expect(second.revision).toBe(first.revision + 1)
		expect(observed).toEqual([
			{ files: ['first.json'], template: source.root },
			{ files: ['second.json'], template: source.root },
		])
		await expect(instance.exportPdf(first.revision)).rejects.toMatchObject({
			code: 'STALE_REVISION',
		})
	})

	it('keeps the successful revision after compilation or preparation failure', async () => {
		let fail = false
		const instance = session(async (prepare, signal) => {
			await prepare(signal)
			return fail
				? {
						ok: false,
						code: 'COMPILE_FAILED',
						diagnostics: [{ severity: 'error', message: 'invalid document' }],
					}
				: output()
		})
		await instance.initialize(await template(), async () => [], {})
		const first = await instance.update({ files: {} })
		fail = true
		await expect(instance.update({ files: {} })).rejects.toMatchObject({ code: 'COMPILE_FAILED' })
		await expect(
			instance.update({ files: { '/inputs/data': { kind: 'json', value: NaN } } }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect([...(await instance.exportPdf(first.revision))]).toEqual([2, 3])
		fail = false
		const recovered = await instance.update({ files: {} })
		expect(recovered.revision).toBe(first.revision + 1)
	})

	it('holds accepted PDF bytes while a later update replaces the revision', async () => {
		const instance = session(async (prepare, signal) => {
			await prepare(signal)
			return output()
		})
		await instance.initialize(await template(), async () => [], {})
		const first = await instance.update({ files: {} })
		const accepted = instance.exportPdf(first.revision)
		await instance.update({ files: {} })
		expect([...(await accepted)]).toEqual([2, 3])
	})

	it('cancels queued updates before touching their resources, then admits a replacement', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		let calls = 0
		const instance = session(async (prepare, signal) => {
			await prepare(signal)
			if (++calls === 1) {
				entered.resolve()
				await release.promise
			}
			return output()
		})
		await instance.initialize(await template(), async () => [], {})
		const first = instance.update({ files: {} })
		await entered.promise
		const controller = new AbortController()
		const cancelled = instance.update({
			signal: controller.signal,
			files: { '/inputs/missing': { kind: 'file', path: '/does-not-exist' } },
		})
		const failure = cancelled.catch((cause: unknown) => cause)
		controller.abort(new Error('cancel queued'))
		expect(await failure).toMatchObject({ message: 'cancel queued' })
		const replacement = instance.update({ files: {} })
		release.resolve()
		await first
		await replacement
		expect(calls).toBe(2)
	})

	it('waits for aborted execution to finish before cleanup and releases once', async () => {
		const entered = deferred<TypstWorkerInput>()
		const executionStopped = deferred<void>()
		const abortObserved = deferred<void>()
		let released = 0
		const instance = session(
			async (prepare, signal) => {
				const input = await prepare(signal)
				signal.addEventListener('abort', () => abortObserved.resolve(), { once: true })
				entered.resolve(input)
				await executionStopped.promise
				signal.throwIfAborted()
				return output()
			},
			() => {
				released++
			},
		)
		await instance.initialize(await template(), async () => [], {})
		const updating = instance.update({ files: {} })
		const rejection = updating.catch((cause: unknown) => cause)
		const input = await entered.promise
		let closed = false
		const closing = instance.dispose()
		expect(instance.dispose()).toBe(closing)
		void closing.then(() => {
			closed = true
			return undefined
		})
		await abortObserved.promise
		await setImmediate()
		expect(closed).toBe(false)
		await access(input.root)
		await expect(instance.update({ files: {} })).rejects.toMatchObject({ code: 'CLOSED' })
		executionStopped.resolve()
		expect(await rejection).toMatchObject({ code: 'CLOSED' })
		await closing
		expect(released).toBe(1)
		await expect(access(dirname(input.root))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('cleans a partial initialized snapshot when its owner disposes after font failure', async () => {
		const source = await template()
		let snapshot: string | undefined
		let released = 0
		const instance = session(
			async () => output(),
			() => {
				released++
			},
		)
		await expect(
			instance.initialize(
				source,
				async () => {
					// Observe the real owned file, without reaching into session implementation fields.
					for (const name of await readdir(tmpdir())) {
						if (!name.startsWith('pluxel-typst-')) continue
						const candidate = join(tmpdir(), name)
						try {
							if ((await readFile(join(candidate, 'workspace/main.typ'), 'utf8')) === source.root)
								snapshot = candidate
						} catch {
							/* Other concurrently created sessions need not have an entry yet. */
						}
					}
					throw new Error('font preparation failed')
				},
				{},
			),
		).rejects.toThrow('font preparation failed')
		expect(snapshot).toBeDefined()
		await instance.dispose()
		await instance.dispose()
		expect(released).toBe(1)
		await expect(access(snapshot!)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('retains resources and closes access when worker exit cannot be confirmed', async () => {
		let root = ''
		let released = 0
		const failure = new WorkerTaskError('EXECUTION_UNSETTLED', 'worker exit unconfirmed')
		const instance = session(
			async (prepare, signal) => {
				const input = await prepare(signal)
				root = input.root
				throw failure
			},
			() => {
				released++
			},
		)
		await instance.initialize(await template(), async () => [], {})
		try {
			await expect(instance.update({ files: {} })).rejects.toBe(failure)
			await expect(instance.update({ files: {} })).rejects.toMatchObject({ code: 'CLOSED' })
			await expect(instance.dispose()).rejects.toMatchObject({ cause: failure })
			await expect(instance.dispose()).rejects.toThrow(dirname(root))
			expect(released).toBe(1)
			await access(root)
		} finally {
			// This runner never starts a real worker; the test owns final deletion.
			sessions.splice(sessions.indexOf(instance), 1)
			if (root) await rm(dirname(root), { recursive: true, force: true })
		}
	})
})
