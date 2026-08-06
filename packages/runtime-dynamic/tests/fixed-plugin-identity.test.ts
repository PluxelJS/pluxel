import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceRoot } from './hmr/_paths.ts'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('dynamic fixed plugin module identity', () => {
	it('evaluates config fixed providers and mutable consumers in one real Vite namespace', async () => {
		const root = await mkdtemp(resolve(workspaceRoot, 'packages/runtime-dynamic/tests/.identity-'))
		roots.push(root)
		await mkdir(resolve(root, 'entries'), { recursive: true })
		await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
		await writeFile(
			resolve(root, 'pluxel.loader.hmr.jsonc'),
			JSON.stringify({
				version: 2,
				profile: 'test',
				defaults: { roots: [] },
				profiles: { test: { enabled: [] } },
			}),
		)
		await writeFile(
			resolve(root, 'fixed-provider.ts'),
			[
				"import { BasePlugin, Plugin } from '@pluxel/runtime'",
				"@Plugin({ name: 'FixedProvider' })",
				'export class FixedProvider extends BasePlugin { readonly value = 42 }',
				'',
			].join('\n'),
		)
		await writeFile(
			resolve(root, 'entries/mutable-consumer.ts'),
			[
				"import { BasePlugin, Plugin } from '@pluxel/runtime'",
				"import { FixedProvider } from '../fixed-provider'",
				"@Plugin({ name: 'MutableConsumer' })",
				'export class MutableConsumer extends BasePlugin {',
				'  constructor(readonly provider: FixedProvider) { super() }',
				'}',
				'',
			].join('\n'),
		)
		const configPath = resolve(root, 'pluxel.dynamic.ts')
		await writeFile(
			configPath,
			[
				"import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'",
				"import { FixedProvider } from './fixed-provider'",
				'export default defineDynamicRuntimeConfig({',
				`  root: ${JSON.stringify(root)},`,
				"  configPath: 'pluxel.loader.hmr.jsonc',",
				"  profile: 'test',",
				'  plugins: [FixedProvider],',
				"  sources: [{ kind: 'directory', path: 'entries', include: ['*.ts'] }],",
				"  runtimeState: { mode: 'memory', snapshot: { enabled: ['FixedProvider', 'MutableConsumer'] } },",
				"  configService: { mode: 'memory' },",
				'  logging: false,',
				'  printUrls: false,',
				'})',
				'',
			].join('\n'),
		)

		const runner = resolve(root, 'verify.mts')
		const viteEntry = pathToFileURL(
			resolve(workspaceRoot, 'packages/runtime-dynamic/src/vite.ts'),
		).href
		await writeFile(
			runner,
			[
				"import assert from 'node:assert/strict'",
				"import { resolve } from 'node:path'",
				"import { createServer } from 'vite'",
				`import { dynamicRuntimeVitePlugin } from ${JSON.stringify(viteEntry)}`,
				`const root = ${JSON.stringify(root)}`,
				`const workspaceRoot = ${JSON.stringify(workspaceRoot)}`,
				'const server = await createServer({',
				'  configFile: false,',
				"  root: resolve(workspaceRoot, 'packages/runtime-dynamic'),",
				"  cacheDir: resolve(root, '.vite-cache'),",
				`  plugins: dynamicRuntimeVitePlugin({ config: ${JSON.stringify(configPath)} }),`,
				'  server: { middlewareMode: true, watch: { usePolling: true, interval: 20 } },',
				'})',
				'try {',
				"  const controller = server[Symbol.for('pluxel.dynamicRuntimeController')]",
				'  assert.ok(controller)',
				"  const fixed = controller.booted.ctx.loader.api.registry.getCtor('FixedProvider')",
				"  const consumer = controller.booted.ctx.loader.api.registry.getCtor('MutableConsumer')",
				"  assert.equal(typeof fixed, 'function')",
				"  assert.equal(typeof consumer, 'function')",
				"  const paramTypes = Reflect.getMetadata('design:paramtypes', consumer)",
				'  assert.equal(paramTypes[0], fixed)',
				'  const instance = controller.booted.ctx.registry.getInstance(consumer)',
				'  assert.ok(instance)',
				'  assert.ok(instance.provider instanceof fixed)',
				'} finally {',
				'  await server.close()',
				'}',
				'',
			].join('\n'),
		)

		await expect(
			execFileAsync(process.execPath, ['--import', 'tsx', runner], {
				cwd: resolve(workspaceRoot, 'packages/runtime-dynamic'),
				env: { ...process.env, CI: '1', CHOKIDAR_USEPOLLING: '1' },
				timeout: 45_000,
			}),
		).resolves.toBeDefined()
	}, 60_000)
})
