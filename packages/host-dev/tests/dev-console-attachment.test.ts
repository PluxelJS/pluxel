import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHost } from '@pluxel/host'
import type { ViteDevServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { attachDevConsole } from '../src/console/attachment'
import type { RunExecution } from '../src/console/executor'
import type { DevConsoleRunInput } from '../src/console/protocol'

const mocked = vi.hoisted(() => ({
	execute: undefined as
		| undefined
		| ((input: DevConsoleRunInput, run: RunExecution) => Promise<unknown>),
	script: vi.fn(),
	load: vi.fn(async () => {}),
}))
vi.mock('../src/runner', () => ({
	collectViteSsrImportFiles: () => [],
	importViteSsrModule: async () => {
		await mocked.load()
		return { default: mocked.script }
	},
	invalidateViteModuleGraphFiles: vi.fn(),
	invalidateViteSsrModule: vi.fn(),
}))
vi.mock('../src/console/server', () => ({
	startDevConsoleServer: async (options: { execute: typeof mocked.execute }) => {
		mocked.execute = options.execute
		return { close: async () => {}, executor: { abortAll: vi.fn() } }
	},
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
	vi.clearAllMocks()
})

async function fixture() {
	const root = await mkdtemp(resolve(tmpdir(), 'px-console-scope-'))
	cleanup.push(() => rm(root, { recursive: true, force: true }))
	const file = resolve(root, 'script.ts')
	const source = 'export default () => null'
	await writeFile(file, source)
	const application = await createHost({ plugins: [] })
	cleanup.push(() => application.close())
	const host = { ctx: application.ctx, epoch: 'first' }
	const attachment = await attachDevConsole({
		server: { config: { root } } as ViteDevServer,
		getHost: () => ({ ...host }),
		prepare: async () => {},
	})
	cleanup.push(() => attachment.close())
	const controller = new AbortController()
	const run: RunExecution = {
		signal: controller.signal,
		phase: vi.fn(),
		hostEpoch: vi.fn(),
		revision: vi.fn(),
	}
	const execute = () =>
		mocked.execute!(
			{
				runId: 'run',
				file,
				sourceHash: createHash('sha256').update(source).digest('hex'),
				exportName: 'default',
			},
			run,
		)
	return { host, run, execute }
}

it('executes against a Host without official services or configured logging', async () => {
	const current = await fixture()
	mocked.script.mockImplementation(async (dev, run) => ({
		plugins: await dev.plugins.list(),
		logger: typeof dev.ctx.logger.info,
		signal: run.signal === current.run.signal,
	}))
	expect(await current.execute()).toEqual({ plugins: [], logger: 'function', signal: true })
	expect(current.run.revision).toHaveBeenCalledTimes(2)
})

it('rejects replacement during module loading before running the script', async () => {
	const loading = Promise.withResolvers<void>()
	const ready = Promise.withResolvers<void>()
	mocked.load.mockImplementationOnce(() => {
		loading.resolve()
		return ready.promise
	})
	const current = await fixture()
	const result = current.execute()
	await loading.promise
	current.host.epoch = 'second'
	ready.resolve()
	await expect(result).rejects.toMatchObject({ code: 'host_changed' })
	expect(mocked.script).not.toHaveBeenCalled()
})
