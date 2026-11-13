import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createHost } from '@pluxel/host'
import { createNodeScriptOwner } from '@pluxel/host/agent/node'
import { compileScript } from '../src/scripts'

async function fixture(files: Record<string, string>) {
	const directory = await mkdtemp(resolve(import.meta.dirname, '.script-'))
	await writeFile(
		resolve(directory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2023',
				module: 'ESNext',
				moduleResolution: 'Bundler',
				strict: true,
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
  const plugins = await sdk.plugins.list()
  const values = []
  for (const value of [1,2,3]) if (value > 1) values.push(twice(value))
  return {executions:++executions, values, plugins:plugins.length, input:run.input}
}) satisfies Script
`,
	})
	const artifact = await compileScript({ file: resolve(files.directory, 'script.ts') })
	expect(artifact).toMatchObject({
		kind: 'artifact',
		format: 'pluxel-js-factory/1',
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

it('returns runtime errors at the original author file and line without receiver compiler support', async () => {
	await using files = await fixture({
		'failure.ts':
			'const value: number = 7\nexport default async () => {\n  throw new Error(`author failure ${value}`)\n}\n',
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
})

it('rejects field mistakes before delivery, unsupported imports and top-level await', async () => {
	await using files = await fixture({
		'wrong.ts': `import type {Script} from '@pluxel/host/agent'; export default (async(sdk)=>sdk.plguins.list()) satisfies Script`,
		'builtin.ts': `import {readFile} from 'node:fs/promises'; export default () => readFile('x')`,
		'framework.ts': `import {BasePlugin} from '@pluxel/core'; export default () => BasePlugin`,
		'relative.ts': `import {BasePlugin} from '../../../core/src/index'; export default () => BasePlugin`,
		'dynamic.ts': `export default async () => import('./helper')`,
		'helper.ts': `export const value = 1`,
		'top.ts': `await Promise.resolve(); export default () => 1`,
	})
	await expect(compileScript({ file: resolve(files.directory, 'wrong.ts') })).rejects.toMatchObject(
		{ code: 'typecheck_failed', message: expect.stringContaining('plguins') },
	)
	for (const name of ['builtin.ts', 'framework.ts', 'relative.ts', 'dynamic.ts'])
		await expect(compileScript({ file: resolve(files.directory, name) })).rejects.toMatchObject({
			code: 'unsupported_import',
		})
	await expect(compileScript({ file: resolve(files.directory, 'top.ts') })).rejects.toMatchObject({
		code: 'compile_failed',
		message: expect.stringMatching(/await/i),
	})
})
