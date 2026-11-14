import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import * as sharedBetterResult from '@pluxel/core/better-result'
import { expect, it } from 'vitest'
import { createHost } from '@pluxel/host'
import { createNodeScriptOwner } from '@pluxel/host/agent/node'
import { compileScript } from '../src/scripts'

async function fixture(files: Record<string, string>) {
	const directory = await mkdtemp(resolve(tmpdir(), 'pluxel-script-fixture-'))
	for (const name of ['@pluxel/core', '@pluxel/host', '@types/node']) {
		const dependency = resolve(directory, 'node_modules', name)
		await mkdir(dirname(dependency), { recursive: true })
		await symlink(resolve(import.meta.dirname, '../node_modules', name), dependency, 'dir')
	}
	await writeFile(
		resolve(directory, 'tsconfig.json'),
		JSON.stringify({
			extends: resolve(import.meta.dirname, '../tsconfig.json'),
			compilerOptions: {
				target: 'ES2023',
				module: 'ESNext',
				moduleResolution: 'Bundler',
				customConditions: ['@pluxel/source'],
				strict: true,
				strictNullChecks: true,
				skipLibCheck: true,
			},
		}),
	)
	for (const [name, content] of Object.entries(files))
		await writeFile(resolve(directory, name), content)
	return { directory, [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) }
}

it('compiles ordinary typed modules to fresh portable factories and executes against a real Host', async () => {
	await using files = await fixture({
		'helper.ts': 'export const twice = (value:number) => value * 2',
		'script.ts': `import type { Script } from '@pluxel/host/agent'
import {twice} from './helper'
let executions = 0
export default (async(sdk,run) => {
  const plugins = (await sdk.plugins.list()).unwrap()
  const values = []
  for (const value of [1,2,3]) if (value > 1) values.push(twice(value))
  return {executions:++executions, values, plugins:plugins.length, input:run.input}
}) satisfies Script
`,
	})
	const artifact = await compileScript({ file: resolve(files.directory, 'script.ts') })
	expect(artifact).toMatchObject({
		kind: 'artifact',
		format: 'pluxel-js-factory/2',
		exportName: 'default',
		sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		sourceMap: expect.any(String),
	})
	expect(artifact.code).not.toContain('@pluxel/core')
	expect(artifact.code).not.toContain('@pluxel/host')
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	for (const id of ['first', 'second']) {
		await owner.executor.submit({ runId: id, code: artifact, input: { count: 7 } }, 'admin:alice')
		expect(await owner.executor.settled(id, 'admin:alice')).toMatchObject({
			state: 'succeeded',
			value: { executions: 1, values: [4, 6], plugins: 0, input: { count: 7 } },
		})
	}
})

it('binds ordinary canonical imports to the receiver shared Result without bundling a library copy', async () => {
	await using files = await fixture({
		'script.ts': `import type {Script} from '@pluxel/host/agent'
import {Result,Ok} from '@pluxel/core/better-result'
import * as shared from '@pluxel/core/better-result'
import * as reexported from './shared'
const __pluxel_script_better_result = 'author local'
export const namespace = () => shared
export const strictReceiver = function(this: unknown) { return this }
const proto = () => 'safe proto export'
export {proto as __proto__}
export default (async(sdk,run) => {
  const plugins = await sdk.plugins.list()
  if (plugins.isErr()) return plugins
  if (run.input === 'reject') return Result.err({code:'expected_rejection',message:'Domain result'})
  return Result.ok({count:plugins.value.length,sharedIdentity:plugins instanceof Ok,canonicalReexport:reexported.Result===Result,authorLocal:__pluxel_script_better_result})
}) satisfies Script
export const composed = ((sdk) => Result.gen(async function* () {
  const plugins = yield* Result.await(sdk.plugins.list())
  return Result.ok(plugins.length)
})) satisfies Script
`,
		'shared.ts': "export {Result} from '@pluxel/core/better-result'",
	})
	const code = await compileScript({ file: resolve(files.directory, 'script.ts') })
	expect(code.code).not.toContain('class Ok')
	expect(code.code).not.toContain('class Err')
	const loaded = new Function('__pluxel_script_better_result', code.code)(sharedBetterResult) as {
		namespace(): typeof sharedBetterResult
		strictReceiver(this: unknown): unknown
	}
	expect(loaded.namespace()).toBe(sharedBetterResult)
	expect(Reflect.apply(loaded.strictReceiver, undefined, [])).toBeUndefined()
	expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype)
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	await owner.executor.submit({ runId: 'ok', code }, 'admin:alice')
	expect(await owner.executor.settled('ok', 'admin:alice')).toMatchObject({
		state: 'succeeded',
		value: {
			status: 'ok',
			value: {
				count: 0,
				sharedIdentity: true,
				canonicalReexport: true,
				authorLocal: 'author local',
			},
		},
	})
	await owner.executor.submit({ runId: 'err', code, input: 'reject' }, 'admin:alice')
	expect(await owner.executor.settled('err', 'admin:alice')).toMatchObject({
		state: 'succeeded',
		value: { status: 'error', error: { code: 'expected_rejection', message: 'Domain result' } },
	})
	await owner.executor.submit(
		{ runId: 'composed', code: { ...code, exportName: 'composed' } },
		'admin:alice',
	)
	expect(await owner.executor.settled('composed', 'admin:alice')).toMatchObject({
		state: 'succeeded',
		value: { status: 'ok', value: 0 },
	})
	await owner.executor.submit(
		{ runId: 'proto-export', code: { ...code, exportName: '__proto__' } },
		'admin:alice',
	)
	expect(await owner.executor.settled('proto-export', 'admin:alice')).toMatchObject({
		state: 'succeeded',
		value: 'safe proto export',
	})
})

it('preserves canonical namespace and star reexports with explicit exports taking precedence', async () => {
	await using files = await fixture({
		'script.ts': `export * from '@pluxel/core/better-result'
export * as canonical from '@pluxel/core/better-result'
export {Err as SharedErr} from '@pluxel/core/better-result'
const ownResult = 'explicit result'
export {ownResult as Result}
export const Object = 'author shadow'
export default () => Object
`,
		'star.ts': `export * from '@pluxel/core/better-result'
export const script = () => 1
`,
	})
	const artifact = await compileScript({ file: resolve(files.directory, 'script.ts') })
	const loaded = new Function('__pluxel_script_better_result', artifact.code)(
		sharedBetterResult,
	) as Record<string, unknown>
	expect(loaded.canonical).toBe(sharedBetterResult)
	expect(loaded.Ok).toBe(sharedBetterResult.Ok)
	expect(loaded.SharedErr).toBe(sharedBetterResult.Err)
	expect(loaded.Result).toBe('explicit result')
	expect((loaded.default as () => string)()).toBe('author shadow')
	const star = await compileScript({
		file: resolve(files.directory, 'star.ts'),
		exportName: 'script',
	})
	const withDefault = { ...sharedBetterResult, default: 'excluded by export star' }
	const starExports = new Function('__pluxel_script_better_result', star.code)(
		withDefault,
	) as Record<string, unknown>
	expect(starExports.Ok).toBe(sharedBetterResult.Ok)
	expect(Object.hasOwn(starExports, 'default')).toBe(false)
})

it('erases canonical type-only imports without a runtime binding', async () => {
	await using files = await fixture({
		'script.ts': `import type {Result} from '@pluxel/core/better-result'
const count = (value?: Result<number,string>) => value?.unwrapOr(0) ?? 3
export default () => count()
`,
	})
	const artifact = await compileScript({ file: resolve(files.directory, 'script.ts') })
	expect(artifact.code).not.toContain('__pluxel_script_better_result')
	const loaded = new Function(artifact.code)() as { default(): number }
	expect(loaded.default()).toBe(3)
})

it('returns runtime errors at the original author file and line without receiver compiler support', async () => {
	await using files = await fixture({
		'failure.ts':
			'const value: number = 7\nexport default async () => {\n  throw new Error(`author failure ${value}`)\n}\n',
		'result-failure.ts':
			"import {Result} from '@pluxel/core/better-result'\nexport default () => Result.gen(function* () {\n  throw new Error('original Result cause')\n})\n",
	})
	const file = resolve(files.directory, 'failure.ts')
	const code = await compileScript({ file })
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	await owner.executor.submit({ runId: 'mapped', code }, 'admin:alice')
	expect(await owner.executor.settled('mapped', 'admin:alice')).toMatchObject({
		state: 'failed',
		phase: 'execute',
		error: { message: 'author failure 7', stack: expect.stringContaining(`${file}:3:`) },
	})
	const resultFile = resolve(files.directory, 'result-failure.ts')
	await owner.executor.submit(
		{ runId: 'mapped-result', code: await compileScript({ file: resultFile }) },
		'admin:alice',
	)
	expect(await owner.executor.settled('mapped-result', 'admin:alice')).toMatchObject({
		state: 'failed',
		phase: 'execute',
		error: {
			message: 'generator body threw | original Result cause',
			stack: expect.stringContaining(`${resultFile}:3:`),
		},
	})
})

it('rejects field mistakes before delivery, unsupported imports and top-level await', async () => {
	const coreRequire = createRequire(
		resolve(import.meta.dirname, '../node_modules/@pluxel/core/package.json'),
	)
	await using files = await fixture({
		'wrong.ts': `import type {Script} from '@pluxel/host/agent'; export default (async(sdk)=>sdk.plguins.list()) satisfies Script`,
		'builtin.ts': `import {readFile} from 'node:fs/promises'; export default () => readFile('x')`,
		'framework.ts': `import {BasePlugin} from '@pluxel/core'; export default () => BasePlugin`,
		'source.ts': `import {BasePlugin} from ${JSON.stringify(resolve(import.meta.dirname, '../../core/src/index.ts'))}; export default () => BasePlugin`,
		'result.ts': `import {Result} from 'better-result'; export default () => Result.ok(1)`,
		'result-subpath.ts': `import {Result} from '@pluxel/core/better-result/private'; export default () => Result.ok(1)`,
		'result-core-source.ts': `import {Result} from ${JSON.stringify(resolve(import.meta.dirname, '../../core/src/better-result.ts'))}; export default () => Result.ok(1)`,
		'result-source.ts': `import {Result} from ${JSON.stringify(coreRequire.resolve('better-result'))}; export default () => Result.ok(1)`,
		'reexport.ts': `import {Result} from './business'; export default () => Result.ok(1)`,
		'business.ts': `export {Result} from 'better-result'`,
		'dynamic.ts': `export default async () => import('./helper')`,
		'helper.ts': `export const value = 1`,
		'top.ts': `await Promise.resolve(); export default () => 1`,
	})
	await expect(compileScript({ file: resolve(files.directory, 'wrong.ts') })).rejects.toMatchObject(
		{ code: 'typecheck_failed', message: expect.stringContaining('plguins') },
	)
	for (const name of [
		'builtin.ts',
		'framework.ts',
		'source.ts',
		'result.ts',
		'result-subpath.ts',
		'result-core-source.ts',
		'result-source.ts',
		'reexport.ts',
		'dynamic.ts',
	])
		await expect(compileScript({ file: resolve(files.directory, name) })).rejects.toMatchObject({
			code: 'unsupported_import',
		})
	await expect(compileScript({ file: resolve(files.directory, 'top.ts') })).rejects.toMatchObject({
		code: 'compile_failed',
		message: expect.stringMatching(/await/i),
	})
})
