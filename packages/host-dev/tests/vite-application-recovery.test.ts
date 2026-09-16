import { EventEmitter } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { watch } from 'chokidar'
import type { ViteDevServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { ViteApplicationRecovery } from '../src/internal/vite-application-recovery.ts'

vi.mock('chokidar', () => ({ watch: vi.fn() }))

afterEach(() => vi.clearAllMocks())

async function pendingRecovery(root = '/tmp') {
	const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
	vi.mocked(watch).mockReturnValue(watcher as never)
	const logger = { error: vi.fn() }
	const onChange = vi.fn(async () => {})
	const entry = resolve(root, 'recovery-entry.ts')
	const recovery = new ViteApplicationRecovery()
	recovery.attach(
		{
			config: {
				root,
				resolve: { extensions: ['.ts', '.js'] },
				server: { watch: {} },
				logger,
			},
			environments: {
				ssr: {
					moduleGraph: { getModulesByFile: () => new Set() },
					pluginContainer: { watchChange: vi.fn(async () => {}) },
				},
			},
		} as unknown as ViteDevServer,
		onChange,
	)
	recovery.begin(entry)
	const resolveId = recovery.plugin.resolveId
	if (typeof resolveId !== 'function') throw new Error('Expected a recovery resolution observer')
	await Reflect.apply(resolveId, { resolve: async () => null }, [
		'hmr-recovery-test-package',
		entry,
		{ ssr: true },
	])
	const failure = recovery.failed()
	await vi.waitFor(() => expect(watcher.listenerCount('ready')).toBe(1))
	return { recovery, watcher, logger, failure, onChange }
}

it('releases pending watcher readiness when the route closes', async () => {
	const { recovery, watcher, failure } = await pendingRecovery()
	await recovery.close()
	await expect(failure).resolves.toMatchObject({
		imports: [{ source: 'hmr-recovery-test-package' }],
	})
	expect(watcher.close).toHaveBeenCalledOnce()
})

it('reports every watcher error after readiness without losing the listener', async () => {
	const { recovery, watcher, logger, failure } = await pendingRecovery()
	try {
		watcher.emit('ready')
		await failure
		const first = new Error('first filesystem failure')
		const second = new Error('second filesystem failure')
		watcher.emit('error', first)
		watcher.emit('error', second)
		expect(logger.error).toHaveBeenNthCalledWith(1, 'Application recovery watcher failed', {
			error: first,
		})
		expect(logger.error).toHaveBeenNthCalledWith(2, 'Application recovery watcher failed', {
			error: second,
		})
	} finally {
		await recovery.close()
	}
})

it('recovers installation completed before the watcher reports ready', async () => {
	await using fixture = await createDiskFixture({})
	const { recovery, watcher, failure, onChange } = await pendingRecovery(fixture.path)
	try {
		const installed = resolve(fixture.path, 'node_modules/hmr-recovery-test-package')
		await mkdir(installed, { recursive: true })
		await writeFile(
			resolve(installed, 'package.json'),
			JSON.stringify({ name: 'hmr-recovery-test-package' }),
		)
		watcher.emit('ready')
		await failure
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce())
		expect(onChange).toHaveBeenCalledWith(installed, 'create')
	} finally {
		await recovery.close()
	}
})

it('does not retry an unchanged failed import after watcher setup', async () => {
	const { recovery, watcher, failure, onChange } = await pendingRecovery()
	try {
		watcher.emit('ready')
		await failure
		expect(onChange).not.toHaveBeenCalled()
	} finally {
		await recovery.close()
	}
})
