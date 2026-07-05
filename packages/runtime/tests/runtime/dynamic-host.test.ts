import { describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { isPluginEnabled } from '@pluxel/runtime/runtime-state'

describe('@pluxel/runtime Context bootstrap', () => {
	it('boots core runtime services without any loader/HMR layer', async () => {
		await using fixture = await createFixture({})
		const prev = process.cwd()
		try {
			process.chdir(fixture.path)
			const runtime = createRuntimeContext({
				profile: 'test',
				configService: { mode: 'memory' },
				packageService: {
					policy: { allowInstall: false, allowUninstall: false },
					state: { enabled: false },
				},
				extensionService: { enabled: false },
			})
			const ctx = runtime.ctx

			expect(ctx.configService.isReady).toBe(true)
			expect((ctx as unknown as { loader?: unknown }).loader).toBeUndefined()
			expect((ctx as unknown as { packageService?: unknown }).packageService).toBeUndefined()
			await runtime.dispose()
		} finally {
			process.chdir(prev)
		}
	})

	it('supports readonly config snapshots for frozen-style bootstraps', async () => {
		await using fixture = await createFixture({})
		const prev = process.cwd()
		try {
			process.chdir(fixture.path)
			const runtime = createRuntimeContext({
				profile: 'test',
				configService: {
					mode: 'readonly',
					snapshot: {
						plugins: {
							ExamplePlugin: { answer: 42 },
						},
					},
				},
				runtimeState: {
					mode: 'readonly',
					snapshot: { enabled: ['ExamplePlugin'] },
				},
				packageService: {
					policy: { allowInstall: false, allowUninstall: false },
					state: { enabled: false },
				},
				extensionService: { enabled: false },
			})
			const ctx = runtime.ctx

			expect(isPluginEnabled(ctx.runtimeState.snapshot(), 'ExamplePlugin')).toBe(true)
			expect(ctx.configService.getRawConfig('ExamplePlugin')).toEqual({ answer: 42 })
			expect(() => ctx.configService.patchConfig('ExamplePlugin', { answer: 7 })).toThrow(
				/readonly mode/i,
			)
			await runtime.dispose()
		} finally {
			process.chdir(prev)
		}
	})
})
