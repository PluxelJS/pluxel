import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	BasePlugin,
	Plugin,
	parsePluginDefinitionReference,
	parsePluginNodeAddress,
} from '@pluxel/core'
import { createInspectionBackend } from '@pluxel/rolldown/inspect'
import { compileScript } from '@pluxel/rolldown/scripts'
import { createNodeScriptOwner } from '@pluxel/host/agent/node'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'
import { hashScriptSource, type ScriptArtifact } from '../src/agent-runtime'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'node-script-test',
		types: undefined as { input: Record<string, unknown>; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown }).count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'Expected a number', path: ['count'] }] }
		},
	},
}
let onChange: (() => Promise<void>) | undefined
@Plugin()
class Counter extends BasePlugin {
	readonly config = this.configs.use(schema)
	count = 2
	init() {
		this.configs.onUpdate(this.config, async ({ desired }) => {
			await onChange?.()
			this.count = desired.count
		})
	}
}
async function artifact(code: string): Promise<ScriptArtifact> {
	const body = `const {Result} = __pluxel_script_better_result;\n${code}`
	return {
		kind: 'artifact',
		format: 'pluxel-js-factory/3',
		code: body,
		sourceHash: await hashScriptSource(body),
		exportName: 'default',
	}
}
const subject = 'admin:alice'

it('runs compiled uploaded source lookup through an explicitly installed backend without evaluating author code', async () => {
	const hostRoot = fileURLToPath(new URL('../', import.meta.url))
	const source = [
		"import { BasePlugin, Plugin } from '@pluxel/core'",
		"export const AuthorSchema = (() => { throw new Error('SCHEMA_MUST_NOT_EXECUTE') })()",
		'@Plugin()',
		'export class AuthorPlugin extends BasePlugin {',
		'  settings = this.configs.use(AuthorSchema)',
		'}',
		"throw new Error('PLUGIN_MUST_NOT_EXECUTE')",
	].join('\n')
	const prefix = source.slice(0, source.indexOf('class AuthorPlugin')).split('\n')
	const declarationStart = { line: prefix.length, column: prefix.at(-1)!.length + 1 }
	await mkdir(join(hostRoot, '.tmp'), { recursive: true })
	const directory = await mkdtemp(join(hostRoot, '.tmp/node-inspection-'))
	try {
		const files = {
			'package.json': JSON.stringify({ private: true, type: 'module' }),
			'tsconfig.json': JSON.stringify({ extends: `${hostRoot}/tsconfig.json` }),
			'author/plugin.ts': source,
			'author/application.ts': [
				"import { defineHostApplication } from '@pluxel/host'",
				"import { AuthorPlugin } from './plugin'",
				"throw new Error('APPLICATION_MUST_NOT_EXECUTE')",
				'export default defineHostApplication(() => ({ plugins: [AuthorPlugin] }))',
			].join('\n'),
			'task.ts': `
import type { PluginNodeAddress } from '@pluxel/core'
import type { Script } from '@pluxel/host/agent'
export default (async (sdk, run) => sdk.plugin(run.input as PluginNodeAddress).inspect({
  include: ['config', 'inputs'],
})) satisfies Script
`,
		}
		for (const [name, contents] of Object.entries(files)) {
			const file = join(directory, name)
			await mkdir(dirname(file), { recursive: true })
			await writeFile(file, contents)
		}
		await mkdir(join(directory, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				join(hostRoot, '..', name),
				join(directory, `node_modules/@pluxel/${name}`),
				'dir',
			)
		await using host = await createHost({
			plugins: [],
			runtime: { documents: { config: false, state: false } },
		})
		await host.start()
		const code = await compileScript({ file: join(directory, 'task.ts') })
		const input = parsePluginNodeAddress({
			definition: parsePluginDefinitionReference('source:app/plugin.ts::AuthorPlugin'),
			variant: 'default',
		})
		const installation = {
			ctx: host.ctx,
			inspection: createInspectionBackend({
				root: directory,
				application: { root: 'author', entry: 'application.ts' },
			}),
		}
		await using owner = createNodeScriptOwner(installation)
		installation.inspection = async () => {
			throw new Error('Caller mutation must not replace the installed source backend')
		}
		await owner.executor.submit({ runId: 'author-source', code, input }, subject)
		expect(await owner.executor.settled('author-source', subject)).toMatchObject({
			state: 'succeeded',
			hostEpoch: owner.hostEpoch,
			value: {
				status: 'ok',
				value: {
					root: directory,
					revision: expect.any(String),
					source: {
						content: 'current-disk',
						environment: 'execution-target',
						runtimeMatch: 'unverified',
					},
					data: {
						summary: {
							definition: input.definition,
							declaration: {
								file: join(directory, 'author/plugin.ts'),
								start: declarationStart,
								end: { line: 6, column: 2 },
							},
						},
						sections: {
							config: {
								status: 'complete',
								value: {
									declarations: [
										{
											fieldName: 'settings',
											schema: {
												expression: 'AuthorSchema',
												declaration: { file: join(directory, 'author/plugin.ts') },
											},
										},
									],
								},
							},
							inputs: {
								status: 'complete',
								value: {
									application: {
										root: join(directory, 'author'),
										entry: join(directory, 'author/application.ts'),
									},
									config: null,
									bindings: [],
								},
							},
						},
					},
				},
			},
		})
		await using withoutSource = createNodeScriptOwner({ ctx: host.ctx })
		await withoutSource.executor.submit({ runId: 'no-source-backend', code, input }, subject)
		expect(await withoutSource.executor.settled('no-source-backend', subject)).toMatchObject({
			state: 'succeeded',
			value: {
				status: 'error',
				error: {
					code: 'inspection_unavailable',
					reason: { code: 'inspection_backend_unavailable' },
				},
			},
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

it('executes a portable task on a real Host and creates fresh module locals on every run', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	const code = await artifact(`let runs = 0;
return {default: async (sdk, run) => {
  const selected = sdk.plugin(run.input);
  const before = await selected.config.get();
  if (before.isErr()) return before;
  const count = before.value.config.count * 2;
  const changed = await selected.config.patch({set: {count}}, {expectedManagedRevision: before.value.managedRevision});
  if (changed.isErr()) return changed;
  const actual = await selected.config.get();
  if (actual.isErr()) return actual;
  return Result.ok({runs: ++runs, changed: changed.value, actual: actual.value});
}};`)
	for (const [id, expected] of [
		['first', 4],
		['second', 8],
	] as const) {
		await owner.executor.submit(
			{ runId: id, code, input: parsePluginNodeAddress(Counter.nodeAddress()) },
			subject,
		)
		const completed = await owner.executor.settled(id, subject)
		expect(completed).toMatchObject({
			state: 'succeeded',
			hostEpoch: owner.hostEpoch,
			value: {
				status: 'ok',
				value: {
					runs: 1,
					changed: { application: 'applied' },
					actual: { config: { count: expected } },
				},
			},
			revisions: {
				before: { configManagedRevision: expect.any(String) },
				after: { configManagedRevision: expect.any(String) },
			},
		})
	}
	await expect(
		owner.executor.submit(
			{ runId: 'wrong-hash', code: { ...code, sourceHash: '0'.repeat(64) } },
			subject,
		),
	).rejects.toMatchObject({ code: 'source_changed' })
	await expect(
		owner.executor.submit(
			{
				runId: 'old-format',
				code: { ...code, format: 'pluxel-js-factory/1' as typeof code.format },
			},
			subject,
		),
	).rejects.toMatchObject({ code: 'artifact_incompatible' })
})

it('retains domain Err as a successful script value while defects and invalid payloads fail in their phase', async () => {
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	const domain = await artifact(
		'return {default: () => Result.err({code:"expected_rejection",message:"Domain result"})};',
	)
	await owner.executor.submit({ runId: 'domain', code: domain }, subject)
	const completed = await owner.executor.settled('domain', subject)
	expect(completed).toMatchObject({
		state: 'succeeded',
		value: { status: 'error', error: { code: 'expected_rejection', message: 'Domain result' } },
	})
	for (const [id, source, phase] of [
		['defect', 'return Result.ok(1).map(() => {throw new Error("author defect")})', 'execute'],
		['payload', 'return Result.err(new Error("Requires an explicit boundary codec"))', 'encode'],
	] as const) {
		const code = await artifact(`return {default: () => {${source}}};`)
		await owner.executor.submit({ runId: id, code }, subject)
		expect(await owner.executor.settled(id, subject)).toMatchObject({ state: 'failed', phase })
	}
})

it('retains the original unknown defect in a native Result.gen failure receipt', async () => {
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	const code = await artifact(`return {default: sdk => Result.gen(async function* () {
  yield* await sdk.plugins.list();
  throw new Error("counter storage is unavailable");
})};`)
	await owner.executor.submit({ runId: 'generator-defect', code }, subject)
	expect(await owner.executor.settled('generator-defect', subject)).toMatchObject({
		state: 'failed',
		phase: 'execute',
		error: {
			code: 'execution_failed',
			message: 'generator body threw | counter storage is unavailable',
			stack: expect.stringContaining('Caused by: Error: counter storage is unavailable'),
		},
	})
})

it('preserves committed Host changes and versions after an execution or result-encoding failure', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	for (const [id, ending, count] of [
		['throw', 'throw new Error("after commit")', 5],
		['encode', 'return 1n', 9],
	] as const) {
		const code = await artifact(
			`return {default: async (sdk,run) => { await sdk.plugin(run.input).config.patch({set:{count:${count}}}); ${ending}; }};`,
		)
		await owner.executor.submit(
			{ runId: id, code, input: parsePluginNodeAddress(Counter.nodeAddress()) },
			subject,
		)
		const result = await owner.executor.settled(id, subject)
		expect(result).toMatchObject({
			state: 'failed',
			phase: id === 'throw' ? 'execute' : 'encode',
			revisions: { before: expect.any(Object), after: expect.any(Object) },
		})
		expect(await host.config.get(Counter.nodeAddress())).toMatchObject({
			config: { count },
			application: 'applied',
		})
	}
})

it('cancellation closes new SDK admission while an accepted mutation settles on the original Host', async () => {
	let entered!: () => void, release!: () => void
	const mutationEntered = new Promise<void>((resolve) => {
		entered = resolve
	})
	const mutationRelease = new Promise<void>((resolve) => {
		release = resolve
	})
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	const owner = createNodeScriptOwner({ ctx: host.ctx })
	onChange = async () => {
		entered()
		await mutationRelease
	}
	try {
		const code = await artifact(
			'return {default:async(sdk,run)=>{await sdk.plugin(run.input).config.patch({set:{count:12}});return sdk.plugins.list();}};',
		)
		await owner.executor.submit(
			{ runId: 'cancel', code, input: parsePluginNodeAddress(Counter.nodeAddress()) },
			subject,
		)
		await mutationEntered
		expect(owner.executor.cancel('cancel', subject)).toMatchObject({ state: 'cancelling' })
		release()
		const cancelled = await owner.executor.settled('cancel', subject)
		expect(cancelled).toMatchObject({
			state: 'cancelled',
			revisions: { after: expect.any(Object) },
		})
		expect(cancelled).not.toHaveProperty('executionError')
		expect(await host.config.get(Counter.nodeAddress())).toMatchObject({
			config: { count: 12 },
			application: 'applied',
		})
		await owner.close()
		await expect(
			owner.executor.submit({ runId: 'after-close', code }, subject),
		).rejects.toMatchObject({ code: 'owner_closed' })
	} finally {
		release()
		onChange = undefined
		await owner.close()
	}
})
