import { env as standardEnvironment } from 'std-env'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { describePluxelPlatform, env, hostEnv, resolveHostEnv } from '../src/environment'

declare module '../src/environment' {
	interface PluxelEnvironmentVariables {
		readonly APPLICATION_REGION?: string
	}
}

describe('Pluxel environment', () => {
	it('re-exports the std-env object with official variables typed', () => {
		expect(env).toBe(standardEnvironment)
		expectTypeOf(env.PLUXEL_WORKBENCH).toEqualTypeOf<'true' | 'false' | undefined>()
		expectTypeOf(env.PLUXEL_HOST_PORT).toEqualTypeOf<string | undefined>()
		expectTypeOf(env.PORTLESS_URL).toEqualTypeOf<string | undefined>()
		expectTypeOf(env.APPLICATION_REGION).toEqualTypeOf<string | undefined>()
	})

	it('publishes one validated Host environment with a stable data root default', () => {
		expect(hostEnv).toEqual(resolveHostEnv(env))
		expect(hostEnv.dataRoot).toBe(env.PLUXEL_DATA_ROOT?.trim() || '.pluxel')
		expect(Object.isFrozen(hostEnv)).toBe(true)
	})

	it('validates explicit host behavior and applies only the framework-wide data root default', () => {
		expect(
			resolveHostEnv({
				PLUXEL_DATA_ROOT: ' ./state ',
				PLUXEL_WORKBENCH: 'FALSE',
				PLUXEL_HOST_BIND: ' 127.0.0.1 ',
				PLUXEL_HOST_PORT: '0',
			}),
		).toEqual({
			dataRoot: './state',
			workbench: false,
			hostBind: '127.0.0.1',
			hostPort: 0,
		})
		expect(resolveHostEnv({})).toEqual({ dataRoot: '.pluxel' })
	})

	it('adopts Portless listener values without overriding explicit Pluxel host policy', () => {
		expect(
			resolveHostEnv({
				PORTLESS_URL: 'https://rhythm.localhost',
				HOST: '127.0.0.1',
				PORT: '4321',
			}),
		).toEqual({
			dataRoot: '.pluxel',
			hostBind: '127.0.0.1',
			hostPort: 4321,
			portlessOrigin: 'https://rhythm.localhost',
		})
		expect(
			resolveHostEnv({
				PORTLESS_URL: 'https://rhythm.localhost/',
				HOST: '127.0.0.1',
				PORT: '4321',
				PLUXEL_HOST_BIND: '0.0.0.0',
				PLUXEL_HOST_PORT: '3310',
			}),
		).toMatchObject({ hostBind: '0.0.0.0', hostPort: 3310 })
		expect(resolveHostEnv({ HOST: '127.0.0.1', PORT: '4321' })).toEqual({
			dataRoot: '.pluxel',
		})
	})

	it('rejects malformed explicit values', () => {
		expect(() => resolveHostEnv({ PLUXEL_WORKBENCH: 'yes' })).toThrow(
			'PLUXEL_WORKBENCH must be "true" or "false"',
		)
		expect(() => resolveHostEnv({ PLUXEL_HOST_PORT: '12px' })).toThrow(
			'PLUXEL_HOST_PORT must be an integer',
		)
		expect(() => resolveHostEnv({ PLUXEL_DATA_ROOT: '  ' })).toThrow(
			'PLUXEL_DATA_ROOT must not be empty',
		)
		expect(() => resolveHostEnv({ PORTLESS_URL: 'rhythm.localhost' })).toThrow(
			'PORTLESS_URL must be an HTTP(S) origin',
		)
		expect(() =>
			resolveHostEnv({ PORTLESS_URL: 'https://rhythm.localhost/path', PORT: '4321' }),
		).toThrow('PORTLESS_URL must be an HTTP(S) origin')
		expect(() =>
			resolveHostEnv({ PORTLESS_URL: 'https://rhythm.localhost', PORT: 'auto' }),
		).toThrow('PORT must be an integer')
	})

	it('returns a deeply frozen non-secret platform snapshot', () => {
		const snapshot = describePluxelPlatform()
		expect(snapshot.runtime.name).toEqual(expect.any(String))
		expect(snapshot.deployment.ci).toEqual(expect.any(Boolean))
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.runtime)).toBe(true)
		expect(Object.isFrozen(snapshot.deployment)).toBe(true)
	})
})
