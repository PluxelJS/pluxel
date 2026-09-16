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
				ssr: {
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
