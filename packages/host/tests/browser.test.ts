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
  protected override async init() {
    const fs = await this.ctx.fs()
    await fs.writeFile('browser.txt', 'browser storage')
    this.ctx.logger.info('provider started', { storage: await fs.readFile('browser.txt', 'utf8') })
    trace.push('provider started')
    return () => {
      this.ctx.logger.info('provider closed')
      trace.push('provider closed')
    }
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
    this.ctx.logger.info('consumer started')
    trace.push(this.provider.greet())
    return () => {
      this.ctx.logger.info('consumer closed')
      trace.push('consumer closed')
    }
  }
}
`,
		)
		await writeFile(
			join(root, 'entry.ts'),
			`
import { logtape, zenfs } from '@pluxel/core/config'
import { createHost } from '@pluxel/host/browser'
import { Provider } from './provider'
import { Consumer } from './consumer'
import { trace } from './trace'
export async function run() {
  const records: { category: readonly string[]; message: string; storage?: unknown }[] = []
  const sinkLifecycle: string[] = []
  const consumer = Consumer.nodeAddress()
  const host = await createHost({
    runtime: {
      zenfs: zenfs(),
      logtape: logtape({
        sinks: {
          capture: Object.assign(
            (record: {
              category: readonly string[]
              message: readonly unknown[]
              properties: Readonly<Record<string, unknown>>
            }) => {
              records.push({
                category: [...record.category],
                message: record.message.join(''),
                storage: record.properties.storage,
              })
            },
            {
              async drain() { sinkLifecycle.push('drained') },
              async [Symbol.asyncDispose ?? Symbol.for('Symbol.asyncDispose')]() {
                sinkLifecycle.push('disposed')
              },
            },
          ),
        },
        loggers: [
          { category: ['pluxel'], lowestLevel: 'trace', sinks: ['capture'] },
          { category: ['logtape', 'meta'], lowestLevel: 'fatal', sinks: [] },
        ],
      }),
      state: { autoStart: [consumer] },
    },
    plugins: [Provider, Consumer],
  })
  const rootId = host.ctx.logging?.resolved.root.id
  const logging = { initial: host.ctx.logging?.state, final: host.ctx.logging?.state }
  try {
    host.ctx.logger.info('host prepared')
    const started = await host.start()
    const running = await host.status()
    await host.stopNode(consumer)
    const stopped = await host.status()
    return { started, running, stopped, trace, records, rootId, logging, sinkLifecycle }
  } finally {
    host.ctx.logger.info('host closing')
    await host.close()
    logging.final = host.ctx.logging?.state
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
		const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules))
		for (const name of ['logtape', 'zenfs']) {
			expect(modules.some((id) => id.endsWith(`/core/src/config/${name}.ts`))).toBe(true)
		}
		expect(
			modules.filter((id) =>
				/(?:^|\0)node:|\/@logtape\/(?:file|pretty)\/|\/@logtape\+(?:file|pretty)@|\/core\/src\/logging\/(?:file|pretty)\./.test(
					id,
				),
			),
		).toEqual([])
		expect(chunks[0]!.imports).toEqual([])
		// The selected backend's lazy import is inlined into the same IIFE.
		expect(chunks[0]!.dynamicImports.filter((id) => id !== chunks[0]!.fileName)).toEqual([])
		const run = runInNewContext(`${code}\nbrowserHost.run`, {
			console,
			TextEncoder,
			TextDecoder,
			URL,
			structuredClone,
			AbortController,
			AbortSignal,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			queueMicrotask,
			performance,
			crypto,
		}) as () => Promise<{
			started: { core: { status: string; summary: { lifecycleReport: { ok: boolean } } } }
			running: { summary: { total: number; running: number } }
			stopped: { summary: { running: number } }
			trace: string[]
			records: { category: string[]; message: string; storage?: unknown }[]
			rootId: string
			logging: { initial: string; final: string }
			sinkLifecycle: string[]
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
		expect(result.logging).toEqual({ initial: 'installed', final: 'disposed' })
		expect(result.sinkLifecycle).toEqual(['drained', 'disposed'])
		expect(result.rootId).toEqual(expect.any(String))
		const lifecycleMessages = [
			'host prepared',
			'provider started',
			'consumer started',
			'consumer closed',
			'provider closed',
			'host closing',
		]
		const lifecycleRecords = result.records.filter((record) =>
			lifecycleMessages.includes(record.message),
		)
		expect(lifecycleRecords.map((record) => record.message)).toEqual(lifecycleMessages)
		for (const record of lifecycleRecords) {
			expect(record.category.slice(0, 3)).toEqual([
				'pluxel',
				record.message.startsWith('host ') ? 'runtime' : 'plugins',
				result.rootId,
			])
		}
		expect(lifecycleRecords.find((record) => record.message === 'provider started')?.storage).toBe(
			'browser storage',
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
