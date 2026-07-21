import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import { pluxelRuntimeSourceVitePlugins } from '@pluxel/rolldown/vite'

import { importViteSsrModule } from '../src/vite'

describe('runtime-dev Vite plugin stack', () => {
	it('exposes source/server semantics as a dedicated plugin', () => {
		const plugins = pluxelRuntimeSourceVitePlugins() as Plugin[]
		const plugin = plugins.at(-1)!
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

	it('exposes one source plugin group with server-only transforms', async () => {
		const plugins = pluxelRuntimeSourceVitePlugins({
			root: '/repo',
		}) as Plugin[]

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'unplugin-preprocessor-directives',
			'pluxel:database-source',
			'pluxel:plugin-semantics',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel:runtime-source',
		])
		for (const plugin of plugins.slice(1, -1)) {
			const server = await plugin.applyToEnvironment?.({
				name: 'ssr',
				config: { consumer: 'server' },
			} as never)
			const client = await plugin.applyToEnvironment?.({
				name: 'client',
				config: { consumer: 'client' },
			} as never)
			expect(server).not.toBe(false)
			expect(client).toBe(false)
		}
	})

	it('applies preprocessor semantics through the real Vite module runner', async () => {
		const root = await mkdtemp(join(process.cwd(), '.pluxel-runtime-dev-source-pipeline-'))
		const modulePath = join(root, 'plugin.ts')
		await writeFile(
			modulePath,
			[
				'// #define PLUXEL_PIPELINE',
				'',
				'// #if PLUXEL_PIPELINE',
				"export const branch = 'included'",
				'// #else',
				"export const branch = 'excluded'",
				'// #endif',
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
				plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
			})
			const mod = await importViteSsrModule<{ branch: string }>(server, modulePath)
			expect(mod.branch).toBe('included')
		} finally {
			await server?.close()
			await rm(root, { recursive: true, force: true })
		}
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
				plugins: pluxelRuntimeSourceVitePlugins({ lintGuard: false, configSource: false }),
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
