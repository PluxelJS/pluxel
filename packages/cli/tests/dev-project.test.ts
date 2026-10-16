import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicInstance, type DevInstance } from '../src/dev/client'
import {
	connectDevProject,
	readDevService,
	resolveDevSelection,
	resolveDevProject,
	startDevService,
} from '../src/dev/project'

const cleanup: Array<() => Promise<void>> = []
let socketCounter = 0

afterEach(async () => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	for (const dispose of cleanup.splice(0).toReversed()) await dispose()
})

async function workspace(config: unknown = { app: { root: 'web', pitchfork: 'server' } }) {
	const directory = await mkdtemp(resolve(tmpdir(), 'px-project-'))
	cleanup.push(() => rm(directory, { recursive: true, force: true }))
	const root = resolve(directory, 'workspace')
	const web = resolve(root, 'web')
	await mkdir(web, { recursive: true })
	await writeFile(resolve(root, 'package.json'), JSON.stringify({ pluxel: { dev: config } }))
	await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages: []\n')
	return { directory, root, web }
}

async function pitchfork(directory: string) {
	const bin = resolve(directory, 'bin')
	const calls = resolve(directory, 'pitchfork-calls.jsonl')
	await mkdir(bin)
	await writeFile(calls, '')
	await writeFile(
		resolve(bin, 'pitchfork'),
		`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PLUXEL_TEST_PITCHFORK_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'status') {
  process.stdout.write(process.env.PLUXEL_TEST_PITCHFORK_STATUS || JSON.stringify({ id: 'fixture/' + args[1], status: 'running' }));
} else if (args[0] === 'start') {
  process.exitCode = 0;
} else {
  process.exitCode = 1;
}
`,
		{ mode: 0o700 },
	)
	vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
	vi.stubEnv('PLUXEL_TEST_PITCHFORK_CALLS', calls)
	return async (): Promise<Array<{ args: string[]; cwd: string }>> => {
		const output = await readFile(calls, 'utf8')
		return output
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	}
}

async function consoleInstance(
	root: string,
	serviceId?: string,
	reportedServiceId = serviceId,
	profile?: string,
	reportedProfile = profile,
	project = profile ? root : undefined,
	reportedProject = project,
) {
	const discovery = resolve(root, '.pluxel/dev-console')
	await mkdir(discovery, { recursive: true, mode: 0o700 })
	// Keep Unix socket paths short even when the platform's temporary directory is nested.
	const sockets = await mkdtemp(resolve(tmpdir(), 'px-s-'))
	cleanup.push(() => rm(sockets, { recursive: true, force: true }))
	const instance: DevInstance = {
		protocol: 1,
		instanceId: randomUUID(),
		nonce: randomUUID(),
		pid: process.pid,
		root,
		socketPath: resolve(sockets, `${++socketCounter}.sock`),
		startedAt: new Date().toISOString(),
		...(serviceId ? { serviceId } : {}),
		...(profile ? { profile, project } : {}),
	}
	const requests: Record<string, unknown>[] = []
	const server = createServer((socket) => {
		let buffer = ''
		socket.on('data', (chunk) => {
			buffer += chunk.toString()
			if (!buffer.includes('\n')) return
			const request: Record<string, unknown> = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
			requests.push(request)
			const authenticated =
				request.nonce === instance.nonce && request.instanceId === instance.instanceId
			socket.end(
				JSON.stringify(
					authenticated
						? {
								ok: true,
								value: {
									...publicInstance(instance),
									serviceId: reportedServiceId,
									profile: reportedProfile,
									project: reportedProject,
								},
							}
						: { ok: false, error: { code: 'unauthorized', message: 'Wrong fixture identity' } },
				) + '\n',
			)
		})
	})
	await new Promise<void>((ready, reject) => {
		server.once('error', reject)
		server.listen(instance.socketPath, ready)
	})
	cleanup.push(
		() =>
			new Promise<void>((done, reject) => {
				server.close((error) => (error ? reject(error) : done()))
			}),
	)
	await writeFile(resolve(discovery, `${instance.instanceId}.json`), JSON.stringify(instance), {
		mode: 0o600,
	})
	return { instance, requests }
}

describe('development profiles', () => {
	it('infers a single profile from the nearest declaring package', async () => {
		const project = await workspace()
		expect(await resolveDevProject({ root: project.web })).toEqual({
			workspace: project.root,
			root: project.web,
			profile: 'app',
			pitchfork: 'server',
		})
	})

	it('requires explicit selection for multiple profiles without a default', async () => {
		const project = await workspace({
			admin: { root: 'web', command: 'vp dev' },
			api: { pitchfork: 'server' },
		})
		await expect(resolveDevProject({ root: project.root })).rejects.toMatchObject({
			code: 'invalid_project',
		})
		expect(await resolveDevProject({ root: project.root, profile: 'api' })).toEqual({
			workspace: project.root,
			root: project.root,
			profile: 'api',
			pitchfork: 'server',
		})
		await expect(
			resolveDevProject({ root: project.root, profile: 'missing' }),
		).rejects.toMatchObject({ code: 'invalid_project' })
	})

	it('uses explicit profile before default, and excludes default from profile candidates', async () => {
		const project = await workspace({
			default: 'app',
			app: { root: 'web', command: 'vp dev' },
			docs: { pitchfork: 'docs', console: false },
		})
		expect(await resolveDevProject({ root: project.root })).toMatchObject({
			profile: 'app',
			command: 'vp dev',
		})
		expect(await resolveDevProject({ root: project.root, profile: 'docs' })).toMatchObject({
			profile: 'docs',
			pitchfork: 'docs',
			console: false,
		})
		await expect(
			resolveDevProject({ root: project.root, profile: 'default' }),
		).rejects.toMatchObject({ code: 'invalid_project' })
	})

	it.each(['missing', '', ' app ', 1, null, { command: 'vp dev' }])(
		'rejects malformed default even with explicit profile (%j)',
		async (value) => {
			const project = await workspace({ default: value, app: { command: 'vp dev' } })
			for (const profile of [undefined, 'app']) {
				await expect(resolveDevProject({ root: project.root, profile })).rejects.toMatchObject({
					code: 'invalid_project',
				})
			}
		},
	)

	it.each([undefined, true])(
		'normalizes console-enabled profiles without redundant state (%j)',
		async (console) => {
			const project = await workspace({ app: { pitchfork: 'server', console } })
			expect(await resolveDevProject({ root: project.root })).toEqual({
				workspace: project.root,
				root: project.root,
				profile: 'app',
				pitchfork: 'server',
			})
		},
	)

	it('rejects console connection for a service-only profile before discovery or Pitchfork', async () => {
		const project = await workspace({ docs: { root: 'web', pitchfork: 'docs', console: false } })
		const console = await consoleInstance(project.web, 'fixture/docs')
		vi.stubEnv('PATH', '')
		await expect(connectDevProject({ root: project.root })).rejects.toMatchObject({
			code: 'unsupported_console',
		})
		expect(console.requests).toHaveLength(0)
	})

	it('defaults each profile root to its declaring package directory', async () => {
		const project = await workspace({ app: { command: 'vp dev' } })
		expect(await resolveDevProject({ root: project.web })).toEqual({
			workspace: project.root,
			root: project.root,
			profile: 'app',
			command: 'vp dev',
		})
	})

	it.each([
		{},
		{ app: { root: 'web' } },
		{ targets: { app: 'web' } },
		{ root: 'web', command: 'vp dev' },
		{ app: { command: 'vp dev', pitchfork: 'server' } },
		{ app: { command: 'vp dev', console: false } },
		{ app: { pitchfork: 'app', console: 'false' } },
		{ app: { pitchfork: 'app', console: 0 } },
		{ app: { pitchfork: 'app', console: null } },
		{ app: { root: '/absolute', command: 'vp dev' } },
		{ app: { root: '', command: 'vp dev' } },
		{ app: { root: 42, command: 'vp dev' } },
		{ app: { command: ' ' } },
		{ app: { command: 42 } },
		{ app: { pitchfork: '' } },
		{ app: { pitchfork: '../app' } },
		{ app: { pitchfork: 'namespace/app' } },
		{ app: { pitchfork: ' app ' } },
		{ 'bad/profile': { root: 'web', command: 'vp dev' } },
	])('rejects invalid declarations %#', async (config) => {
		const project = await workspace(config)
		await expect(resolveDevProject({ root: project.root })).rejects.toMatchObject({
			code: 'invalid_project',
		})
	})

	it('validates unselected profiles too', async () => {
		const project = await workspace({
			app: { root: 'web', command: 'vp dev' },
			broken: { command: 'vp dev', pitchfork: 'server' },
		})
		await expect(resolveDevProject({ root: project.root, profile: 'app' })).rejects.toMatchObject({
			code: 'invalid_project',
		})
	})

	it('falls back to the nearest package from cwd when no declaration exists', async () => {
		const project = await workspace()
		await writeFile(resolve(project.root, 'package.json'), '{}')
		await writeFile(resolve(project.web, 'package.json'), '{}')
		await mkdir(resolve(project.web, 'src'))
		vi.spyOn(process, 'cwd').mockReturnValue(resolve(project.web, 'src'))
		expect(await resolveDevProject({})).toEqual({ workspace: project.web, root: project.web })
	})

	it('keeps an explicit root exact without a declaration', async () => {
		const project = await workspace()
		await writeFile(resolve(project.root, 'package.json'), '{}')
		await mkdir(resolve(project.web, 'src'))
		const start = resolve(project.web, 'src')
		expect(await resolveDevProject({ root: start })).toEqual({
			workspace: project.root,
			root: start,
		})
		await expect(resolveDevProject({ root: start, profile: 'app' })).rejects.toMatchObject({
			code: 'invalid_project',
		})
	})

	it.each(['.git', 'pnpm-workspace.yaml'])(
		'does not inherit a declaration across %s',
		async (boundary) => {
			const project = await workspace()
			const nested = resolve(project.root, 'separate-repository')
			const start = resolve(nested, 'src')
			await mkdir(start, { recursive: true })
			await writeFile(
				resolve(nested, boundary),
				boundary === '.git' ? 'gitdir: elsewhere\n' : 'packages: []\n',
			)
			expect(await resolveDevProject({ root: start })).toEqual({ workspace: start, root: start })
		},
	)

	it.each(['relative', 'symlink'])(
		'rejects a root escaping its declaration through %s',
		async (escape) => {
			const project = await workspace({
				app: { command: 'vp dev', root: escape === 'relative' ? '../outside' : 'linked' },
			})
			const outside = resolve(project.directory, 'outside')
			await mkdir(outside)
			if (escape === 'symlink') await symlink(outside, resolve(project.root, 'linked'))
			await expect(resolveDevProject({ root: project.root })).rejects.toMatchObject({
				code: 'invalid_project',
			})
		},
	)

	it('retains service binding when an instance is explicitly selected', async () => {
		const project = await workspace()
		expect(await resolveDevSelection({ root: project.web, instance: 'chosen' })).toMatchObject({
			root: project.web,
			instance: 'chosen',
			service: 'server',
			project: { workspace: project.root, profile: 'app', pitchfork: 'server' },
		})
	})
})

describe('local discovery with profile ownership', () => {
	it('finds the declared service without Pitchfork on PATH or matching profile/service names', async () => {
		const project = await workspace()
		const console = await consoleInstance(project.web, 'fixture/server')
		await consoleInstance(project.web, 'fixture/app')
		vi.stubEnv('PATH', '')
		expect(await connectDevProject({ root: project.root })).toEqual(console.instance)
		expect(console.requests.every((request) => request.method === 'inspect')).toBe(true)
	})

	it.each([undefined, 'fixture/app'])(
		'does not connect to an unrelated service (%s)',
		async (serviceId) => {
			const project = await workspace()
			const console = await consoleInstance(project.web, serviceId)
			vi.stubEnv('PATH', '')
			for (const instance of [undefined, console.instance.instanceId]) {
				await expect(connectDevProject({ root: project.root, instance })).rejects.toMatchObject({
					code: 'dev_unavailable',
				})
			}
		},
	)

	it('isolates command profiles that share a Vite root', async () => {
		const project = await workspace({
			first: { root: 'web', command: 'vp dev' },
			second: { root: 'web', command: 'vp dev' },
		})
		const first = await consoleInstance(
			project.web,
			undefined,
			undefined,
			'first',
			'first',
			project.root,
		)
		const second = await consoleInstance(
			project.web,
			undefined,
			undefined,
			'second',
			'second',
			project.root,
		)
		vi.stubEnv('PATH', '')
		expect(await connectDevProject({ root: project.root, profile: 'first' })).toEqual(
			first.instance,
		)
		expect(await connectDevProject({ root: project.root, profile: 'second' })).toEqual(
			second.instance,
		)
		await expect(
			connectDevProject({
				root: project.root,
				profile: 'first',
				instance: second.instance.instanceId,
			}),
		).rejects.toMatchObject({ code: 'dev_unavailable' })
	})

	it.each(['fixture/server', 'other-worktree/server'])(
		'requires instance selection when matching service consoles share a root (%s)',
		async (serviceId) => {
			const project = await workspace()
			vi.stubEnv('PATH', '')
			const first = await consoleInstance(project.web, 'fixture/server')
			const second = await consoleInstance(project.web, serviceId)
			await expect(connectDevProject({ root: project.root })).rejects.toMatchObject({
				code: 'ambiguous_instance',
				candidates: expect.arrayContaining([
					expect.objectContaining({ instanceId: first.instance.instanceId }),
					expect.objectContaining({ instanceId: second.instance.instanceId }),
				]),
			})
			expect(
				await connectDevProject({ root: project.root, instance: second.instance.instanceId }),
			).toEqual(second.instance)
		},
	)

	it('requires the handshake to confirm discovery service identity', async () => {
		const project = await workspace()
		await consoleInstance(project.web, 'fixture/server', 'another-worktree/server')
		await expect(connectDevProject({ root: project.root })).rejects.toMatchObject({
			code: 'protocol_mismatch',
		})
	})

	it('requires the handshake to confirm discovery profile identity', async () => {
		const project = await workspace({ app: { root: 'web', command: 'vp dev' } })
		await consoleInstance(project.web, undefined, undefined, 'app', 'other', project.root)
		await expect(connectDevProject({ root: project.root })).rejects.toMatchObject({
			code: 'protocol_mismatch',
		})
	})

	it('starts the resolved full service ID in its declaring package', async () => {
		const project = await workspace()
		const calls = await pitchfork(project.directory)
		const config = await resolveDevProject({ root: project.web })
		const service = await readDevService(config)
		expect(await startDevService(config, service)).toBe(0)
		expect(await calls()).toEqual([
			{ args: ['status', 'server', '--json'], cwd: project.root },
			{ args: ['start', 'fixture/server', '--quiet'], cwd: project.root },
		])
	})

	it('rejects Pitchfork output identifying another daemon', async () => {
		const project = await workspace()
		await pitchfork(project.directory)
		vi.stubEnv(
			'PLUXEL_TEST_PITCHFORK_STATUS',
			JSON.stringify({ id: 'fixture/other', status: 'running' }),
		)
		const config = await resolveDevProject({ root: project.root })
		await expect(readDevService(config)).rejects.toMatchObject({ code: 'invalid_project' })
	})
})

it('isolates nested and outer declarations with the same profile name and Vite root', async () => {
	const project = await workspace({ app: { root: 'web', command: 'vp dev web' } })
	await writeFile(
		resolve(project.web, 'package.json'),
		JSON.stringify({ pluxel: { dev: { app: { command: 'vp dev' } } } }),
	)
	const outer = await consoleInstance(project.web, undefined, undefined, 'app', 'app', project.root)
	const inner = await consoleInstance(project.web, undefined, undefined, 'app', 'app', project.web)
	vi.stubEnv('PATH', '')
	expect(await connectDevProject({ root: project.root })).toEqual(outer.instance)
	expect(await connectDevProject({ root: project.web })).toEqual(inner.instance)
	await expect(
		connectDevProject({ root: project.root, instance: inner.instance.instanceId }),
	).rejects.toMatchObject({ code: 'dev_unavailable' })
	await expect(
		connectDevProject({ root: project.web, instance: outer.instance.instanceId }),
	).rejects.toMatchObject({ code: 'dev_unavailable' })
})

it('requires the handshake to confirm the declaring project directory', async () => {
	const project = await workspace({ app: { root: 'web', command: 'vp dev' } })
	await consoleInstance(project.web, undefined, undefined, 'app', 'app', project.root, project.web)
	await expect(connectDevProject({ root: project.root })).rejects.toMatchObject({
		code: 'protocol_mismatch',
	})
})
