import { describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { isPluginAutoStartEnabled, requireRuntimeStateStore } from '@pluxel/runtime/internal'
import { requireConfigService } from '@pluxel/core/internal'

const exampleAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/example' },
		exportName: 'ExamplePlugin',
	},
	variant: 'default',
} as const

const environmentSnapshot = (config: Record<string, unknown>) =>
	JSON.stringify({ version: 3, plugins: [{ owner: exampleAddress, config }] })

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

			expect(requireConfigService(ctx).isReady).toBe(true)
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
						plugins: [{ owner: exampleAddress, config: { answer: 42 } }],
					},
				},
				runtimeState: {
					mode: 'readonly',
					snapshot: { autoStart: [exampleAddress] },
				},
			})
			const ctx = runtime.ctx

			const configService = requireConfigService(ctx)
			expect(
				isPluginAutoStartEnabled(requireRuntimeStateStore(ctx).snapshot(), exampleAddress),
			).toBe(true)
			expect(configService.getRawConfig(exampleAddress)).toEqual({ answer: 42 })
			expect(() => configService.patchConfig(exampleAddress, { answer: 7 })).toThrow(
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
					plugins: [
						{
							owner: exampleAddress,
							config: { preserved: 'snapshot', overridden: 'snapshot' },
						},
					],
				},
				environment: {
					PLUXEL_CONFIG: environmentSnapshot({
						allowedOrigins: ['https://app.example.test'],
						autoStart: true,
						limit: 12,
						overridden: 'environment',
					}),
				},
			},
		})
		try {
			expect(requireConfigService(runtime.ctx).getRawConfig(exampleAddress)).toEqual({
				allowedOrigins: ['https://app.example.test'],
				autoStart: true,
				limit: 12,
				overridden: 'environment',
				preserved: 'snapshot',
			})
		} finally {
			await runtime.dispose()
		}
	})

	it('rejects malformed structured Plugin config environment snapshots', () => {
		expect(() =>
			requireConfigService(
				createRuntimeContext({
					configService: {
						mode: 'memory',
						environment: { PLUXEL_CONFIG: '{"version":1,"plugins":[]}' },
					},
				}).ctx,
			),
		).toThrow('config snapshot version 3')
	})

	it('keeps persisted plugin config authoritative on later starts', async () => {
		await using fixture = await createFixture({})
		const environment = {
			PLUXEL_CONFIG: environmentSnapshot({ publicUrl: 'https://first.example.test' }),
		}
		const first = createRuntimeContext({
			persistence: fixture.path,
			configService: {
				mode: 'file',
				environment,
			},
		})
		try {
			const configService = requireConfigService(first.ctx)
			await configService.ready
			expect(configService.getRawConfig(exampleAddress)).toEqual({
				publicUrl: 'https://first.example.test',
			})
		} finally {
			await first.dispose()
		}

		const second = createRuntimeContext({
			persistence: fixture.path,
			configService: {
				mode: 'file',
				environment: {
					PLUXEL_CONFIG: environmentSnapshot({ publicUrl: 'https://second.example.test' }),
				},
			},
		})
		try {
			const configService = requireConfigService(second.ctx)
			await configService.ready
			expect(configService.getRawConfig(exampleAddress)).toEqual({
				publicUrl: 'https://first.example.test',
			})
		} finally {
			await second.dispose()
		}
	})
})
