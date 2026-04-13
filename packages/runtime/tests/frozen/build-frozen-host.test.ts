import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'

import { buildFrozenHost } from '@pluxel/runtime/frozen'

describe('@pluxel/runtime/frozen buildFrozenHost', () => {
	it('writes a generated frozen bootstrap and manifest', async () => {
		await using fixture = await createFixture({})
		const outDir = resolve(fixture.path, 'dist')
		const res = await buildFrozenHost({
			outDir,
			profile: 'prod',
			fs: {
				mkdir: fixture.fsp.mkdir,
				writeFile: fixture.fsp.writeFile,
			},
			plugins: [
				{
					moduleId: '@scope/example',
					importPath: '@scope/example/dist/index.mjs',
					exportKey: 'default',
					source: 'installed-dist',
				},
			],
			enabled: ['ExamplePlugin'],
		})

		const entry = await fixture.fsp.readFile(res.entry, 'utf-8')
		const manifest = JSON.parse(await fixture.fsp.readFile(res.manifestPath, 'utf-8'))

		expect(entry).toContain("import '@pluxel/runtime'")
		expect(entry).toContain('@scope/example/dist/index.mjs')
		expect(manifest.profile).toBe('prod')
		expect(manifest.plugins).toHaveLength(1)
	})
})
