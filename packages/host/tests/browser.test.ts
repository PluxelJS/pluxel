import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { build, type Plugin } from 'vite-plus'
import { expect, it } from 'vitest'

it('runs the lowered dependency graph and drains it without Node globals', async () => {
	const hostRoot = fileURLToPath(new URL('../', import.meta.url))
	await mkdir(join(hostRoot, '.tmp'), { recursive: true })
	const root = await mkdtemp(join(hostRoot, '.tmp/browser-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		await symlink(hostRoot, join(root, 'node_modules/@pluxel/host'), 'dir')
		await writeFile(
			join(root, 'package.json'),
			'{"name":"browser-host-fixture","private":true,"type":"module"}',
		)
		await writeFile(join(root, 'trace.ts'), 'export const trace: string[] = []')
		await writeFile(
			join(root, 'provider.ts'),
			`
import { BasePlugin, Plugin } from '@pluxel/core'
import { trace } from './trace'
@Plugin()
export class Provider extends BasePlugin {
  protected override init() {
    trace.push('provider started')
    return () => { trace.push('provider closed') }
  }
  greet() { return 'hello from dependency' }
}
`,
		)
		await writeFile(
			join(root, 'consumer.ts'),
			`
import { BasePlugin, Plugin } from '@pluxel/core'
import { Provider } from './provider'
import { trace } from './trace'
@Plugin()
export class Consumer extends BasePlugin {
  constructor(private provider: Provider) { super() }
  protected override init() {
    trace.push(this.provider.greet())
    return () => { trace.push('consumer closed') }
  }
}
`,
		)
		await writeFile(
			join(root, 'entry.ts'),
			`
import { pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host/browser'
import { Provider } from './provider'
import { Consumer } from './consumer'
import { trace } from './trace'
export async function run() {
  const consumer = pluginNodeAddressOf(Consumer)
  const host = await createHost({
    plugins: [Provider, Consumer],
    state: { initial: { autoStart: [consumer] } },
  })
  try {
    const started = await host.start()
    const running = await host.status()
    await host.stopNode(consumer)
    const stopped = await host.status()
    return { started, running, stopped, trace }
  } finally {
    await host.close()
  }
}
`,
		)
		const output = await build({
			configFile: false,
			root,
			logLevel: 'silent',
			oxc: { decorator: { legacy: true } },
			resolve: {
				conditions: ['@pluxel/source', 'source', 'browser', 'module', 'production'],
			},
			plugins: [createPluginSemanticsPlugin({ root }).plugin as unknown as Plugin],
			build: {
				write: false,
				minify: false,
				lib: { entry: join(root, 'entry.ts'), formats: ['iife'], name: 'browserHost' },
			},
		})
		const outputs = Array.isArray(output) ? output : [output]
		const chunks = outputs.flatMap((result) => {
			if (!('output' in result)) throw new Error('Expected an immediate browser build')
			return result.output.filter((chunk) => chunk.type === 'chunk')
		})
		expect(chunks).toHaveLength(1)
		const code = chunks[0]!.code
		expect(code).not.toContain('__vite-browser-external')
		expect(chunks[0]!.imports).toEqual([])
		expect(chunks[0]!.dynamicImports).toEqual([])
		const run = runInNewContext(`${code}\nbrowserHost.run`, {
			console,
			TextEncoder,
			TextDecoder,
			AbortController,
			AbortSignal,
			setTimeout,
			clearTimeout,
			queueMicrotask,
			performance,
			crypto,
		}) as () => Promise<{
			started: { core: { status: string; summary: { lifecycleReport: { ok: boolean } } } }
			running: { summary: { total: number; running: number } }
			stopped: { summary: { running: number } }
			trace: string[]
		}>
		const result = await run()
		expect(result.started.core).toMatchObject({
			status: 'committed',
			summary: { lifecycleReport: { ok: true } },
		})
		expect(result.running.summary).toMatchObject({ total: 2, running: 2 })
		expect(result.stopped.summary.running).toBe(0)
		expect(result.trace).toEqual([
			'provider started',
			'hello from dependency',
			'consumer closed',
			'provider closed',
		])
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
