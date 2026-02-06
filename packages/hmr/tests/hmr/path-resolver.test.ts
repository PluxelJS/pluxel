import { createFixture } from 'fs-fixture'
import { join } from 'pathe'
import { normalizePath } from 'vite'
import { describe, expect, it } from 'vitest'
import { HmrPathResolver } from '../../src/services/runtime/hmr/environment'

describe('HmrPathResolver', () => {
	it('keeps existing absolute FS paths outside scan roots', async () => {
		await using host = await createFixture({
			'scan/entry.ts': 'export const x = 1\n',
		})
		await using linked = await createFixture({
			'outside/foo.ts': 'export const y = 2\n',
		})

		const cwd = normalizePath(host.path)
		const scanRoot = normalizePath(join(host.path, 'scan'))
		const serverRoot = normalizePath(join(host.path, 'hmr-ui'))
		const outsideFile = normalizePath(join(linked.path, 'outside/foo.ts'))

		const paths = new HmrPathResolver(cwd, [scanRoot])
		paths.setServerRoot(serverRoot)

		expect(paths.toCleanId(outsideFile)).toBe(outsideFile)
	})
})
