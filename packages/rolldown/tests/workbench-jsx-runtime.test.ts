import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { afterEach, expect, it, vi } from 'vitest'
import { runWorkbenchViteBuild } from '../src/vite/workbench-vite-build'

afterEach(() => vi.unstubAllEnvs())
it('builds development renderers for the JSX runtime supplied by a packaged Shell', async () => {
	vi.stubEnv('NODE_ENV', 'development')
	await using fixture = await createDiskFixture({
		'package.json': '{"name":"jsx-runtime-probe","type":"module"}',
		'view.tsx': 'export default function View() { return <div>ready</div> }',
	})
	await runWorkbenchViteBuild({
		producerRoot: fixture.getPath(),
		declarationRoot: fixture.getPath(),
		applicationRoot: fileURLToPath(new URL('../../workbench', import.meta.url)),
		packageMode: 'development',
		outDir: fixture.getPath('dist'),
		producer: 'jsx_probe',
		exposes: { './views/main': fixture.getPath('view.tsx') },
		cacheDir: fixture.getPath('cache'),
		shared: {
			'react/jsx-runtime': { import: false, singleton: true, requiredVersion: false },
			'react/jsx-dev-runtime': { import: false, singleton: true, requiredVersion: false },
		},
		bridgeReactEntry: 'unused',
		minify: false,
		sourcemap: false,
		typeAssets: 'optional',
		paraglide: null,
	})
	const files = await readdir(fixture.getPath('dist/assets'))
	const chunks = await Promise.all(
		files
			.filter((file) => file.endsWith('.js'))
			.map((file) => readFile(fixture.getPath('dist/assets/' + file), 'utf8')),
	)
	const code = chunks.join('\n')
	// MF may retain a side-effect-only export descriptor; no callable binding may use jsxDEV.
	expect(code).not.toMatch(/=\s*exportModule\["jsxDEV"\]/)
	expect(code).toMatch(/=\s*exportModule\["jsx"\]/)
})
