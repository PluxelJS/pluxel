import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

import { materializeProfiledFile } from '../../src/hmr/host/storage'

describe('loader HMR storage helpers', () => {
	it('materializes profiled storage files, including seed fallback', async () => {
		await using fixture = await createFixture({
			'.pluxel/loader-hmr/config.json': '{"seed":true}\n',
		})

		const resolved = await materializeProfiledFile(
			resolve(fixture.path, '.pluxel/loader-hmr/config.json'),
			{
				profile: 'dev',
				seedFile: resolve(fixture.path, '.pluxel/loader-hmr/config.json'),
			},
			fixture.fs,
		)

		expect(resolved.path).toBe(resolve(fixture.path, '.pluxel/loader-hmr/config.dev.json'))
		expect(fixture.fs.existsSync(resolved.path)).toBe(true)
	})
})
