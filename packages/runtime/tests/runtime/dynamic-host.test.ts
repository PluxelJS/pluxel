import { describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { isPluginEnabled } from '@pluxel/runtime/internal'

describe('@pluxel/runtime Context bootstrap', () => {
	it('boots core runtime services without any loader/HMR layer', async () => {
		await using fixture = await createFixture({})
		const prev = process.cwd()
		try {
			process.chdir(fixture.path)
			const runtime = createRuntimeContext({
				profile: 'test',
				configService: { mode: 'memory' },
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

	it('initializes typed nested plugin config from the host environment', async () => {
		const runtime = createRuntimeContext({
			configService: {
				mode: 'memory',
				snapshot: {
					plugins: {
						ExamplePlugin: { config: { preserved: 'snapshot', overridden: 'snapshot' } },
					},
				},
				environment: {
					PLUXEL_CONFIG__ExamplePlugin__config__allowedOrigins: '["https://app.example.test"]',
					PLUXEL_CONFIG__ExamplePlugin__config__enabled: 'true',
					PLUXEL_CONFIG__ExamplePlugin__config__limit: '12',
					PLUXEL_CONFIG__ExamplePlugin__config__overridden: 'environment',
				},
			},
		})
		try {
			expect(runtime.ctx.configService.getRawConfig('ExamplePlugin')).toEqual({
				config: {
					allowedOrigins: ['https://app.example.test'],
					enabled: true,
					limit: 12,
					overridden: 'environment',
					preserved: 'snapshot',
				},
			})
		} finally {
			await runtime.dispose()
		}
	})

	it('rejects malformed reserved plugin config environment names', () => {
		expect(
			() =>
				createRuntimeContext({
					configService: {
						mode: 'memory',
						environment: { PLUXEL_CONFIG__MissingSchema: 'value' },
					},
				}).ctx.configService,
		).toThrow('Invalid plugin config environment name')
	})

	it('keeps persisted plugin config authoritative on later starts', async () => {
		await using fixture = await createFixture({})
		const environmentName = 'PLUXEL_CONFIG__ExamplePlugin__config__publicUrl'
		const first = createRuntimeContext({
			persistence: fixture.path,
			configService: {
				mode: 'file',
				environment: { [environmentName]: 'https://first.example.test' },
			},
		})
		try {
			await first.ctx.configService.ready
			expect(first.ctx.configService.getRawConfig('ExamplePlugin')).toEqual({
				config: { publicUrl: 'https://first.example.test' },
			})
		} finally {
			await first.dispose()
		}

		const second = createRuntimeContext({
			persistence: fixture.path,
			configService: {
				mode: 'file',
				environment: { [environmentName]: 'https://second.example.test' },
			},
		})
		try {
			await second.ctx.configService.ready
			expect(second.ctx.configService.getRawConfig('ExamplePlugin')).toEqual({
				config: { publicUrl: 'https://first.example.test' },
			})
		} finally {
			await second.dispose()
		}
	})
})
