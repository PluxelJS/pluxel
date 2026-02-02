import { describe, expect, it } from 'bun:test'
import { HmrPathResolver } from '../../src/services/runtime/hmr/environment'

describe('HmrPathResolver', () => {
	it('resolves relative filesystem paths against cwd (not Vite server root)', () => {
		const cwd = '/repo'
		const paths = new HmrPathResolver(cwd, ['/repo/packages/a'])
		paths.setServerRoot('/repo/packages/hmr')

		expect(paths.toCleanId('packages/app/src/index.ts')).toBe('/repo/packages/app/src/index.ts')
	})
})
