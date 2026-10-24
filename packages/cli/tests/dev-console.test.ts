import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { decodeDevReceipt, encodeDevReceipt } from '../src/dev/receipt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripVTControlCharacters } from 'node:util'
import { WriteStream } from 'node:tty'
import { cli as gunshiCli, type CliOptions } from 'gunshi'
import { renderCliHeader } from '../src/render-header'
import { devCommand } from '../src/commands/dev'
import { normalizeDevArgs } from '../src/command-manifest'
import {
	controlDevHmr,
	discoverDevInstances,
	liveDevInstances,
	parseInput,
	publicInstance,
	requestDev,
	runDevFile,
	selectDevInstance,
	type DevInstance,
} from '../src/dev/client'

// Exercise the same nested dev command path and renderer as the production CLI entry.
function cli(argv: string[], entry: typeof devCommand, options: CliOptions) {
	return gunshiCli(
		normalizeDevArgs(['dev', ...argv]),
		{ run() {} },
		{
			...options,
			renderHeader: renderCliHeader,
			subCommands: { dev: entry },
		},
	)
}

const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
	vi.stubEnv('NO_COLOR', '1')
	vi.stubEnv('FORCE_COLOR', undefined)
	vi.stubEnv('NODE_DISABLE_COLORS', undefined)
})
afterEach(async () => {
	process.exitCode = 0
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const close of cleanup.splice(0).toReversed()) await close()
})

async function fixture(
	handler?: (request: Record<string, unknown>, socket: Socket) => void,
	application?: Readonly<Record<string, unknown>>,
) {
	const root = await mkdtemp(resolve(tmpdir(), 'px-cli-'))
	cleanup.push(() => rm(root, { recursive: true, force: true }))
	await writeFile(resolve(root, 'package.json'), '{}')
	const directory = resolve(root, '.pluxel/dev-console')
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const instance: DevInstance = {
		protocol: 1,
		instanceId: randomUUID(),
		nonce: randomUUID(),
		pid: process.pid,
		root,
		socketPath: resolve(root, 'console.sock'),
		startedAt: new Date().toISOString(),
	}
	const requests: Record<string, unknown>[] = []
	const server = createServer((socket) => {
		let text = ''
		socket.on('data', (chunk) => {
			text += chunk.toString()
			if (!text.includes('\n')) return
			const request = JSON.parse(text.slice(0, text.indexOf('\n')))
			requests.push(request)
			if (request.method === 'inspect')
				socket.end(
					JSON.stringify({
						ok: true,
						value: { ...publicInstance(instance), ...(application ? { application } : {}) },
					}) + '\n',
				)
			else handler?.(request, socket)
		})
	})
	await new Promise<void>((ready) => server.listen(instance.socketPath, ready))
	cleanup.push(
		() =>
			new Promise<void>((done, reject) =>
				server.close((error) => (error ? reject(error) : done())),
			),
	)
	await writeFile(resolve(directory, `${instance.instanceId}.json`), JSON.stringify(instance), {
		mode: 0o600,
	})
	return { root, instance, requests, directory }
}

function snapshot(instanceId: string, runId: unknown, state = 'succeeded') {
	return { instanceId, runId, state, submittedAt: new Date().toISOString(), value: { count: 3 } }
}

describe('development console CLI', () => {
	it.each(['pause', 'apply', 'resume'])(
		'routes hmr %s directly and returns a receipt without a script',
		async (action) => {
			const { root, instance, requests } = await fixture(
				(request, socket) => {
					socket.end(
						JSON.stringify({
							ok: true,
							value: {
								...snapshot(instance.instanceId, request.runId, 'queued'),
								kind: 'hmr',
								action: request.action,
							},
						}) + '\n',
					)
				},
				{ state: 'unavailable', latestUpdate: null },
			)
			instance.hmr = {
				mode: 'paused',
				running: false,
				pending: { files: 2, full: false },
				observedRevision: 2,
				attemptedRevision: 0,
			}
			const output: string[] = []
			vi.spyOn(console, 'log').mockImplementation((message: string) => {
				output.push(message)
			})
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
			await cli(['hmr', action, '--root', root, '--timeout', '500', '--detach'], devCommand, {})
			const result = JSON.parse(output[0]!)
			expect(result).toMatchObject({
				ok: true,
				value: { kind: 'hmr', action, state: 'queued', root },
			})
			expect(decodeDevReceipt(result.value.receipt)).toMatchObject({
				root,
				instanceId: instance.instanceId,
				runId: result.value.runId,
			})
			expect(requests.filter(({ method }) => method !== 'inspect')).toEqual([
				expect.objectContaining({ method: 'hmr', action, timeoutMs: 500 }),
			])
			expect(requests.find(({ method }) => method === 'hmr')).not.toHaveProperty('file')
			expect(stderr).not.toHaveBeenCalled()
			expect(process.exitCode ?? 0).toBe(0)
			output.length = 0
			await cli(['status', '--root', root], devCommand, {})
			expect(JSON.parse(output[0]!)).toMatchObject({
				value: { instances: [{ hmr: instance.hmr }] },
			})
		},
	)

	it('does not replay HMR control when the connection is lost after submission', async () => {
		const { instance, requests } = await fixture((_request, socket) => socket.destroy())
		await expect(
			controlDevHmr({ instance, action: 'apply', timeoutMs: 1000, detach: false }),
		).rejects.toMatchObject({
			code: 'outcome_unknown',
			runId: expect.any(String),
			context: { instanceId: instance.instanceId, root: instance.root },
			hint: expect.stringContaining('receipt'),
		})
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({ method: 'hmr', action: 'apply' })
	})

	it.each(['restart', 'PAUSE', ''])(
		'rejects invalid HMR action %j before submission',
		async (action) => {
			const { instance, requests } = await fixture()
			await expect(
				controlDevHmr({ instance, action, timeoutMs: 1000, detach: false }),
			).rejects.toMatchObject({ code: 'invalid_input' })
			expect(requests).toHaveLength(0)
		},
	)

	it('discovers live consoles without returning local credentials', async () => {
		const { root, instance } = await fixture()
		expect(await selectDevInstance({ root })).toEqual(instance)
		const instances = await liveDevInstances(root)
		expect(instances.map(publicInstance)).toEqual([publicInstance(instance)])
		expect(publicInstance(instance)).not.toHaveProperty('nonce')
		expect(publicInstance(instance)).not.toHaveProperty('socketPath')
	})

	it('shows a live console whose application has not been admitted', async () => {
		const { root, instance } = await fixture(undefined, {
			state: 'unavailable',
			latestUpdate: {
				state: 'settled',
				outcome: 'failed',
				error: { message: 'Invalid app entry', file: 'app.ts', importChain: [] },
			},
		})
		const instances = await liveDevInstances(root)
		expect(instances.map(publicInstance)).toEqual([
			{
				...publicInstance(instance),
				application: expect.objectContaining({
					state: 'unavailable',
					latestUpdate: expect.objectContaining({ outcome: 'failed' }),
				}),
			},
		])
		expect(instances[0]).toMatchObject({ nonce: instance.nonce })
	})

	it('prints exactly one JSON frame with the production CLI name and version enabled', async () => {
		const { root, instance } = await fixture()
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['instances', '--root', root], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		expect(output).toEqual([JSON.stringify({ ok: true, value: [publicInstance(instance)] })])
	})

	it('selects only the explicitly chosen root when separate projects are running', async () => {
		const first = await fixture()
		const second = await fixture()
		const directory = resolve(first.root, 'src/dev')
		await mkdir(directory, { recursive: true })
		const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory)
		expect(await selectDevInstance({ root: first.root })).toEqual(first.instance)
		await expect(
			selectDevInstance({ root: first.root, instance: second.instance.instanceId }),
		).rejects.toMatchObject({
			code: 'dev_unavailable',
			context: { root: first.root, instanceId: second.instance.instanceId },
			message: 'The requested instance is not available in this project.',
			hint: expect.stringContaining('original instance'),
		})
		expect(second.requests).toHaveLength(0)
		cwd.mockReturnValue(second.root)
		expect(await selectDevInstance({ root: second.root })).toEqual(second.instance)
	})

	it('does not fall back to an ancestor host when the explicit root has no console', async () => {
		const parent = await fixture()
		const child = resolve(parent.root, 'projects/child')
		const directory = resolve(child, 'src')
		await mkdir(directory, { recursive: true })
		await writeFile(resolve(child, 'package.json'), '{}')
		vi.spyOn(process, 'cwd').mockReturnValue(directory)
		await expect(selectDevInstance({ root: child })).rejects.toMatchObject({
			code: 'dev_unavailable',
			context: { root: child },
			message: 'No running development console was found in the selected project.',
			hint: expect.stringContaining('devConsole enabled'),
		})
		expect(parent.requests).toHaveLength(0)
		expect(await selectDevInstance({ root: parent.root })).toEqual(parent.instance)
	})

	it('requires an exact instance selector when multiple dev hosts share a project', async () => {
		const first = await fixture()
		const second = await fixture()
		second.instance.root = first.root
		await writeFile(
			resolve(first.directory, `${second.instance.instanceId}.json`),
			JSON.stringify(second.instance),
			{ mode: 0o600 },
		)
		await expect(selectDevInstance({ root: first.root })).rejects.toMatchObject({
			code: 'ambiguous_instance',
		})
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['run', 'pending.ts', '--root', first.root], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		const diagnostic = JSON.parse(output[0]!)
		expect(diagnostic).toMatchObject({
			ok: false,
			error: {
				code: 'ambiguous_instance',
				context: { root: first.root },
				hint: expect.stringContaining('--instance'),
			},
		})
		expect(diagnostic.error.candidates).toHaveLength(2)
		expect(diagnostic.error.candidates).toEqual(
			expect.arrayContaining([publicInstance(first.instance), publicInstance(second.instance)]),
		)
		for (const instance of [first.instance, second.instance]) {
			expect(output[0]).not.toContain(instance.nonce)
			expect(output[0]).not.toContain(instance.socketPath)
		}
		expect(
			await selectDevInstance({ root: first.root, instance: second.instance.instanceId }),
		).toEqual(second.instance)
	})

	it('parses named exports and detached JSON input through the command parser', async () => {
		const { root, instance, requests } = await fixture((request, socket) => {
			socket.end(
				JSON.stringify({
					ok: true,
					value: snapshot(instance.instanceId, request.runId, 'queued'),
				}) + '\n',
			)
		})
		const file = resolve(root, 'actions.ts')
		await writeFile(file, 'export const add = () => 1')
		const messages: string[] = []
		const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			messages.push(message)
		})
		await cli(
			['run', file, '--root', root, '--export', 'add', '--input', '{"count":3}', '--detach'],
			devCommand,
			{ name: '@pluxel/cli', version: '1.0.0', subCommands: devCommand.subCommands },
		)
		expect(requests.find((request) => request.method === 'run')).toMatchObject({
			exportName: 'add',
			input: { count: 3 },
		})
		expect(JSON.parse(messages[0]!)).toMatchObject({
			ok: true,
			value: { state: 'queued', root, instanceId: instance.instanceId },
		})
		expect(process.exitCode ?? 0).toBe(0)
		expect(stderr).not.toHaveBeenCalled()
	})

	it('writes an accepted receipt to stderr while keeping stdout a single final JSON value', async () => {
		const { root, instance } = await fixture((request, socket) => {
			socket.end(
				JSON.stringify({ ok: true, value: snapshot(instance.instanceId, request.runId) }) + '\n',
			)
		})
		const file = resolve(root, 'operation.ts')
		await writeFile(file, 'export default () => 1')
		const output: string[] = []
		const diagnostics: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			diagnostics.push(String(chunk))
			return true
		})
		await cli(['run', file, '--root', root], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		expect(output).toHaveLength(1)
		expect(diagnostics).toHaveLength(1)
		const response = JSON.parse(output[0]!)
		expect(response).toMatchObject({
			ok: true,
			value: { state: 'succeeded', root, instanceId: instance.instanceId },
		})
		expect(decodeDevReceipt(response.value.receipt)).toEqual({
			root,
			instanceId: instance.instanceId,
			runId: response.value.runId,
		})
		expect(JSON.parse(diagnostics[0]!)).toEqual({
			event: 'accepted',
			root,
			runId: response.value.runId,
			instanceId: instance.instanceId,
			receipt: response.value.receipt,
			state: 'succeeded',
		})
	})

	it('submits source hash and JSON input once, then polls read-only results', async () => {
		const { root, instance, requests } = await fixture((request, socket) => {
			socket.end(
				JSON.stringify({
					ok: true,
					value: snapshot(
						instance.instanceId,
						request.runId,
						request.method === 'run' ? 'queued' : 'succeeded',
					),
				}) + '\n',
			)
		})
		const file = resolve(root, 'operation.ts')
		const source = 'export const add = async () => ({ count: 3 })'
		await writeFile(file, source)
		expect(
			await runDevFile({
				instance,
				file,
				exportName: 'add',
				input: { name: 'hello' },
				timeoutMs: 1000,
				detach: false,
			}),
		).toMatchObject({ state: 'succeeded', value: { count: 3 } })
		const submissions = requests.filter((request) => request.method === 'run')
		expect(submissions).toHaveLength(1)
		expect(submissions[0]).toMatchObject({
			file,
			sourceHash: createHash('sha256').update(source).digest('hex'),
			nonce: instance.nonce,
			input: { name: 'hello' },
			exportName: 'add',
		})
		expect(requests.filter((request) => request.method === 'result')).toHaveLength(1)
	})

	it('reports ambiguous acceptance with the recoverable run ID without retrying', async () => {
		const { instance, requests } = await fixture((_request, socket) => socket.destroy())
		await expect(
			requestDev(instance, { method: 'run', runId: 'recover-me' }),
		).rejects.toMatchObject({
			code: 'outcome_unknown',
			runId: 'recover-me',
			context: { root: instance.root, instanceId: instance.instanceId },
			hint: expect.stringContaining('before submitting again'),
		})
		expect(requests).toHaveLength(1)
	})

	it('reports enough JSON context to recover a submission whose acknowledgement was lost', async () => {
		const { root, instance, requests } = await fixture((_request, socket) => socket.destroy())
		const file = resolve(root, 'operation.ts')
		await writeFile(file, 'export default () => 1')
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['run', file, '--root', root], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		const submitted = requests.filter((request) => request.method === 'run')
		expect(submitted).toHaveLength(1)
		expect(output).toHaveLength(1)
		expect(JSON.parse(output[0]!)).toMatchObject({
			ok: false,
			error: {
				code: 'outcome_unknown',
				runId: submitted[0]!.runId,
				context: { root, instanceId: instance.instanceId },
				hint: expect.stringContaining('before submitting again'),
			},
		})
		expect(output[0]).not.toContain(instance.nonce)
		expect(output[0]).not.toContain(instance.socketPath)
		expect(decodeDevReceipt(JSON.parse(output[0]!).error.receipt)).toEqual({
			root,
			instanceId: instance.instanceId,
			runId: submitted[0]!.runId,
		})
	})

	it('keeps selected identity on failed and cancelled result snapshots', async () => {
		const { root, instance } = await fixture((request, socket) => {
			socket.end(
				JSON.stringify({
					ok: true,
					value: snapshot(
						instance.instanceId,
						request.runId,
						request.method === 'result' ? 'failed' : 'cancelled',
					),
				}) + '\n',
			)
		})
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		for (const command of ['result', 'cancel'])
			await cli(
				[
					command,
					encodeDevReceipt({ root, instanceId: instance.instanceId, runId: 'existing-run' }),
				],
				devCommand,
				{
					name: '@pluxel/cli',
					version: '1.0.0',
					subCommands: devCommand.subCommands,
				},
			)
		expect(output.map((value) => JSON.parse(value).value)).toEqual([
			expect.objectContaining({
				root,
				instanceId: instance.instanceId,
				runId: 'existing-run',
				state: 'failed',
			}),
			expect.objectContaining({
				root,
				instanceId: instance.instanceId,
				runId: 'existing-run',
				state: 'cancelled',
			}),
		])
	})

	it('discovers a console without a declaration or package file', async () => {
		const { root, instance } = await fixture()
		await rm(resolve(root, 'package.json'))
		vi.spyOn(process, 'cwd').mockReturnValue(root)
		vi.stubEnv('PATH', '')
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['instances'], devCommand, {})
		expect(JSON.parse(output[0]!)).toEqual({ ok: true, value: [publicInstance(instance)] })
	})

	it('accepts an instance selector with the current project', async () => {
		const { root, instance } = await fixture()
		vi.spyOn(process, 'cwd').mockReturnValue(root)
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['instances', '--instance', instance.instanceId], devCommand, {})
		expect(JSON.parse(output[0]!)).toEqual({ ok: true, value: [publicInstance(instance)] })
	})

	it('rejects misspelled dev options before selecting or contacting any instance', async () => {
		const { requests } = await fixture()
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		for (const command of ['run', 'result', 'cancel', 'instances', 'status']) {
			const positional = ['instances', 'status'].includes(command)
				? []
				: [command === 'run' ? 'script.ts' : 'run-id']
			await cli([command, ...positional, '--instnace', 'typo'], devCommand, {
				name: '@pluxel/cli',
				version: '1.0.0',
				subCommands: devCommand.subCommands,
			})
		}
		expect(output).toHaveLength(5)
		for (const message of output)
			expect(JSON.parse(message)).toMatchObject({
				ok: false,
				error: {
					code: 'invalid_input',
					message: 'Unknown dev option --instnace.',
					hint: expect.stringContaining('--help'),
				},
			})
		expect(requests).toHaveLength(0)
	})

	it('rejects symlink scripts escaping the selected project before submission', async () => {
		const { root, instance, requests } = await fixture()
		const outside = await mkdtemp(resolve(tmpdir(), 'px-outside-'))
		cleanup.push(() => rm(outside, { recursive: true, force: true }))
		await writeFile(resolve(outside, 'script.ts'), 'export default () => 1')
		await symlink(resolve(outside, 'script.ts'), resolve(root, 'script.ts'))
		await expect(
			runDevFile({
				instance,
				file: resolve(root, 'script.ts'),
				exportName: 'default',
				timeoutMs: 1000,
				detach: true,
			}),
		).rejects.toMatchObject({ code: 'invalid_input' })
		expect(requests.some((request) => request.method === 'run')).toBe(false)
	})

	it('rejects non-private discovery files', async () => {
		const { root, directory, instance } = await fixture()
		await chmod(resolve(directory, `${instance.instanceId}.json`), 0o644)
		await expect(discoverDevInstances(root)).rejects.toMatchObject({
			code: 'discovery_permissions',
		})
	})

	it('bounds input depth and size', () => {
		expect(() => parseInput('1e999')).toThrow('finite')
		expect(() => parseInput('['.repeat(66) + '0' + ']'.repeat(66))).toThrow('64 nesting')
		expect(() => parseInput(JSON.stringify('x'.repeat(1024 * 1024)))).toThrow('1 MiB')
		expect(parseInput('{"label":"你好"}')).toEqual({ label: '你好' })
	})

	it('prints structured argument failures without connecting or executing', async () => {
		const messages: string[] = []
		const log = vi.spyOn(console, 'log').mockImplementation((message: string) => {
			messages.push(message)
		})
		await cli(['run', 'script.ts', '--input', '{}', '--input-file', 'data.json'], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		expect(messages.map((message) => JSON.parse(message))).toEqual([
			{
				ok: false,
				error: {
					code: 'invalid_input',
					message: 'Use either --input or --input-file',
					hint: expect.stringContaining('dev run --help'),
				},
			},
		])
		expect(process.exitCode).toBe(1)
		log.mockRestore()
	})
})

async function pitchforkFixture(root: string, exitCode = 0, status = 'running') {
	await writeFile(
		resolve(root, 'package.json'),
		JSON.stringify({
			pluxel: { dev: { web: { pitchfork: 'app' } } },
		}),
	)
	await writeFile(
		resolve(root, 'pitchfork'),
		`#!${process.execPath}
const args = process.argv.slice(2)
if (JSON.stringify(args) === JSON.stringify(['status', 'app', '--json'])) {
 console.log(JSON.stringify({ id: 'workspace/app', status: ${JSON.stringify(status)} }))
} else if (JSON.stringify(args) === JSON.stringify(['start', 'workspace/app', '--quiet'])) {
 process.exit(${exitCode})
} else { process.exit(99) }
`,
		{ mode: 0o755 },
	)
	vi.stubEnv('PATH', `${root}:${process.env.PATH}`)
	vi.spyOn(process, 'cwd').mockReturnValue(root)
}

async function bindProfile(instance: DevInstance, profile: string, project = instance.root) {
	instance.profile = profile
	instance.project = project
	await writeFile(
		resolve(instance.root, '.pluxel/dev-console', `${instance.instanceId}.json`),
		JSON.stringify(instance),
		{ mode: 0o600 },
	)
}

async function bindService(
	instance: DevInstance,
	serviceId = 'workspace/app',
	root = instance.root,
) {
	instance.root = root
	instance.serviceId = serviceId
	await writeFile(
		resolve(root, '.pluxel/dev-console', `${instance.instanceId}.json`),
		JSON.stringify(instance),
		{ mode: 0o600 },
	)
}

it('dev prints fresh server-owned URLs on repeated invocations without running a console script', async () => {
	const { root, instance, requests } = await fixture(undefined, {
		state: 'ready',
		latestUpdate: null,
	})
	await pitchforkFixture(root)
	await bindService(instance)
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	instance.urlOutput = [
		'  ➜  Application: http://app.localhost:8088/',
		'  ➜  Workbench:   http://app.localhost:8088/admin',
	]
	await cli([], devCommand, {})
	expect(output).toEqual(['  Pluxel · web · reused', '', ...instance.urlOutput!])
	output.length = 0
	instance.urlOutput = ['  ➜  Workbench:   http://app.localhost:8088/']
	await cli([], devCommand, {})
	expect(output).toEqual(['  Pluxel · web · reused', '', ...instance.urlOutput!])
	expect(requests.map(({ method }) => method)).toEqual(['inspect', 'inspect'])
})

it('dev preserves startup failure and does not print an unrelated live instance', async () => {
	const { root, requests } = await fixture()
	await pitchforkFixture(root, 7)
	const log = vi.spyOn(console, 'log').mockImplementation(() => {})
	await cli([], devCommand, {})
	expect(process.exitCode).toBe(7)
	expect(requests).toHaveLength(0)
	expect(log).not.toHaveBeenCalled()
})

it('dev reports a missing URL capability instead of inventing a Workbench address', async () => {
	const { root, instance } = await fixture()
	await pitchforkFixture(root)
	await bindService(instance)
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli([], devCommand, {})
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).toContain('no URL presentation')
	expect(output.join('\n')).not.toContain('/__pluxel/workbench')
})

it('routes result and cancel receipts to the original instance regardless of cwd or newer instances', async () => {
	const original = await fixture((request, socket) => {
		socket.end(
			JSON.stringify({ ok: true, value: snapshot(original.instance.instanceId, request.runId) }) +
				'\n',
		)
	})
	await bindService(original.instance)
	const replacement = await fixture()
	await bindService(replacement.instance, 'workspace/app', original.root)
	const otherService = await fixture()
	await bindService(otherService.instance, 'workspace/other', original.root)
	const unrelated = await fixture()
	vi.spyOn(process, 'cwd').mockReturnValue(unrelated.root)
	const receipt = encodeDevReceipt({ ...original.instance, runId: 'original-run' })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => output.push(message))
	for (const command of ['result', 'cancel']) await cli([command, receipt], devCommand, {})
	expect(output.map((line) => JSON.parse(line))).toEqual([
		expect.objectContaining({
			ok: true,
			value: expect.objectContaining({ instanceId: original.instance.instanceId, receipt }),
		}),
		expect.objectContaining({
			ok: true,
			value: expect.objectContaining({ instanceId: original.instance.instanceId, receipt }),
		}),
	])
	expect(
		original.requests.filter(({ method }) => method !== 'inspect').map(({ method }) => method),
	).toEqual(['result', 'cancel'])
	expect(unrelated.requests).toHaveLength(0)

	await rm(resolve(original.directory, `${original.instance.instanceId}.json`))
	output.length = 0
	for (const command of ['result', 'cancel']) await cli([command, receipt], devCommand, {})
	for (const line of output)
		expect(JSON.parse(line)).toMatchObject({
			ok: false,
			error: {
				code: 'dev_unavailable',
				runId: 'original-run',
				receipt,
				context: { instanceId: original.instance.instanceId, serviceId: 'workspace/app' },
			},
		})
	for (const candidate of [replacement, otherService]) {
		expect(
			candidate.requests.some(
				({ method }) => method === 'result' || method === 'cancel' || method === 'run',
			),
		).toBe(false)
	}
})

it('refuses a receipt whose service no longer matches its instance', async () => {
	const { instance, requests } = await fixture()
	await bindService(instance, 'workspace/other')
	const receipt = encodeDevReceipt({ ...instance, serviceId: 'workspace/app', runId: 'old-run' })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => output.push(message))
	await cli(['cancel', receipt], devCommand, {})
	expect(JSON.parse(output[0]!)).toMatchObject({
		ok: false,
		error: { code: 'dev_unavailable', receipt },
	})
	expect(requests.some(({ method }) => method === 'cancel')).toBe(false)
})

it('reads status and executes an operation without Pitchfork even when startup declares it', async () => {
	const { root, instance, requests } = await fixture((request, socket) => {
		socket.end(
			JSON.stringify({ ok: true, value: snapshot(instance.instanceId, request.runId) }) + '\n',
		)
	})
	await writeFile(
		resolve(root, 'package.json'),
		JSON.stringify({ pluxel: { dev: { web: { pitchfork: 'app' } } } }),
	)
	await bindService(instance)
	const file = resolve(root, 'inspect.ts')
	await writeFile(file, 'export default () => 1')
	vi.stubEnv('PATH', '')
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['status', '--root', root], devCommand, {})
	expect(JSON.parse(output[0]!)).toMatchObject({
		ok: true,
		value: { root, instances: [expect.objectContaining({ instanceId: instance.instanceId })] },
	})
	await cli(['run', file, '--root', root, '--detach'], devCommand, {})
	expect(JSON.parse(output[1]!)).toMatchObject({
		ok: true,
		value: { instanceId: instance.instanceId, state: 'succeeded' },
	})
	expect(requests.filter(({ method }) => method === 'run')).toHaveLength(1)
})

it.each([undefined, { command: 'command-must-not-run' }])(
	'reuses an existing ordinary Vite console without a supervisor (%j)',
	async (dev) => {
		const { root, instance } = await fixture(undefined, { state: 'ready' })
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify(dev ? { pluxel: { dev: { app: dev } } } : {}),
		)
		if (dev) await bindProfile(instance, 'app')
		instance.urlOutput = [
			'  ➜  Local: http://localhost:5173/',
			'  ➜  Workbench: http://localhost:5173/custom',
		]
		vi.stubEnv('PATH', '')
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		for (let invocation = 0; invocation < 2; invocation++) {
			output.length = 0
			await cli(['--root', root], devCommand, {})
			expect(output).toEqual([
				dev ? '  Pluxel · app · reused' : '  Pluxel · reused',
				'',
				...instance.urlOutput!,
			])
			expect(process.exitCode ?? 0).toBe(0)
		}
	},
)

it('dev can redisplay a manually started console using --root', async () => {
	const { root, instance } = await fixture(undefined, { state: 'ready' })
	instance.urlOutput = ['  ➜  Local: http://localhost:5173/']
	vi.stubEnv('PATH', '')
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(output).toEqual(['  Pluxel · reused', '', ...instance.urlOutput!])
})

it('runs a configured command in its workspace and preserves its exit status', async () => {
	const { root, directory } = await fixture()
	await rm(directory, { recursive: true })
	await writeFile(
		resolve(root, 'start.cjs'),
		'process.exit(require("node:fs").existsSync("start.cjs") && process.env.PLUXEL_DEV_PROFILE === "app" && process.env.PLUXEL_DEV_PROJECT === process.cwd() ? 7 : 99)',
	)
	await writeFile(
		resolve(root, 'package.json'),
		JSON.stringify({
			pluxel: { dev: { app: { command: `${JSON.stringify(process.execPath)} start.cjs` } } },
		}),
	)
	const log = vi.spyOn(console, 'log').mockImplementation(() => {})
	await cli(['--root', root], devCommand, {})
	expect(process.exitCode).toBe(7)
	expect(log.mock.calls).toEqual([['  Pluxel · app · starting'], ['']])
})

it('explains missing launch configuration when there is no live console', async () => {
	const { root, directory } = await fixture()
	await rm(directory, { recursive: true })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).toContain('invalid_project')
	expect(output.join('\n')).toContain('command')
})

it('rejects ambiguous command-mode dev and permits an explicit instance', async () => {
	const first = await fixture(undefined, { state: 'ready' })
	const second = await fixture(undefined, { state: 'ready' })
	second.instance.root = first.root
	await writeFile(
		resolve(first.directory, `${second.instance.instanceId}.json`),
		JSON.stringify(second.instance),
		{ mode: 0o600 },
	)
	await bindProfile(first.instance, 'app')
	await bindProfile(second.instance, 'app')
	second.instance.urlOutput = ['  ➜  Local: http://localhost:5174/']
	await writeFile(
		resolve(first.root, 'package.json'),
		JSON.stringify({ pluxel: { dev: { app: { command: 'must-not-run' } } } }),
	)
	vi.stubEnv('PATH', '')
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', first.root], devCommand, {})
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).toContain('ambiguous_instance')
	process.exitCode = 0
	output.length = 0
	await cli(['--root', first.root, '--instance', second.instance.instanceId], devCommand, {})
	expect(output).toEqual(['  Pluxel · app · reused', '', ...second.instance.urlOutput!])
	expect(process.exitCode).toBe(0)
})

it('Pitchfork startup only displays the exact service console when several share a root', async () => {
	const selected = await fixture(undefined, { state: 'ready' })
	const unrelated = await fixture(undefined, { state: 'ready' })
	await pitchforkFixture(selected.root)
	await bindService(selected.instance)
	await bindService(unrelated.instance, 'other-worktree/app', selected.root)
	selected.instance.urlOutput = ['  ➜  Application: http://selected.localhost:8088/']
	unrelated.instance.urlOutput = ['  ➜  Application: http://unrelated.localhost:8088/']
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli([], devCommand, {})
	expect(output).toEqual(['  Pluxel · web · reused', '', ...selected.instance.urlOutput!])
	expect(process.exitCode ?? 0).toBe(0)
})

it('does not route an instance selector value as a dev subcommand', async () => {
	const { root, requests } = await fixture()
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root, '--instance', 'status'], devCommand, {})
	expect(output.join('\n')).toContain('dev_unavailable')
	expect(output.join('\n')).toContain('requested instance')
	expect(process.exitCode).toBe(1)
	expect(requests.some(({ method }) => method !== 'inspect')).toBe(false)
})

it('rejects a selector without a value before contacting a console', async () => {
	const { root, requests } = await fixture()
	vi.spyOn(process, 'cwd').mockReturnValue(root)
	vi.spyOn(console, 'log').mockImplementation(() => {})
	await expect(cli(['--root'], devCommand, {})).rejects.toMatchObject({
		errors: [expect.objectContaining({ message: expect.stringContaining('root') })],
	})
	expect(requests).toHaveLength(0)
})

it('replays only the selected command profile when profiles share a root', async () => {
	const first = await fixture(undefined, { state: 'ready' })
	const second = await fixture(undefined, { state: 'ready' })
	second.instance.root = first.root
	await bindProfile(first.instance, 'first')
	await bindProfile(second.instance, 'second')
	first.instance.urlOutput = ['  ➜  Local: http://localhost:5173/']
	second.instance.urlOutput = ['  ➜  Local: http://localhost:5174/']
	await writeFile(
		resolve(first.root, 'package.json'),
		JSON.stringify({
			pluxel: {
				dev: {
					first: { command: 'must-not-run' },
					second: { command: 'must-not-run' },
				},
			},
		}),
	)
	vi.stubEnv('PATH', '')
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', first.root, '--profile', 'second'], devCommand, {})
	expect(output).toEqual(['  Pluxel · second · reused', '', ...second.instance.urlOutput!])
	output.length = 0
	await cli(
		['--root', first.root, '--profile', 'first', '--instance', second.instance.instanceId],
		devCommand,
		{},
	)
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).toContain('dev_unavailable')
})

async function serviceOnlyFixture(
	root: string,
	after: Record<string, unknown> = {
		id: 'workspace/docs',
		status: 'running',
		url: 'http://docs.localhost:8088/',
	},
) {
	await writeFile(
		resolve(root, 'package.json'),
		JSON.stringify({ pluxel: { dev: { docs: { pitchfork: 'docs', console: false } } } }),
	)
	const callsFile = resolve(root, 'pitchfork-calls.jsonl')
	await writeFile(callsFile, '')
	await writeFile(
		resolve(root, 'pitchfork'),
		`#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n')
const state = ${JSON.stringify(resolve(root, 'started'))}
if (JSON.stringify(args) === JSON.stringify(['status', 'docs', '--json'])) {
 console.log(JSON.stringify(fs.existsSync(state) ? ${JSON.stringify(after)} : { id: 'workspace/docs', status: 'stopped', url: 'http://stale.localhost:8088/' }))
} else if (JSON.stringify(args) === JSON.stringify(['start', 'workspace/docs', '--quiet'])) {
 fs.writeFileSync(state, '')
} else { process.exit(99) }
`,
		{ mode: 0o755 },
	)
	vi.stubEnv('PATH', root)
	return async () => {
		const output = await readFile(callsFile, 'utf8')
		return output
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[])
	}
}

it.each([
	{ id: 'workspace/docs', status: 'running', url: 'http://docs.localhost:8088/' },
	{ id: 'workspace/docs', status: 'running', proxy_url: 'http://docs.localhost:8088/' },
])('starts a service-only profile and prints its fresh service URL (%j)', async (after) => {
	const { root, requests } = await fixture()
	const calls = await serviceOnlyFixture(root, after)
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(process.exitCode ?? 0).toBe(0)
	expect(output.slice(0, 2)).toEqual(['  Pluxel · docs · started', ''])
	expect(output.join('\n')).toContain('Service: workspace/docs (running)')
	expect(output.join('\n')).toContain('http://docs.localhost:8088/')
	expect(output.join('\n')).not.toContain('stale.localhost')
	expect(output.join('\n')).not.toContain('Workbench')
	expect(await calls()).toEqual([
		['status', 'docs', '--json'],
		['start', 'workspace/docs', '--quiet'],
		['status', 'docs', '--json'],
	])
	expect(requests).toHaveLength(0)
})

it('reads service-only status without starting or discovering application instances', async () => {
	const { root, requests } = await fixture()
	const calls = await serviceOnlyFixture(root)
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['status', '--root', root], devCommand, {})
	expect(JSON.parse(output[0]!)).toEqual({
		ok: true,
		value: {
			workspace: root,
			profile: 'docs',
			root,
			console: false,
			service: { id: 'workspace/docs', status: 'stopped', url: 'http://stale.localhost:8088/' },
		},
	})
	expect(await calls()).toEqual([['status', 'docs', '--json']])
	expect(requests).toHaveLength(0)
})

it.each(['instances', 'run'])(
	'rejects %s for a service-only profile before starting or contacting sockets',
	async (command) => {
		const { root, requests } = await fixture()
		const calls = await serviceOnlyFixture(root)
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(
			[command, ...(command === 'run' ? ['missing.ts'] : []), '--root', root],
			devCommand,
			{},
		)
		expect(JSON.parse(output[0]!)).toMatchObject({
			ok: false,
			error: { code: 'unsupported_console' },
		})
		expect(await calls()).toEqual([])
		expect(requests).toHaveLength(0)
	},
)

it('rejects --instance for service-only startup before invoking Pitchfork', async () => {
	const { root, requests, instance } = await fixture()
	const calls = await serviceOnlyFixture(root)
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root, '--instance', instance.instanceId], devCommand, {})
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).toContain('unsupported_console')
	expect(await calls()).toEqual([])
	expect(requests).toHaveLength(0)
})

it('rejects service ownership changing between startup and fresh status', async () => {
	const { root, requests } = await fixture()
	await serviceOnlyFixture(root, {
		id: 'other-workspace/docs',
		status: 'running',
		url: 'http://unrelated.localhost:8088/',
	})
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).not.toContain('http://unrelated.localhost:8088/')
	expect(requests).toHaveLength(0)
})

it('does not treat an application with a missing console as a service-only profile', async () => {
	const { root, directory, requests } = await fixture()
	await pitchforkFixture(root)
	await rm(directory, { recursive: true })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(process.exitCode).toBe(1)
	expect(output.join('\n')).toContain('dev_unavailable')
	expect(output.join('\n')).not.toContain('Service:')
	expect(requests).toHaveLength(0)
})

it('uses the same default and explicit profile across startup, status, instances and run', async () => {
	const first = await fixture(
		(request, socket) => {
			socket.end(
				JSON.stringify({ ok: true, value: snapshot(first.instance.instanceId, request.runId) }) +
					'\n',
			)
		},
		{ state: 'ready' },
	)
	const second = await fixture(
		(request, socket) => {
			socket.end(
				JSON.stringify({ ok: true, value: snapshot(second.instance.instanceId, request.runId) }) +
					'\n',
			)
		},
		{ state: 'ready' },
	)
	second.instance.root = first.root
	await bindProfile(first.instance, 'first')
	await bindProfile(second.instance, 'second')
	first.instance.urlOutput = ['  ➜  Local: http://localhost:5173/']
	second.instance.urlOutput = ['  ➜  Local: http://localhost:5174/']
	await writeFile(
		resolve(first.root, 'package.json'),
		JSON.stringify({
			pluxel: {
				dev: {
					default: 'first',
					first: { command: 'must-not-run' },
					second: { command: 'must-not-run' },
				},
			},
		}),
	)
	const file = resolve(first.root, 'inspect.ts')
	await writeFile(file, 'export default () => 1')
	vi.stubEnv('PATH', '')
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	for (const [args, selected] of [
		[[], first],
		[['--profile', 'second'], second],
	] as const) {
		output.length = 0
		await cli(['--root', first.root, ...args], devCommand, {})
		expect(output).toEqual([
			`  Pluxel · ${selected.instance.profile} · reused`,
			'',
			...selected.instance.urlOutput!,
		])
		for (const command of ['status', 'instances', 'run']) {
			output.length = 0
			await cli(
				[command, ...(command === 'run' ? [file, '--detach'] : []), '--root', first.root, ...args],
				devCommand,
				{},
			)
			const result = JSON.parse(output[0]!)
			expect(result.ok).toBe(true)
			const instances: DevInstance[] =
				command === 'status'
					? result.value.instances
					: command === 'instances'
						? result.value
						: [result.value]
			expect(instances.map((item) => item.instanceId)).toEqual([selected.instance.instanceId])
		}
	}
})

it('reports a service that remains stopped without inventing an application URL', async () => {
	const { root, requests } = await fixture()
	await serviceOnlyFixture(root, { id: 'workspace/docs', status: 'stopped' })
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(process.exitCode).toBe(2)
	expect(output.slice(0, 2)).toEqual(['  Pluxel · docs · not running', ''])
	expect(output.join('\n')).toContain('Service: workspace/docs (stopped)')
	expect(output.join('\n')).not.toContain('http')
	expect(output.join('\n')).not.toContain('Workbench')
	expect(requests).toHaveLength(0)
})

it.each([
	{ profile: 'app' },
	{ project: '/absolute' },
	{ profile: 'app', project: 'relative' },
	{ profile: 'app', project: '/with\nnewline' },
	{ profile: 'app', project: 123 },
])(
	'rejects malformed paired command profile provenance before socket access (%j)',
	async (binding) => {
		const { root, directory, instance, requests } = await fixture()
		await writeFile(
			resolve(directory, `${instance.instanceId}.json`),
			JSON.stringify({ ...instance, ...binding }),
			{ mode: 0o600 },
		)
		await expect(discoverDevInstances(root)).rejects.toMatchObject({ code: 'invalid_discovery' })
		expect(requests).toHaveLength(0)
	},
)

it('keeps URL reuse and console execution within the declaring package for same-name profiles', async () => {
	const outer = await fixture(
		(request, socket) => {
			socket.end(
				JSON.stringify({ ok: true, value: snapshot(outer.instance.instanceId, request.runId) }) +
					'\n',
			)
		},
		{ state: 'ready' },
	)
	const inner = await fixture(
		(request, socket) => {
			socket.end(
				JSON.stringify({ ok: true, value: snapshot(inner.instance.instanceId, request.runId) }) +
					'\n',
			)
		},
		{ state: 'ready' },
	)
	const web = resolve(outer.root, 'web')
	await mkdir(resolve(web, '.pluxel/dev-console'), { recursive: true, mode: 0o700 })
	outer.instance.root = web
	inner.instance.root = web
	await bindProfile(outer.instance, 'app', outer.root)
	await bindProfile(inner.instance, 'app', web)
	outer.instance.urlOutput = ['  ➜  Local: http://localhost:5173/']
	inner.instance.urlOutput = ['  ➜  Local: http://localhost:5174/']
	await writeFile(
		resolve(outer.root, 'package.json'),
		JSON.stringify({ pluxel: { dev: { app: { root: 'web', command: 'must-not-run' } } } }),
	)
	await writeFile(
		resolve(web, 'package.json'),
		JSON.stringify({ pluxel: { dev: { app: { command: 'must-not-run' } } } }),
	)
	const file = resolve(web, 'inspect.ts')
	await writeFile(file, 'export default () => 1')
	vi.stubEnv('PATH', '')
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	for (const [root, selected, other] of [
		[outer.root, outer, inner],
		[web, inner, outer],
	] as const) {
		output.length = 0
		await cli(['--root', root], devCommand, {})
		expect(output).toEqual([
			`  Pluxel · ${selected.instance.profile} · reused`,
			'',
			...selected.instance.urlOutput!,
		])
		output.length = 0
		await cli(['run', file, '--root', root, '--detach'], devCommand, {})
		expect(JSON.parse(output[0]!)).toMatchObject({
			ok: true,
			value: { instanceId: selected.instance.instanceId },
		})
		output.length = 0
		await cli(['--root', root, '--instance', other.instance.instanceId], devCommand, {})
		expect(output.join('\n')).toContain('dev_unavailable')
		output.length = 0
		await cli(
			['run', file, '--root', root, '--instance', other.instance.instanceId, '--detach'],
			devCommand,
			{},
		)
		expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, error: { code: 'dev_unavailable' } })
	}
	for (const current of [outer, inner])
		expect(current.requests.filter(({ method }) => method === 'run')).toHaveLength(1)
})

it('marks a managed application started after a successful start from stopped state', async () => {
	const { root, instance } = await fixture(undefined, { state: 'ready' })
	await pitchforkFixture(root, 0, 'stopped')
	await bindService(instance)
	instance.urlOutput = ['  ➜  Application: http://app.localhost:8088/']
	const output: string[] = []
	vi.spyOn(console, 'log').mockImplementation((message: string) => {
		output.push(message)
	})
	await cli(['--root', root], devCommand, {})
	expect(output).toEqual(['  Pluxel · web · started', '', ...instance.urlOutput])
	expect(process.exitCode ?? 0).toBe(0)
})

function mockTerminal(isTTY: boolean) {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
	const colorDepth = Object.getOwnPropertyDescriptor(process.stdout, 'getColorDepth')
	// Keep Node's native color detection when simulating a terminal on a pipe.
	Object.defineProperty(process.stdout, 'getColorDepth', {
		value: WriteStream.prototype.getColorDepth,
		configurable: true,
	})
	Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY })
	cleanup.push(async () => {
		if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
		if (colorDepth) Object.defineProperty(process.stdout, 'getColorDepth', colorDepth)
		else Reflect.deleteProperty(process.stdout, 'getColorDepth')
	})
}

it.each([undefined, '', '1'])(
	'honors FORCE_COLOR with NO_COLOR=%j while JSON and metadata stay plain',
	async (noColor) => {
		const { root, instance } = await fixture(undefined, { state: 'ready' })
		const urls = [
			'  ➜  Application: http://localhost:5173/',
			'  ➜  Workbench:   http://localhost:5173/admin',
		]
		instance.urlOutput = [...urls]
		mockTerminal(false)
		vi.stubEnv('NO_COLOR', noColor)
		vi.stubEnv('FORCE_COLOR', '1')
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['--root', root], devCommand, {})
		expect(output.map(stripVTControlCharacters)).toEqual(['  Pluxel · reused', '', ...urls])
		const urlOutput = output.slice(2).join('\n')
		expect(urlOutput).toContain('\u001b[32m')
		expect(urlOutput).toContain('\u001b[1m')
		expect(urlOutput).toContain('\u001b[36m')
		expect(instance.urlOutput).toEqual(urls)
		output.length = 0
		await cli(['status', '--root', root], devCommand, {})
		expect(output).toHaveLength(1)
		expect(output[0]).not.toContain('\u001b')
		expect(JSON.parse(output[0]!).value.instances[0].urlOutput).toEqual(urls)
	},
)

it.each([
	{ force: undefined, noColor: undefined, tty: false },
	{ force: undefined, noColor: '1', tty: true },
])(
	'keeps presentation plain for a pipe or explicit NO_COLOR (%j)',
	async ({ force, noColor, tty }) => {
		const { root, instance } = await fixture(undefined, { state: 'ready' })
		instance.urlOutput = ['  ➜  Local: http://localhost:5173/']
		mockTerminal(tty)
		vi.stubEnv('FORCE_COLOR', force)
		vi.stubEnv('NO_COLOR', noColor)
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['--root', root], devCommand, {})
		expect(output).toEqual(['  Pluxel · reused', '', ...instance.urlOutput])
		expect(output.join('\n')).not.toContain('\u001b')
	},
)
