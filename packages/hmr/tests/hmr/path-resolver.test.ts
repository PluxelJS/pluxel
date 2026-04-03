import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { join } from 'pathe'
import { symlinkSync } from 'node:fs'
import { normalizePath } from 'vite'
import { describe, expect, it } from 'vitest'
import { HmrPathResolver } from '../../src/dev/hmr/environment'

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

	it('normalizes /@fs/ Windows drive paths and emits variants', () => {
		const paths = new HmrPathResolver('C:/workspace', ['C:/workspace/packages'])
		paths.setServerRoot('C:/workspace/runtime-ui')

		const clean = paths.toCleanId('/@fs/C:/workspace/runtime-ui/src/client.tsx')
		expect(clean).toBe('C:/workspace/runtime-ui/src/client.tsx')

		expect(paths.moduleIdVariantsClean(clean)).toEqual([
			'C:/workspace/runtime-ui/src/client.tsx',
			'/@fs/C:/workspace/runtime-ui/src/client.tsx',
			'/src/client.tsx',
		])
	})

	it('realpaths symlinked workspace files back into scan roots', async () => {
		await using host = await createFixture({
			'scan/entry.ts': 'export const x = 1\n',
			'links/.keep': '',
		})

		const cwd = normalizePath(host.path)
		const scanRoot = normalizePath(join(host.path, 'scan'))
		const linkDir = join(host.path, 'links/s')
		symlinkSync(join(host.path, 'scan'), linkDir, 'dir')

		const fileViaSymlink = normalizePath(join(linkDir, 'entry.ts'))
		const expected = normalizePath(join(scanRoot, 'entry.ts'))

		const paths = new HmrPathResolver(cwd, [scanRoot])
		expect(paths.toCleanId(fileViaSymlink)).toBe(expected)
	})
})
