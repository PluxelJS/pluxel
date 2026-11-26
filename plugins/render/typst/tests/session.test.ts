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
	maxQueuedOperations: 2,
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
	navigation: { points: [], outline: [], pages: [], targets: [], links: [] },
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
type Compiler = ConstructorParameters<typeof DocumentSession>[1]
function session(
	compile: Compiler['compile'],
	released: () => void = () => {},
	render?: Compiler['render'],
) {
	let closed = false
	const instance = new DocumentSession(
		config,
		{
			get closed() {
				return closed
			},
			async compile(input, signal) {
				try {
					return await compile(input, signal)
				} finally {
					if (signal.aborted) closed = true
				}
			},
			async render(input, signal) {
				try {
					if (!render) throw new Error('Unexpected render')
					return await render(input, signal)
				} finally {
					if (signal.aborted) closed = true
				}
			},
			async close() {
				closed = true
			},
		},
		released,
	)
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
		const instance = session(async (input) => {
			observed.push({
				files: await readdir(input.inputsRoot),
				template: await readFile(join(input.templateRoot, input.entry), 'utf8'),
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
		const instance = session(async () => {
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
		const instance = session(async () => {
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
		const instance = session(async () => {
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

	it('cancels active input preparation without losing the native session or its revision', async () => {
		let calls = 0
		const instance = session(async () => {
			calls++
			return output()
		})
		await instance.initialize(await template(), async () => [], {})
		const first = await instance.update({ files: {} })
		const controller = new AbortController()
		const reason = new Error('stop preparing this update')
		await expect(
			instance.update({
				signal: controller.signal,
				files: {
					'/inputs/draft.txt': {
						kind: 'text',
						get text() {
							controller.abort(reason)
							return 'draft'
						},
					},
				},
			}),
		).rejects.toBe(reason)
		expect(calls).toBe(1)
		expect([...(await instance.exportPdf(first.revision))]).toEqual([2, 3])
		expect(await instance.update({ files: {} })).toHaveProperty('revision', first.revision + 1)
	})

	it('waits for aborted execution to finish before cleanup and releases once', async () => {
		const entered = deferred<TypstWorkerInput>()
		const executionStopped = deferred<void>()
		const abortObserved = deferred<void>()
		let released = 0
		const instance = session(
			async (input, signal) => {
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
							if ((await readFile(join(candidate, 'template/main.typ'), 'utf8')) === source.root)
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
			async (input) => {
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
			expect(released).toBe(0)
			await access(root)
		} finally {
			// This runner never starts a real worker; the test owns final deletion.
			sessions.splice(sessions.indexOf(instance), 1)
			if (root) await rm(dirname(root), { recursive: true, force: true })
		}
	})
})

it('serializes page reads with updates and checks revision when each queued read starts', async () => {
	const entered = deferred<void>(),
		resume = deferred<void>()
	let renders = 0,
		updates = 0
	const instance = session(
		async () => {
			updates++
			return output()
		},
		undefined,
		async (input) => {
			renders++
			entered.resolve()
			await resume.promise
			return {
				revision: input.revision,
				page: input.page,
				format: 'png',
				data: new Uint8Array([1]),
				width: 1,
				height: 1,
				region: { x: 0, y: 0, width: 1, height: 1 },
			}
		},
	)
	await instance.initialize(await template(), async () => [], {})
	const first = await instance.update({ files: {} })
	const image = instance.renderPage({ revision: first.revision, page: 1 })
	await entered.promise
	const update = instance.update({ files: {} })
	const stale = instance
		.renderPage({ revision: first.revision, page: 1 })
		.catch((error: unknown) => error)
	expect(updates).toBe(1)
	resume.resolve()
	const firstImage = await image
	expect(firstImage.revision).toBe(first.revision)
	const next = await update
	expect(await stale).toMatchObject({ code: 'STALE_REVISION' })
	const nextImage = await instance.renderPage({ revision: next.revision, page: 1 })
	expect(nextImage.revision).toBe(next.revision)
	expect(renders).toBe(2)
})

it('cancels an active page render with the same terminal session semantics as update', async () => {
	const entered = deferred<void>()
	const instance = session(
		async () => {
			return output()
		},
		undefined,
		async (_input, signal) => {
			entered.resolve()
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
			)
			throw new Error('Unreachable')
		},
	)
	await instance.initialize(await template(), async () => [], {})
	const first = await instance.update({ files: {} })
	const controller = new AbortController()
	const rendering = instance
		.renderPage({ revision: first.revision, page: 1, signal: controller.signal })
		.catch((error: unknown) => error)
	await entered.promise
	controller.abort(new Error('stop rendering'))
	expect(await rendering).toMatchObject({ message: 'stop rendering' })
	await expect(instance.update({ files: {} })).rejects.toMatchObject({ code: 'CLOSED' })
})
