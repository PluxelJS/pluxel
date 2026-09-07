import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cli as gunshiCli, type CliOptions } from 'gunshi'
import { renderCliHeader } from '../src/render-header'
import { devCommand } from '../src/commands/dev'
import {
	discoverDevInstances,
	liveDevInstances,
	parseInput,
	publicInstance,
	requestDev,
	resolveDevRoot,
	runDevFile,
	selectDevInstance,
	type DevInstance,
} from '../src/dev/client'

// Exercise the same nested dev command path and renderer as the production CLI entry.
function cli(argv: string[], entry: typeof devCommand, options: CliOptions) {
	return gunshiCli(
		['dev', ...argv],
		{ run() {} },
		{
			...options,
			renderHeader: renderCliHeader,
			subCommands: { dev: entry },
		},
	)
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	process.exitCode = 0
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).toReversed()) await close()
})

async function fixture(handler?: (request: Record<string, unknown>, socket: Socket) => void) {
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
				socket.end(JSON.stringify({ ok: true, value: publicInstance(instance) }) + '\n')
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
	it('discovers live consoles without returning local credentials', async () => {
		const { root, instance } = await fixture()
		expect(await selectDevInstance({ root })).toEqual(instance)
		const instances = await liveDevInstances(root)
		expect(instances.map(publicInstance)).toEqual([publicInstance(instance)])
		expect(publicInstance(instance)).not.toHaveProperty('nonce')
		expect(publicInstance(instance)).not.toHaveProperty('socketPath')
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

	it('selects only the current project when separate projects are running', async () => {
		const first = await fixture()
		const second = await fixture()
		const directory = resolve(first.root, 'src/dev')
		await mkdir(directory, { recursive: true })
		const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory)
		expect(await selectDevInstance({})).toEqual(first.instance)
		await expect(selectDevInstance({ instance: second.instance.instanceId })).rejects.toMatchObject(
			{
				code: 'dev_unavailable',
				context: { root: first.root, instanceId: second.instance.instanceId },
				message: 'The requested instance is not available in this project.',
				hint: expect.stringContaining('--root'),
			},
		)
		expect(second.requests).toHaveLength(0)
		cwd.mockReturnValue(second.root)
		expect(await selectDevInstance({})).toEqual(second.instance)
	})

	it('does not fall back to an ancestor host across a package boundary', async () => {
		const parent = await fixture()
		const child = resolve(parent.root, 'projects/child')
		const directory = resolve(child, 'src')
		await mkdir(directory, { recursive: true })
		await writeFile(resolve(child, 'package.json'), '{}')
		vi.spyOn(process, 'cwd').mockReturnValue(directory)
		await expect(selectDevInstance({})).rejects.toMatchObject({
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
		await cli(['result', 'pending-result', '--root', first.root], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		const diagnostic = JSON.parse(output[0]!)
		expect(diagnostic).toMatchObject({
			ok: false,
			error: {
				code: 'ambiguous_instance',
				runId: 'pending-result',
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
		expect(JSON.parse(diagnostics[0]!)).toEqual({
			event: 'accepted',
			root,
			runId: response.value.runId,
			instanceId: instance.instanceId,
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
				root,
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
			await cli([command, 'existing-run', '--root', root], devCommand, {
				name: '@pluxel/cli',
				version: '1.0.0',
				subCommands: devCommand.subCommands,
			})
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

	it('explains a missing project without claiming that a root was selected', async () => {
		const { root, requests } = await fixture()
		await rm(resolve(root, 'package.json'))
		vi.spyOn(process, 'cwd').mockReturnValue(root)
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['instances'], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		const error = JSON.parse(output[0]!).error
		expect(error).toMatchObject({
			code: 'dev_unavailable',
			message: expect.stringContaining('No package.json project root'),
			hint: expect.stringContaining('--root'),
		})
		expect(error.context).toBeUndefined()
		expect(requests).toHaveLength(0)
	})

	it('does not accept an ignored instance selector for the project-wide instances command', async () => {
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		await cli(['instances', '--instance', 'ignored'], devCommand, {
			name: '@pluxel/cli',
			version: '1.0.0',
			subCommands: devCommand.subCommands,
		})
		expect(JSON.parse(output[0]!)).toMatchObject({
			ok: false,
			error: {
				code: 'invalid_input',
				message: expect.stringContaining('Unknown dev option --instance'),
				hint: expect.stringContaining('--help'),
			},
		})
	})

	it('rejects misspelled dev options before selecting or contacting any instance', async () => {
		const { root, requests } = await fixture()
		const output: string[] = []
		vi.spyOn(console, 'log').mockImplementation((message: string) => {
			output.push(message)
		})
		for (const command of ['run', 'result', 'cancel', 'instances']) {
			const positional = command === 'instances' ? [] : [command === 'run' ? 'script.ts' : 'run-id']
			await cli([command, ...positional, '--root', root, '--instnace', 'typo'], devCommand, {
				name: '@pluxel/cli',
				version: '1.0.0',
				subCommands: devCommand.subCommands,
			})
		}
		expect(output).toHaveLength(4)
		for (const message of output)
			expect(JSON.parse(message)).toMatchObject({
				ok: false,
				error: {
					code: 'invalid_input',
					context: { root },
					message: 'Unknown dev option --instnace.',
					hint: expect.stringContaining('--help'),
				},
			})
		expect(requests).toHaveLength(0)
	})

	it('rejects symlink scripts escaping the selected project before submission', async () => {
		const { root, requests } = await fixture()
		const outside = await mkdtemp(resolve(tmpdir(), 'px-outside-'))
		cleanup.push(() => rm(outside, { recursive: true, force: true }))
		await writeFile(resolve(outside, 'script.ts'), 'export default () => 1')
		await symlink(resolve(outside, 'script.ts'), resolve(root, 'script.ts'))
		await expect(
			runDevFile({
				root,
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
					context: { root: await resolveDevRoot() },
					hint: expect.stringContaining('dev run --help'),
				},
			},
		])
		expect(process.exitCode).toBe(1)
		log.mockRestore()
	})
})
