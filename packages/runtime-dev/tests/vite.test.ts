import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

import { importViteSsrModule, pluxelRuntimeSourceVitePlugin } from '../src/vite'

async function resolveEnvironmentPluginNames(
	plugin: ReturnType<typeof pluxelRuntimeSourceVitePlugin>,
	environment: { name: string; config: { consumer: 'server' | 'client' } },
): Promise<string[]> {
	const applied = await plugin.applyToEnvironment?.(environment as never)
	if (!applied || applied === true) return []
	const plugins = (
		Array.isArray(applied) ? applied.flat(Number.POSITIVE_INFINITY) : [applied]
	) as Array<{
		name?: string
	}>
	return plugins.filter(Boolean).map((item) => item.name ?? '')
}

describe('runtime-dev Vite plugin stack', () => {
	it('exposes source/server semantics as a dedicated plugin', () => {
		const plugin = pluxelRuntimeSourceVitePlugin()
		const config = plugin.config?.({} as never, { command: 'serve', mode: 'development' }) as {
			resolve?: { conditions?: string[]; externalConditions?: string[]; dedupe?: string[] }
			environments?: { ssr?: { resolve?: { conditions?: string[] } } }
			ssr?: { external?: string[]; resolve?: { conditions?: string[] } }
			oxc?: { decorator?: { legacy?: boolean; emitDecoratorMetadata?: boolean } }
		}

		expect(plugin.name).toBe('pluxel:runtime-source')
		expect(config.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', 'node', 'import', 'default']),
		)
		expect(config.environments?.ssr?.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', 'node', 'import', 'default']),
		)
		expect(config.ssr?.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', 'node', 'import', 'default']),
		)
		expect(config.resolve?.externalConditions).not.toContain('@pluxel/source')
		expect(config.resolve?.dedupe).toEqual(
			expect.arrayContaining(['@pluxel/core', '@pluxel/runtime']),
		)
		expect(config.ssr?.external).toEqual(expect.arrayContaining(['@pluxel/runtime']))
		expect(config.ssr?.external).not.toContain('@pluxel/core')
		expect(config.oxc?.decorator?.legacy).toBe(true)
		expect(config.oxc?.decorator?.emitDecoratorMetadata).toBe(true)
	})

	it('expands source transforms only inside server Vite environments', async () => {
		const plugin = pluxelRuntimeSourceVitePlugin({
			root: '/repo',
			serverOnlyName: 'pluxel:test-source-transform',
		})

		await expect(
			resolveEnvironmentPluginNames(plugin, { name: 'ssr', config: { consumer: 'server' } }),
		).resolves.toEqual([
			'pluxel:test-source-transform',
			'pluxel-lint-guard',
			'pluxel-config-source',
		])
		await expect(
			resolveEnvironmentPluginNames(plugin, { name: 'client', config: { consumer: 'client' } }),
		).resolves.toEqual([])
	})

	it('loads SSR modules through the source-map aware Vite module runner', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-runtime-dev-'))
		const modulePath = join(root, 'probe.ts')
		await writeFile(
			modulePath,
			['export function captureStack() {', "  return new Error('probe').stack", '}', ''].join('\n'),
		)

		let server: ViteDevServer | undefined
		try {
			server = await createServer({
				root,
				logLevel: 'silent',
				server: { middlewareMode: true },
				appType: 'custom',
			})
			const mod = await importViteSsrModule<{ captureStack(): string }>(server, modulePath)

			expect(mod.captureStack()).toMatch(/probe\.ts:2:\d+/)
		} finally {
			await server?.close()
			await rm(root, { recursive: true, force: true })
		}
	})

	it('emits constructor dependency metadata through the real Vite module runner', async () => {
		const root = await mkdtemp(join(process.cwd(), '.pluxel-runtime-dev-metadata-'))
		const modulePath = join(root, 'plugin.ts')
		await writeFile(
			modulePath,
			[
				'const metadata = new WeakMap<object, Map<string, unknown>>()',
				';(Reflect as any).metadata = (key: string, value: unknown) => (target: object) => { const values = metadata.get(target) ?? new Map(); values.set(key, value); metadata.set(target, values) }',
				';(Reflect as any).getMetadata = (key: string, target: object) => metadata.get(target)?.get(key)',
				'function Plugin(): ClassDecorator { return () => {} }',
				'export class Provider {}',
				'@Plugin()',
				'export class Consumer { constructor(readonly provider: Provider) {} }',
				"export const params = Reflect.getMetadata('design:paramtypes', Consumer)",
				'',
			].join('\n'),
		)

		let server: ViteDevServer | undefined
		try {
			server = await createServer({
				root,
				logLevel: 'silent',
				server: { middlewareMode: true },
				appType: 'custom',
				plugins: [pluxelRuntimeSourceVitePlugin({ lintGuard: false, configSource: false })],
			})
			const mod = await importViteSsrModule<{ Provider: unknown; params: unknown[] }>(
				server,
				modulePath,
			)
			expect(mod.params).toEqual([mod.Provider])
		} finally {
			await server?.close()
			await rm(root, { recursive: true, force: true })
		}
	})
})
