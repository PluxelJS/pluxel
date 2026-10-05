import { HOST_VITE_ENVIRONMENT } from '../src/environment'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDiskFixture } from '@pluxel/test/fixtures'
import type { ViteDevServer } from 'vite'
import { expect, it, vi } from 'vitest'
import { ViteApplicationRecovery } from '../src/internal/vite-application-recovery.ts'

it('observes an installation after overlapping missing-package search roots finish scanning', async () => {
	await using fixture = await createDiskFixture(
		{},
		{ tempDir: fileURLToPath(new URL('.', import.meta.url)) },
	)
	const root = resolve(fixture.path, 'app')
	const entry = resolve(root, 'src/entry.ts')
	await mkdir(resolve(root, 'src'), { recursive: true })
	await mkdir(resolve(root, 'node_modules'), { recursive: true })
	const onChange = vi.fn(async () => {})
	const watchChange = vi.fn(async () => {})
	const logger = { error: vi.fn() }
	const recovery = new ViteApplicationRecovery()
	recovery.attach(
		{
			config: { root, resolve: { extensions: ['.js'] }, server: { watch: {} }, logger },
			environments: {
				[HOST_VITE_ENVIRONMENT]: {
					moduleGraph: { getModulesByFile: () => new Set() },
					pluginContainer: { watchChange },
				},
			},
		} as unknown as ViteDevServer,
		onChange,
	)
	try {
		recovery.begin(entry)
		const resolveId = recovery.plugin.resolveId
		if (typeof resolveId !== 'function') throw new Error('Expected a recovery resolution observer')
		await Reflect.apply(resolveId, { resolve: async () => null }, [
			'hmr-recovery-test-package',
			entry,
			{ ssr: true },
		])
		await recovery.failed()

		// Readiness must mean future writes are observed, independently of the setup-gap check.
		const packageRoot = resolve(root, 'node_modules/hmr-recovery-test-package')
		const manifest = resolve(packageRoot, 'package.json')
		await mkdir(packageRoot, { recursive: true })
		await writeFile(manifest, JSON.stringify({ name: 'hmr-recovery-test-package' }))
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(manifest, 'create'))
		expect(watchChange).toHaveBeenCalledWith(manifest, { event: 'create' })
		expect(logger.error).not.toHaveBeenCalled()
	} finally {
		await recovery.close()
	}
})

it('closes the recovery observer and drains a rejected hook accepted before update admission', async () => {
	await using fixture = await createDiskFixture({
		'src/entry.ts': '',
		'node_modules/recovery-close-test/package.json': '{}',
	})
	const root = fixture.path
	const entry = resolve(root, 'src/entry.ts')
	const manifest = resolve(root, 'node_modules/recovery-close-test/package.json')
	const baseline = process.getActiveResourcesInfo().filter((name) => name === 'StatWatcher').length
	const started = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const failure = new Error('RECOVERY_HOOK_FAILED')
	const onError = vi.fn()
	const onChange = vi.fn(async () => {})
	const watchChange = vi.fn(async () => {
		started.resolve()
		await release.promise
	})
	const rejectedChange = vi.fn(async () => {
		throw failure
	})
	const recovery = new ViteApplicationRecovery()
	recovery.attach(
		{
			config: {
				root,
				resolve: { extensions: ['.js'] },
				server: { watch: {} },
				logger: { error: vi.fn() },
			},
			environments: {
				[HOST_VITE_ENVIRONMENT]: {
					moduleGraph: { getModulesByFile: () => new Set() },
					pluginContainer: { watchChange },
				},
				client: { pluginContainer: { watchChange: rejectedChange } },
			},
		} as unknown as ViteDevServer,
		onChange,
		onError,
	)
	try {
		recovery.begin(entry)
		const resolveId = recovery.plugin.resolveId
		if (typeof resolveId !== 'function') throw new Error('Expected a recovery resolution observer')
		await Reflect.apply(resolveId, { resolve: async () => null }, [
			'recovery-close-test',
			entry,
			{ ssr: true },
		])
		await recovery.failed()
		await writeFile(manifest, '{"name":"recovery-close-test"}')
		await started.promise
		await new Promise<void>((resolveHooks) => setImmediate(resolveHooks))
		const closing = recovery.close()
		expect(recovery.close()).toBe(closing)
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
		expect(
			process.getActiveResourcesInfo().filter((name) => name === 'StatWatcher').length,
		).toBeLessThanOrEqual(baseline)
		release.resolve()
		await expect(closing).rejects.toMatchObject({ cause: failure, errors: [failure] })
		expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
		expect(onChange).not.toHaveBeenCalled()
		expect(rejectedChange).toHaveBeenCalled()
	} finally {
		release.resolve()
		await Promise.allSettled([recovery.close()])
	}
})
