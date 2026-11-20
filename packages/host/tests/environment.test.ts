import { expect, it, vi } from 'vitest'
import { resolveHostEnv } from '../src/environment'

it('uses only the supplied environment and keeps previously resolved values', async () => {
	vi.stubEnv('PLUXEL_HOST_PORT', 'invalid')
	try {
		vi.resetModules()
		const { resolveHostEnv: resolveAfterImport } = await import('../src/environment')
		expect(resolveAfterImport({})).toEqual({ dataRoot: '.pluxel' })
		const env = { PLUXEL_DATA_ROOT: ' ./state ', PLUXEL_WORKBENCH: 'FALSE' }
		const snapshot = resolveAfterImport(env)
		env.PLUXEL_DATA_ROOT = './next'
		expect(snapshot).toEqual({ dataRoot: './state', workbench: false })
		expect(resolveAfterImport(env).dataRoot).toBe('./next')
	} finally {
		vi.unstubAllEnvs()
	}
})

it('uses launcher defaults and lets the explicit configuration override each value', () => {
	const launcher = { HOST: '127.0.0.1', PORT: '4321', PITCHFORK_URL: 'https://launcher.test' }
	expect(resolveHostEnv(launcher)).toEqual({
		dataRoot: '.pluxel',
		hostBind: '127.0.0.1',
		hostPort: 4321,
		publicOrigin: 'https://launcher.test',
	})
	expect(
		resolveHostEnv({
			...launcher,
			PLUXEL_HOST_BIND: ' 0.0.0.0 ',
			PLUXEL_HOST_PORT: '0',
			PLUXEL_PUBLIC_ORIGIN: 'https://public.test/',
		}),
	).toEqual({
		dataRoot: '.pluxel',
		hostBind: '0.0.0.0',
		hostPort: 0,
		publicOrigin: 'https://public.test',
	})
})

it.each([
	['PLUXEL_PUBLIC_ORIGIN', 'https://public.test/path'],
	['PLUXEL_PUBLIC_ORIGIN', 'https://user:pass@public.test'],
	['PLUXEL_PUBLIC_ORIGIN', 'ftp://public.test'],
	['PITCHFORK_URL', 'launcher.test'],
	['PLUXEL_HOST_PORT', '12px'],
	['PORT', 'auto'],
	['PLUXEL_WORKBENCH', 'yes'],
	['PLUXEL_DATA_ROOT', '  '],
])('rejects invalid %s value %s', (key, value) => {
	expect(() => resolveHostEnv({ [key]: value })).toThrow(key)
})
