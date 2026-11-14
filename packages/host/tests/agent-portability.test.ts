import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BasePlugin, Plugin, type PluginNodeAddress } from '@pluxel/core'
import { Result } from '@pluxel/core/better-result'
import { compileScript } from '@pluxel/rolldown/scripts'
import { Miniflare, Response as WorkerResponse } from 'miniflare'
import { build } from 'vite-plus'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'
import { createScriptScope, snapshotJson, type ScriptPluginConfig } from '../src/agent'

const hostRoot = fileURLToPath(new URL('../', import.meta.url))

it('bundles the actual portable SDK and execution entry without platform or compiler imports', async () => {
	await mkdir(join(hostRoot, '.tmp'), { recursive: true })
	const root = await mkdtemp(join(hostRoot, '.tmp/agent-portable-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		await symlink(hostRoot, join(root, 'node_modules/@pluxel/host'), 'dir')
		await writeFile(join(root, 'entry.ts'), "export * from '@pluxel/host/agent'")
		const modules: string[] = []
		const output = await build({
			configFile: false,
			root,
			logLevel: 'silent',
			resolve: { conditions: ['@pluxel/source', 'browser', 'module', 'production'] },
			plugins: [
				{
					name: 'observe-agent-closure',
					generateBundle() {
						modules.push(...this.getModuleIds())
					},
				},
			],
			build: {
				write: false,
				target: 'esnext',
				minify: false,
				lib: { entry: join(root, 'entry.ts'), formats: ['es'] },
			},
		})
		const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) => {
			if (!('output' in result)) throw new Error('Expected an immediate portable build')
			return result.output.filter((chunk) => chunk.type === 'chunk')
		})
		expect(chunks).toHaveLength(1)
		expect(chunks[0]!.exports).toEqual(
			expect.arrayContaining(['createScriptScope', 'ScriptExecutor', 'executeHostScript']),
		)
		expect(chunks[0]!.imports).toEqual([])
		expect(chunks[0]!.dynamicImports).toEqual([])
		expect(
			modules.filter((id) =>
				/(?:^node:|__vite-browser-external|\/packages\/(?:host-vite|services|rolldown)\/|\/agent\/(?:node|socket|transport)\.ts$)/.test(
					id,
				),
			),
		).toEqual([])
		expect(chunks[0]!.code).not.toContain('__vite-browser-external')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'worker-bridge-test',
		types: undefined as { input: Record<string, unknown>; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown })?.count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'Expected count to be numeric', path: ['count'] }] }
		},
	},
}

@Plugin()
class WorkerCounter extends BasePlugin {
	readonly config = this.configs.use(schema)
	init() {
		this.configs.onUpdate(this.config, () => {})
	}
}

it('loads the compiled factory in real workerd and bridges ordinary SDK calls to the original Host', async () => {
	await mkdir(join(hostRoot, '.tmp'), { recursive: true })
	const directory = await mkdtemp(join(hostRoot, '.tmp/agent-workerd-'))
	await using host = await createHost({
		plugins: [WorkerCounter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(WorkerCounter.nodeAddress())
	const scope = createScriptScope({ ctx: host.ctx })
	let runtime: Miniflare | undefined
	try {
		await mkdir(join(directory, 'node_modules/@pluxel'), { recursive: true })
		await symlink(hostRoot, join(directory, 'node_modules/@pluxel/host'), 'dir')
		await symlink(join(hostRoot, '..', 'core'), join(directory, 'node_modules/@pluxel/core'), 'dir')
		await writeFile(
			join(directory, 'tsconfig.json'),
			JSON.stringify({
				extends: join(hostRoot, 'tsconfig.json'),
			}),
		)
		const file = join(directory, 'task.ts')
		await writeFile(
			file,
			`
import type { Script } from '@pluxel/host/agent'
let moduleInvocations = 0
export default ((sdk, run) => sdk.Result.gen(async function* () {
  run.signal.throwIfAborted()
  const nodes = yield* sdk.Result.await(sdk.plugins.list())
  const { get, patch } = sdk.plugin(nodes[0].address).config
  const before = yield* sdk.Result.await(get())
  const values = [before.config.count]
  let next = 0
  for (const value of values) {
    if (typeof value === 'number') next += value * 2
  }
  const changed = yield* sdk.Result.await(patch({ set: { count: next } }, { expectedManagedRevision: before.managedRevision }))
  const actual = yield* sdk.Result.await(get())
  return sdk.Result.ok({ moduleInvocations: ++moduleInvocations, changed, actual, runtime: navigator.userAgent })
})) satisfies Script
`,
		)
		const artifact = await compileScript({ file })
		const resultEntry = join(directory, 'worker-result.ts')
		await writeFile(
			resultEntry,
			`
import { Result } from '@pluxel/core/better-result'
// The Host codec checks payloads before JSON transport. The Worker bridge only restores those JSON DTOs.
const payload = { '~standard': { version: 1 as const, vendor: 'workerd-test-bridge', validate: (input: unknown) => ({ value: input }) } }
export const codec = Result.codec({ serialize: { ok: payload, err: payload }, deserialize: { ok: payload, err: payload } })
export { Result }
`,
		)
		const resultBuild = await build({
			configFile: false,
			root: directory,
			logLevel: 'silent',
			resolve: { conditions: ['@pluxel/source', 'browser', 'module', 'production'] },
			build: {
				write: false,
				target: 'esnext',
				minify: false,
				lib: { entry: resultEntry, formats: ['es'] },
			},
		})
		const resultChunks = (Array.isArray(resultBuild) ? resultBuild : [resultBuild]).flatMap(
			(output) => {
				if (!('output' in output)) throw new Error('Expected an immediate Result module build')
				return output.output.filter((chunk) => chunk.type === 'chunk')
			},
		)
		expect(resultChunks).toHaveLength(1)
		expect(resultChunks[0]!.imports).toEqual([])
		const jsonPayload = {
			'~standard': {
				version: 1 as const,
				vendor: 'workerd-test-bridge',
				validate: (input: unknown) => ({ value: snapshotJson(input) }),
			},
		}
		const bridgeCodec = Result.codec({
			serialize: { ok: jsonPayload, err: jsonPayload },
			deserialize: { ok: jsonPayload, err: jsonPayload },
		})
		const dynamic = `
import { WorkerEntrypoint } from 'cloudflare:workers'
import { Result, codec } from './result.js'
function loadModule() { ${artifact.code} }
export default class Task extends WorkerEntrypoint {
  async run(input) {
    const sdk = {
      Result,
      plugins: { list: async () => codec.deserializeUnsafe(await this.env.HOST.listPlugins()) },
      // This test bridge supplies only the two calls exercised by this task.
      plugin: (node) => ({
        address: node,
        config: {
          get: async () => codec.deserializeUnsafe(await this.env.HOST.getConfig(node)),
          patch: async (change, options) => codec.deserializeUnsafe(await this.env.HOST.patchConfig(node, change, options)),
        },
      }),
    }
    return codec.serializeUnsafe(await loadModule()[${JSON.stringify(artifact.exportName)}](sdk, { id: 'workerd-probe', input, signal: new AbortController().signal }))
  }
}
`
		const parent = `
import { WorkerEntrypoint } from 'cloudflare:workers'
export class HostBridge extends WorkerEntrypoint {
  async listPlugins() { return this.call({ operation: 'plugins' }) }
  async getConfig(node) { return this.call({ operation: 'get', node }) }
  async patchConfig(node, change, options) { return this.call({ operation: 'patch', node, change, options }) }
  async call(input) {
    const response = await this.env.HOST.fetch('http://host/', { method: 'POST', body: JSON.stringify(input) })
    return response.json()
  }
}
export default {
  async fetch(request, env, ctx) {
    const worker = env.LOADER.load({ compatibilityDate: '2026-11-03', mainModule: 'task.js', modules: { 'task.js': ${JSON.stringify(dynamic)}, 'result.js': ${JSON.stringify(resultChunks[0]!.code)} }, env: { HOST: ctx.exports.HostBridge({}) }, globalOutbound: null })
    return Response.json(await worker.getEntrypoint().run(await request.json()))
  }
}
`
		runtime = new Miniflare({
			host: '127.0.0.1',
			port: 0,
			workers: [
				{
					config: {
						name: 'pluxel-agent-boundary',
						compatibilityDate: '2026-11-03',
						manifest: {
							mainModule: 'parent.js',
							modules: { 'parent.js': { type: 'esm', contents: parent } },
						},
						env: {
							LOADER: { type: 'worker-loader' },
							HOST: {
								type: 'fetcher',
								async handler(request) {
									const input = (await request.json()) as {
										operation: string
										node: PluginNodeAddress
										change: Parameters<ScriptPluginConfig['patch']>[0]
										options: Parameters<ScriptPluginConfig['patch']>[1]
									}
									switch (input.operation) {
										case 'plugins':
											return WorkerResponse.json(
												bridgeCodec.serializeUnsafe(await scope.sdk.plugins.list()),
											)
										case 'get':
											return WorkerResponse.json(
												bridgeCodec.serializeUnsafe(
													await scope.sdk.plugin(input.node).config.get(),
												),
											)
										case 'patch':
											return WorkerResponse.json(
												bridgeCodec.serializeUnsafe(
													await scope.sdk
														.plugin(input.node)
														.config.patch(input.change, input.options),
												),
											)
										default:
											throw new Error(`Unexpected bridge operation ${input.operation}`)
									}
								},
							},
						},
					},
				},
			],
		})
		await runtime.ready
		for (const count of [4, 8]) {
			const response = await runtime.dispatchFetch('http://probe/', {
				method: 'POST',
				body: 'null',
			})
			const body = await response.text()
			expect({ status: response.status, error: response.ok ? null : body }).toEqual({
				status: 200,
				error: null,
			})
			expect(JSON.parse(body)).toMatchObject({
				status: 'ok',
				value: {
					moduleInvocations: 1,
					changed: { application: 'applied', config: { count } },
					actual: { config: { count } },
					runtime: 'Cloudflare-Workers',
				},
			})
			expect(await host.config.get(WorkerCounter.nodeAddress())).toMatchObject({
				config: { count },
				application: 'applied',
			})
		}
	} finally {
		try {
			await runtime?.dispose()
		} finally {
			await scope.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	}
}, 30000)
