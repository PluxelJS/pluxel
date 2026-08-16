import { describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { isPluginEnabled } from '@pluxel/runtime/internal'

const exampleAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/example' },
		exportName: 'ExamplePlugin',
	},
	instance: 'default',
} as const

const environmentSnapshot = (config: Record<string, unknown>) =>
	JSON.stringify({ version: 2, plugins: [{ owner: exampleAddress, config }] })

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
						plugins: [{ owner: exampleAddress, config: { answer: 42 } }],
					},
				},
				runtimeState: {
					mode: 'readonly',
					snapshot: { enabled: [exampleAddress] },
				},
			})
			const ctx = runtime.ctx

			const owner = ctx.registry.internNodeAddress(exampleAddress)
			expect(isPluginEnabled(ctx.runtimeState.snapshot(), exampleAddress)).toBe(true)
			expect(ctx.configService.getRawConfig(owner)).toEqual({ answer: 42 })
			expect(() => ctx.configService.patchConfig(owner, { answer: 7 })).toThrow(/readonly mode/i)
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
						enabled: true,
						limit: 12,
						overridden: 'environment',
					}),
				},
			},
		})
		try {
			const owner = runtime.ctx.registry.internNodeAddress(exampleAddress)
			expect(runtime.ctx.configService.getRawConfig(owner)).toEqual({
				allowedOrigins: ['https://app.example.test'],
				enabled: true,
				limit: 12,
				overridden: 'environment',
				preserved: 'snapshot',
			})
		} finally {
			await runtime.dispose()
		}
	})

	it('rejects malformed structured Plugin config environment snapshots', () => {
		expect(
			() =>
				createRuntimeContext({
					configService: {
						mode: 'memory',
						environment: { PLUXEL_CONFIG: '{"version":1,"plugins":[]}' },
					},
				}).ctx.configService,
		).toThrow('config snapshot version 2')
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
			await first.ctx.configService.ready
			const owner = first.ctx.registry.internNodeAddress(exampleAddress)
			expect(first.ctx.configService.getRawConfig(owner)).toEqual({
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
			await second.ctx.configService.ready
			const owner = second.ctx.registry.internNodeAddress(exampleAddress)
			expect(second.ctx.configService.getRawConfig(owner)).toEqual({
				publicUrl: 'https://first.example.test',
			})
		} finally {
			await second.dispose()
		}
	})
})
