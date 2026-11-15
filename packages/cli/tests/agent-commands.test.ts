import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { createDevFixture } from '../../agent-sdk/tests/helpers/dev-fixture'

const execute = promisify(execFile)
const bin = fileURLToPath(new URL('../bin/pluxel.mjs', import.meta.url))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of cleanup.splice(0).toReversed()) await close()
})

async function run(
	cwd: string,
	args: string[],
	environment: Record<string, string> = {},
	nodeArgs: string[] = [],
) {
	const env = { ...process.env, ...environment }
	delete env.NODE_OPTIONS
	delete env.NODE_PATH
	try {
		return {
			...(await execute(process.execPath, [...nodeArgs, bin, ...args], {
				cwd,
				env,
				timeout: 15_000,
			})),
			code: 0,
		}
	} catch (error) {
		if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number')
			throw error
		return error as Error & { code: number; stdout: string; stderr: string }
	}
}

async function project() {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-agent-commands-'))
	cleanup.push(() => rm(root, { recursive: true, force: true }))
	const web = join(root, 'web')
	await mkdir(web)
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ pluxel: { dev: { app: { root: 'web', command: 'must-not-start' } } } }),
	)
	await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
	await writeFile(
		join(web, 'package.json'),
		JSON.stringify({ pluxel: { dev: { app: { command: 'must-not-start' } } } }),
	)
	return { root, web }
}

it('mounts SDK commands on the executable and preserves nested profile routing, progress and receipts', async () => {
	const { root, web } = await project()
	const outer = await createDevFixture({ root: web, metadata: { project: root, profile: 'app' } })
	const inner = await createDevFixture({ root: web, metadata: { project: web, profile: 'app' } })
	cleanup.push(
		() => outer.close(),
		() => inner.close(),
	)
	const file = join(web, 'task.ts')
	await writeFile(file, 'export default () => null')
	for (const args of [['status'], ['instances']]) {
		const result = await run(web, ['dev', '--root', root, '--profile', 'app', ...args])
		expect(result.code).toBe(0)
		const output = JSON.parse(result.stdout)
		expect(output.ok).toBe(true)
		const instances = args[0] === 'status' ? output.value.instances : output.value
		expect(instances.map((item: { instanceId: string }) => item.instanceId)).toEqual([
			outer.instance.instanceId,
		])
		expect(result.stderr).toBe('')
	}
	for (const args of [
		['run', file, '--input', '{"count":4}'],
		['hmr', 'pause'],
	]) {
		const result = await run(web, ['dev', '--root', root, '--profile', 'app', ...args])
		expect(result.code).toBe(0)
		const output = JSON.parse(result.stdout)
		expect(output.ok).toBe(true)
		expect(output.value.run).toMatchObject({
			instanceId: outer.instance.instanceId,
			state: 'succeeded',
		})
		const stages = result.stderr
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
		expect(stages).toEqual([
			{ stage: 'prepared', receipt: output.value.receipt },
			{ stage: 'accepted', receipt: output.value.receipt },
		])
		const queried = await run(web, ['script', 'result', output.value.receipt])
		expect(JSON.parse(queried.stdout).value.run).toEqual(output.value.run)
	}
	const submission = outer.requests.find((request) => request.method === 'submit')
	expect(submission?.input).toMatchObject({
		input: { count: 4 },
		timeoutMs: 30000,
		code: { exportName: 'default' },
	})
	expect(inner.requests.some((request) => !['connect', 'describe'].includes(request.method))).toBe(
		false,
	)
})

it('keeps service-only status in CLI and rejects SDK operations before calling Pitchfork', async () => {
	const { root } = await project()
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ pluxel: { dev: { docs: { pitchfork: 'docs', scripts: false } } } }),
	)
	const tools = join(root, 'bin')
	await mkdir(tools)
	const calls = join(root, 'calls')
	await writeFile(
		join(tools, 'pitchfork'),
		`#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log(JSON.stringify({id:'fixture/docs',status:'running',url:'http://docs.test/'}))
`,
		{ mode: 0o700 },
	)
	const env = { PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` }
	const status = await run(root, ['dev', 'status'], env)
	expect(status.code).toBe(0)
	expect(JSON.parse(status.stdout)).toMatchObject({
		ok: true,
		value: {
			profile: 'docs',
			scripts: false,
			service: { id: 'fixture/docs', status: 'running', url: 'http://docs.test/' },
		},
	})
	for (const args of [['instances'], ['run', 'task.ts'], ['hmr', 'pause'], ['sync']]) {
		const result = await run(root, ['dev', ...args], env)
		expect(result.code).toBe(1)
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			error: { code: 'unsupported_scripts' },
		})
	}
	const recordedCalls = await readFile(calls, 'utf8')
	expect(
		recordedCalls
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line)),
	).toEqual([['status', 'docs', '--json']])
})

it('renders command discovery and leaf help without loading clients or compilers', async () => {
	const { root } = await project()
	const guard = join(root, 'guard.mjs')
	await writeFile(
		guard,
		`import {registerHooks} from 'node:module'
registerHooks({resolve(specifier, context, next) {
 if(['@pluxel/host','@pluxel/rolldown','@pluxel/services','@pluxel/agent-sdk/client','@pluxel/agent-sdk/internal/client'].some(name=>specifier===name||specifier.startsWith(name+'/'))) throw new Error('Help loaded '+specifier)
 return next(specifier,context)
}})
`,
	)
	for (const args of [
		[],
		['dev'],
		['script'],
		['script', 'run'],
		['script', 'result'],
		['script', 'cancel'],
		['script', 'sync'],
		['dev', 'status'],
		['dev', 'instances'],
		['dev', 'run'],
		['dev', 'hmr'],
		['dev', 'sync'],
	]) {
		const result = await run(root, [...args, '--help'], {}, ['--import', guard])
		expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' })
		expect(result.stdout).toContain('USAGE:')
		expect(result.stderr).toBe('')
	}
})
