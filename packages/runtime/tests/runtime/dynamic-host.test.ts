import { describe, expect, it } from 'vitest'
import { createFixture } from 'fs-fixture'

import { Context } from '@pluxel/runtime'

describe('@pluxel/runtime Context bootstrap', () => {
	it('boots core runtime services without any HMR/Vite layer', async () => {
		await using fixture = await createFixture({})
		const prev = process.cwd()
		try {
			process.chdir(fixture.path)
			const ctx = new Context({
				profile: 'test',
				configService: { mode: 'memory' },
				packageService: {
					policy: { allowInstall: false, allowUninstall: false },
					state: { enabled: false },
				},
				extensionService: { enabled: false },
			})

			expect(ctx.configService.isReady).toBe(true)
			expect(ctx.loader).toBeTruthy()
			expect(ctx.packageService).toBeTruthy()
			await ctx.effects.dispose()
		} finally {
			process.chdir(prev)
		}
	})

	it('supports readonly config snapshots for frozen-style bootstraps', async () => {
		await using fixture = await createFixture({})
		const prev = process.cwd()
		try {
			process.chdir(fixture.path)
			const ctx = new Context({
				profile: 'test',
				configService: {
					mode: 'readonly',
					snapshot: {
						enabled: ['ExamplePlugin'],
						plugins: {
							ExamplePlugin: { answer: 42 },
						},
					},
				},
				packageService: {
					policy: { allowInstall: false, allowUninstall: false },
					state: { enabled: false },
				},
				extensionService: { enabled: false },
			})

			expect(ctx.configService.isEnabledInConfig('ExamplePlugin')).toBe(true)
			expect(ctx.configService.getRawConfig('ExamplePlugin')).toEqual({ answer: 42 })
			expect(() => ctx.configService.patchConfig('ExamplePlugin', { answer: 7 })).toThrow(
				/readonly mode/i,
			)
			await ctx.effects.dispose()
		} finally {
			process.chdir(prev)
		}
	})
})
