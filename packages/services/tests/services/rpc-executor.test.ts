import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defineCommand, Result } from '@pluxel/commands'
import { obj, Type } from '@pluxel/commands/typebox'
import type { Context } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { describe, expect, it } from 'vitest'
import { createRpcExecutor } from '../../src/rpc/executor'
import { RpcKernel, type RpcBuildPublication } from '../../src/rpc/kernel'

const execFile = promisify(execFileCallback)

@Plugin({ displayName: 'RPC executor publisher' })
class RpcExecutorOwner extends BasePlugin {
	get owner(): Context {
		return this.ctx
	}
}

describe('isolated RPC executor', () => {
	it.skipIf(!process.env.RPC_SANDBOX_IMAGE)(
		'limits real Podman runs across independent host processes',
		async () => {
			const script = `
(async () => {
const { createRpcExecutor } = await import('./src/rpc/executor.ts')
const executor = await createRpcExecutor({
  image: ${JSON.stringify(process.env.RPC_SANDBOX_IMAGE!)},
  compilerPath: ${JSON.stringify(fileURLToPath(new URL('../../../../node_modules/.bin/tsc', import.meta.url)))},
  capnwebPath: ${JSON.stringify(fileURLToPath(new URL('../../node_modules/capnweb/dist/index.js', import.meta.url)))},
})
const closed = new AbortController()
const session = {
  principal: { userId: 'quota-test' }, closedSignal: closed.signal,
  isDescriptionCurrent: () => true, trackBorrowedRun() {},
}
console.log('READY')
process.stdin.once('data', async () => {
  try {
    const result = await executor.run({ session, contracts: [], code: 'for (;;) {}' })
    console.log(JSON.stringify({ code: result.isErr() ? result.error.code : 'OK', cause: result.isErr() ? result.error.cause?.stderr ?? String(result.error.cause) : '' }))
    await executor.close()
  } catch (error) {
    console.log(JSON.stringify({ code: 'ERROR', message: String(error) }))
  }
})
})().catch((error) => { console.error(error); process.exitCode = 1 })
`
			const recoveryRoot = join(tmpdir(), 'pxrpc')
			const stagingDirectory = join(recoveryRoot, `.o-${randomBytes(6).toString('hex')}.staging`)
			await mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
			await mkdir(stagingDirectory, { mode: 0o700 })
			await writeFile(join(stagingDirectory, 'owner.json'), '{', { mode: 0o600 })
			const children: Array<{
				child: ReturnType<typeof spawn>
				lines: ReturnType<typeof createInterface>
				ready: Promise<unknown[]>
				exit: Promise<unknown[]>
				stderr: string
			}> = []
			const start = () => {
				const child = spawn(
					fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url)),
					['--conditions=@pluxel/source', '-e', script],
					{
						cwd: fileURLToPath(new URL('../../', import.meta.url)),
						stdio: ['pipe', 'pipe', 'pipe'],
					},
				)
				const lines = createInterface({ input: child.stdout! })
				let stderr = ''
				child.stderr!.on('data', (chunk) => (stderr += String(chunk)))
				return {
					child,
					lines,
					ready: once(lines, 'line'),
					exit: once(child, 'exit'),
					get stderr() {
						return stderr
					},
				}
			}
			try {
				for (let index = 0; index < 3; index++) {
					const child = start()
					children.push(child)
					const [readyLine] = await Promise.race([
						child.ready,
						child.exit.then(() => {
							throw new Error(child.stderr)
						}),
					])
					expect(readyLine).toBe('READY')
				}
				await expect(access(stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
				const results = children.map(({ lines }) => once(lines, 'line'))
				children[0].child.stdin!.write('go\n')
				children[1].child.stdin!.write('go\n')
				let reserved = 0
				for (let attempt = 0; attempt < 100; attempt++) {
					reserved = 0
					for (const name of await readdir(recoveryRoot)) {
						if (!name.startsWith('o-')) continue
						const owner = JSON.parse(await readFile(join(recoveryRoot, name, 'owner.json'), 'utf8'))
						if (typeof owner.pid !== 'number') continue
						const entries = await readdir(join(recoveryRoot, name))
						reserved += entries.filter((entry) => entry.startsWith('r-')).length
					}
					if (reserved === 2) break
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
				expect(reserved).toBe(2)
				children[2].child.stdin!.write('go\n')
				const [thirdLine] = await results[2]
				expect(JSON.parse(String(thirdLine)).code).toBe('RUN_LIMIT')
				const first = await Promise.all(results.slice(0, 2))
				expect(
					first.map(([line]) => JSON.parse(String(line)).code),
					JSON.stringify(first),
				).toEqual(['RUN_LIMIT', 'RUN_LIMIT'])
			} finally {
				for (const { child } of children) {
					if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
				}
				await Promise.all(children.map(({ exit }) => exit.catch(() => {})))
				await rm(stagingDirectory, { recursive: true, force: true })
			}
		},
		45_000,
	)

	it.skipIf(!process.env.RPC_SANDBOX_IMAGE)(
		'preserves a live owner and reclaims its running container after a host crash',
		async () => {
			const script = `
const { execFileSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const root = join(tmpdir(), 'pxrpc')
const ownerNonce = randomBytes(16).toString('hex')
const runNonce = randomBytes(16).toString('hex')
const ownerDirectory = join(root, 'o-' + ownerNonce.slice(0, 12))
const runDirectory = join(ownerDirectory, 'r-' + runNonce.slice(0, 12))
const name = 'pluxel-rpc-run-' + runNonce
const image = ${JSON.stringify(process.env.RPC_SANDBOX_IMAGE!)}
mkdirSync(root, { recursive: true, mode: 0o700 })
mkdirSync(ownerDirectory, { mode: 0o700 })
mkdirSync(runDirectory, { mode: 0o700 })
mkdirSync(join(runDirectory, 's'))
mkdirSync(join(runDirectory, 'out'))
const stat = readFileSync('/proc/self/stat', 'utf8')
const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]
const store = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .Store}}'], { encoding: 'utf8' }))
writeFileSync(join(ownerDirectory, 'owner.json'), JSON.stringify({
  bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  pid: process.pid, startTime, nonce: ownerNonce,
  graphRoot: store.graphRoot, runRoot: store.runRoot,
}))
writeFileSync(join(runDirectory, 'run.json'), JSON.stringify({ nonce: runNonce, name, image }))
writeFileSync(join(runDirectory, 'launch.lock'), '')
execFileSync('docker', ['run', '-d', '--pull=never', '--name', name,
  '--label', 'io.pluxel.rpc.owner=' + ownerNonce,
  '--label', 'io.pluxel.rpc.run=' + runNonce,
  '--timeout=20',
  '--mount', 'type=bind,source=' + join(runDirectory, 's') + ',destination=/rpc,readonly=true',
  '--mount', 'type=bind,source=' + join(runDirectory, 'out') + ',destination=/program,readonly=true',
  image, 'node', '-e', 'setTimeout(() => {}, 15000)'])
console.log(JSON.stringify({ ownerDirectory, name }))
setInterval(() => {}, 1000)
`
			const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
			let owned: { ownerDirectory: string; name: string } | undefined
			try {
				const [ready] = await once(child.stdout!, 'data')
				owned = JSON.parse(String(ready))
				const options = {
					image: process.env.RPC_SANDBOX_IMAGE!,
					compilerPath: fileURLToPath(
						new URL('../../../../node_modules/.bin/tsc', import.meta.url),
					),
					capnwebPath: fileURLToPath(
						new URL('../../node_modules/capnweb/dist/index.js', import.meta.url),
					),
				}
				const whileLive = await createRpcExecutor(options)
				await whileLive.close()
				await access(owned.ownerDirectory)
				await execFile('docker', ['container', 'exists', owned.name])
				const running = await execFile('docker', [
					'container',
					'inspect',
					owned.name,
					'--format',
					'{{.State.Running}}',
				])
				expect(running.stdout.trim()).toBe('true')
				child.kill('SIGKILL')
				await once(child, 'exit')
				const afterCrash = await createRpcExecutor(options)
				await afterCrash.close()
				await expect(access(owned.ownerDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
				await expect(execFile('docker', ['container', 'exists', owned.name])).rejects.toMatchObject(
					{ code: 1 },
				)
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill('SIGKILL')
					await once(child, 'exit')
				}
				if (owned) {
					await execFile('docker', ['rm', '-f', owned.name]).catch(() => {})
					await rm(owned.ownerDirectory, { recursive: true, force: true })
				}
			}
		},
		30_000,
	)

	it('rejects a backend that reports support but does not enforce memory limits', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'pluxel-rpc-backend-test-'))
		try {
			const cliPath = join(directory, 'podman')
			const info = JSON.stringify({
				os: 'linux',
				arch: 'amd64',
				security: { rootless: true, seccompEnabled: true },
				cgroupVersion: 'v2',
				ociRuntime: { name: 'crun' },
			})
			const probe = JSON.stringify({
				node: 'v24.20.0',
				uid: 1001,
				gid: 1001,
				memory: 'max',
				pids: '16',
				cpu: '50000 100000',
				tmpType: 16_914_836,
				tmpBytes: 8 * 1_048_576,
				privateFile: 'private-probe',
				rootReadOnly: true,
				routes: 0,
				capEff: '0000000000000000',
				noNewPrivs: '1',
				seccomp: '2',
			})
			await writeFile(
				cliPath,
				`#!/usr/bin/env node
switch (process.argv[2]) {
  case 'info': console.log(${JSON.stringify(info)}); break
  case '--version': console.log('podman version 5.8.6'); break
  case 'image': console.log('${'a'.repeat(64)}'); break
  case 'run': console.log(${JSON.stringify(probe)}); break
  default: process.exitCode = 1
}
`,
				{ mode: 0o755 },
			)
			await expect(
				createRpcExecutor({
					image: 'a'.repeat(64),
					compilerPath: 'tsc',
					capnwebPath: 'capnweb',
					dockerPath: cliPath,
				}),
			).rejects.toThrow('RPC isolation backend did not enforce required limits')
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it.skipIf(!process.env.RPC_SANDBOX_IMAGE)(
		'compiles a session description and executes a real Command through the HTTP carrier',
		async () => {
			await using host = await createServiceInternalTestHarness({ workbench: false })
			host.add(RpcExecutorOwner).start(RpcExecutorOwner)
			await host.commit()
			const held = Promise.withResolvers<void>()
			const holdStarted = Promise.withResolvers<void>()
			const command = defineCommand({
				name: 'text.echo',
				description: 'Echo text.',
				input: obj({ text: Type.String() }),
				async execute({ text }) {
					if (text === 'slow') await new Promise((resolve) => setTimeout(resolve, 1_000))
					if (text === 'hold') {
						holdStarted.resolve()
						await held.promise
					}
					return Result.ok({ text })
				},
			})
			const bindings = { echo: command }
			const artifact: RpcBuildPublication['artifact'] = {
				format: 'pluxel-rpc-artifact-v1',
				integrity: '1'.repeat(64),
				contract: { id: 'text', hash: '2'.repeat(64) },
				methods: [
					{
						method: 'echo',
						command: command.name,
						description: command.descriptor.description,
						inputSchema: command.descriptor.inputSchema,
					},
				],
				types: [{ method: 'echo', input: '{ text: string }', success: '{ text: string }' }],
				declaration: `export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };\nexport interface RpcApi { echo(input: { text: string }): Promise<RpcResult<{ text: string }>> }\nexport interface RpcClient { open(id: 'text'): RpcApi }`,
			}
			const trusted = new WeakMap<object, RpcBuildPublication['bindings']>([[artifact, bindings]])
			const kernel = new RpcKernel(host.ctx, {
				verifyArtifact: (candidate) => trusted.get(candidate),
			})
			const publication = kernel.publish(host.require(RpcExecutorOwner).owner, {
				api: { id: 'text', commands: bindings },
				bindings,
				artifact,
			})
			const session = kernel.createSession({
				principal: { userId: 'alice' },
				access: [publication.contract],
			})
			const contracts = await session.describe({ apis: ['text'] })
			const executor = await createRpcExecutor({
				image: process.env.RPC_SANDBOX_IMAGE!,
				compilerPath: fileURLToPath(new URL('../../../../node_modules/.bin/tsc', import.meta.url)),
				capnwebPath: fileURLToPath(
					new URL('../../node_modules/capnweb/dist/index.js', import.meta.url),
				),
			})
			try {
				const result = await executor.run({
					session,
					contracts,
					code: `const text = rpc.open('text'); const first = await text.echo({ text: 'hello' }); if (!first.ok) return first; return await text.echo({ text: first.value.text + ' world' })`,
				})
				expect(result.isOk()).toBe(true)
				expect(result.isOk() ? result.value : undefined).toEqual({
					ok: true,
					value: { text: 'hello world' },
				})
				const swallowedTransport = await executor.run({
					session,
					contracts,
					code: `try { await rpc.open('text').echo({ text: 'x'.repeat(2_000) }) } catch {} return 'swallowed'`,
				})
				expect(swallowedTransport.isErr() ? swallowedTransport.error.code : undefined).toBe(
					'RUN_TRANSPORT',
				)
				expect(swallowedTransport.isErr() ? swallowedTransport.error.calls : []).toEqual([
					expect.objectContaining({ outcome: 'unknown' }),
				])
				const swallowedLimit = await executor.run({
					session,
					contracts,
					code: `const echo = rpc.open('text').echo; for (let index = 0; index < 5; index++) { try { await echo({ text: 'ok' }) } catch {} } return 'swallowed'`,
				})
				expect(swallowedLimit.isErr() ? swallowedLimit.error.code : undefined).toBe('RUN_LIMIT')
				expect(swallowedLimit.isErr() ? swallowedLimit.error.calls : []).toHaveLength(5)
				expect(swallowedLimit.isErr() ? swallowedLimit.error.calls[4]?.outcome : undefined).toBe(
					'unknown',
				)
				const privateMounts = await executor.run({
					session,
					contracts,
					code: `const fs: any = (rpc as any).constructor.constructor('return require')()('node:fs'); return { programMode: fs.statSync('/program').mode & 511, socketMode: fs.statSync('/rpc').mode & 511, socketFileMode: fs.statSync('/rpc/gateway.sock').mode & 511 }`,
				})
				expect(privateMounts.isOk() ? privateMounts.value : undefined).toEqual({
					programMode: 0o700,
					socketMode: 0o700,
					socketFileMode: 0o600,
				})
				const wrapperDirectory = await mkdtemp(join(tmpdir(), 'pluxel-rpc-launch-test-'))
				try {
					const wrapper = join(wrapperDirectory, 'docker')
					const createdId = join(wrapperDirectory, 'created-id')
					await writeFile(
						wrapper,
						`#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const result = spawnSync('docker', args, { encoding: 'utf8' })
if (args[0] === 'run' && args[1] === '-d' && result.status === 0) {
  writeFileSync(${JSON.stringify(createdId)}, result.stdout.trim())
  process.exit(42)
}
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
process.exit(result.status ?? 1)
`,
						{ mode: 0o755 },
					)
					const failedLaunchExecutor = await createRpcExecutor({
						image: process.env.RPC_SANDBOX_IMAGE!,
						compilerPath: fileURLToPath(
							new URL('../../../../node_modules/.bin/tsc', import.meta.url),
						),
						capnwebPath: fileURLToPath(
							new URL('../../node_modules/capnweb/dist/index.js', import.meta.url),
						),
						dockerPath: wrapper,
					})
					const failedLaunch = await failedLaunchExecutor.run({
						session,
						contracts,
						code: 'return null',
					})
					expect(failedLaunch.isErr() ? failedLaunch.error.code : undefined).toBe('INTERNAL')
					await failedLaunchExecutor.close()
					const id = await readFile(createdId, 'utf8')
					await expect(execFile('docker', ['container', 'exists', id])).rejects.toMatchObject({
						code: 1,
					})
				} finally {
					await rm(wrapperDirectory, { recursive: true, force: true })
				}
				const waitFailureDirectory = await mkdtemp(join(tmpdir(), 'pluxel-rpc-wait-test-'))
				try {
					const wrapper = join(waitFailureDirectory, 'docker')
					await writeFile(
						wrapper,
						`#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const result = spawnSync('docker', args, { encoding: 'utf8' })
if (args[0] === 'wait' && result.status === 0) process.exit(42)
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
process.exit(result.status ?? 1)
`,
						{ mode: 0o755 },
					)
					const failedWaitExecutor = await createRpcExecutor({
						image: process.env.RPC_SANDBOX_IMAGE!,
						compilerPath: fileURLToPath(
							new URL('../../../../node_modules/.bin/tsc', import.meta.url),
						),
						capnwebPath: fileURLToPath(
							new URL('../../node_modules/capnweb/dist/index.js', import.meta.url),
						),
						dockerPath: wrapper,
					})
					try {
						const failedWait = await failedWaitExecutor.run({
							session,
							contracts,
							code: "return await rpc.open('text').echo({ text: 'recorded' })",
						})
						expect(failedWait.isErr() ? failedWait.error.code : undefined).toBe('INTERNAL')
						expect(failedWait.isErr() ? failedWait.error.calls : []).toEqual([
							expect.objectContaining({ outcome: 'unknown' }),
						])
					} finally {
						await failedWaitExecutor.close()
					}
				} finally {
					await rm(waitFailureDirectory, { recursive: true, force: true })
				}
				const denied = await executor.run({
					session,
					contracts: [{ ...contracts[0]! }],
					code: 'return null',
				})
				expect(denied.isErr()).toBe(true)
				expect(denied.isErr() ? denied.error.code : undefined).toBe('CONTRACT_CHANGED')
				const expired = await executor.run({
					session,
					contracts,
					code: 'return null',
					deadlineMs: Date.now() - 1,
				})
				expect(expired.isErr() ? expired.error.code : undefined).toBe('TIMEOUT')
				const deadlineRun = await executor.run({
					session,
					contracts,
					code: 'for (;;) {}',
					deadlineMs: Date.now() + 1_500,
				})
				expect(deadlineRun.isErr() ? deadlineRun.error.code : undefined).toBe('TIMEOUT')
				expect(deadlineRun.isErr() ? deadlineRun.error.phase : undefined).toBe('execute')
				const failedPrepare = await executor.run({
					session,
					contracts,
					code: 'return null',
					deadlineMs: -1,
				})
				expect(failedPrepare.isErr() ? failedPrepare.error.code : undefined).toBe('INTERNAL')
				expect(failedPrepare.isErr() ? failedPrepare.error.phase : undefined).toBe('prepare')
				expect(failedPrepare.isErr() ? failedPrepare.error.cause : undefined).toBeInstanceOf(Error)
				const invalid = await executor.run({
					session,
					contracts,
					code: `return await rpc.open('text').echo({ text: 123 })`,
				})
				expect(invalid.isErr()).toBe(true)
				expect(invalid.isErr() ? invalid.error.code : undefined).toBe('CODE_TYPECHECK')
				expect(invalid.isErr() ? invalid.error.diagnostics?.[0]?.line : undefined).toBe(1)
				const invalidWire = await executor.run({
					session,
					contracts,
					code: `const echo = rpc.open('text').echo; let synchronous = false; let call: Promise<unknown> | undefined; try { call = echo({ text: undefined } as any) } catch { synchronous = true } return { synchronous, promiseTag: Object.prototype.toString.call(call), rejected: call ? await call.then(() => false, () => true) : false }`,
				})
				expect(invalidWire.isOk() ? invalidWire.value : undefined).toEqual({
					synchronous: false,
					promiseTag: '[object Promise]',
					rejected: true,
				})
				const externalImport = await executor.run({
					session,
					contracts,
					code: `return null
}
import type { Context } from '@pluxel/core'
async function filler(): Promise<Context | null> { return null`,
				})
				expect(externalImport.isErr() ? externalImport.error.code : undefined).toBe(
					'CODE_TYPECHECK',
				)
				expect(
					externalImport.isErr()
						? externalImport.error.diagnostics?.some((item) => item.code === 'TS2307')
						: false,
				).toBe(true)
				const badOutput = await executor.run({ session, contracts, code: 'return 1n' })
				expect(badOutput.isErr()).toBe(true)
				expect(badOutput.isErr() ? badOutput.error.code : undefined).toBe('OUTPUT_ENCODING')
				const hostFile = await executor.run({
					session,
					contracts,
					code: `const nodeRequire = (rpc as any).constructor.constructor('return require')(); try { nodeRequire('node:fs').readFileSync(${JSON.stringify(fileURLToPath(import.meta.url))}); return 'exposed' } catch { return 'blocked' }`,
				})
				expect(hostFile.isOk() ? hostFile.value : undefined).toBe('blocked')
				const network = await executor.run({
					session,
					contracts,
					code: `const nodeRequire = (rpc as any).constructor.constructor('return require')(); const net: any = nodeRequire('node:net'); return await new Promise<string>((resolve) => { const socket = net.connect(80, '1.1.1.1'); socket.once('connect', () => { socket.destroy(); resolve('connected') }); socket.once('error', () => resolve('blocked')) })`,
				})
				expect(network.isOk() ? network.value : undefined).toBe('blocked')
				const pending = await executor.run({
					session,
					contracts,
					code: `
void rpc.open('text').echo({ text: 'slow' })
const make = (rpc as any).constructor.constructor
const proc = make('return process')()
const timer = make('return setTimeout')()
const nodeRequire = make('return require')()
const http: any = nodeRequire('node:http')
await new Promise<void>((resolve) => timer(resolve, 50))
await new Promise<void>((resolve, reject) => {
	const request = http.request({
		socketPath: '/rpc/gateway.sock', path: '/result', method: 'POST',
		headers: {
			authorization: 'Bearer ' + proc.env.RPC_TOKEN,
			'x-run-id': proc.env.RPC_RUN_ID,
			'x-session-id': proc.env.RPC_SESSION_ID,
		},
	}, (response: any) => {
		response.resume()
		response.on('end', () => response.statusCode === 204 ? resolve() : reject(Error('result rejected')))
	})
	request.on('error', reject)
	request.end(JSON.stringify({ kind: 'result', value: 'forged' }))
})
proc.exit(0)
return null
`,
				})
				expect(pending.isErr() ? pending.error.code : undefined).toBe('RUN_PENDING_CALLS')
				expect(pending.isErr() ? pending.error.calls.length : 0).toBe(1)
				expect(
					pending.isErr() ? pending.error.calls.every((call) => call.outcome === 'unknown') : false,
				).toBe(true)
				const anotherExecutor = await createRpcExecutor({
					image: process.env.RPC_SANDBOX_IMAGE!,
					compilerPath: fileURLToPath(
						new URL('../../../../node_modules/.bin/tsc', import.meta.url),
					),
					capnwebPath: fileURLToPath(
						new URL('../../node_modules/capnweb/dist/index.js', import.meta.url),
					),
				})
				try {
					const limitAbort = new AbortController()
					const first = executor.run({
						session,
						contracts,
						code: 'return null',
						signal: limitAbort.signal,
					})
					const second = executor.run({
						session,
						contracts,
						code: 'return null',
						signal: limitAbort.signal,
					})
					const overflow = await anotherExecutor.run({ session, contracts, code: 'return null' })
					expect(overflow.isErr() ? overflow.error.code : undefined).toBe('RUN_LIMIT')
					limitAbort.abort()
					await Promise.all([first, second])
				} finally {
					await anotherExecutor.close()
				}
				const drainingExecutor = await createRpcExecutor({
					image: process.env.RPC_SANDBOX_IMAGE!,
					compilerPath: fileURLToPath(
						new URL('../../../../node_modules/.bin/tsc', import.meta.url),
					),
					capnwebPath: fileURLToPath(
						new URL('../../node_modules/capnweb/dist/index.js', import.meta.url),
					),
					budgets: { drainMs: 100 },
				})
				const runAbort = new AbortController()
				const heldRun = drainingExecutor.run({
					session,
					contracts,
					code: "return await rpc.open('text').echo({ text: 'hold' })",
					signal: runAbort.signal,
				})
				await holdStarted.promise
				runAbort.abort()
				const drained = await heldRun
				expect(drained.isErr() ? drained.error.code : undefined).toBe('RUN_TRANSPORT')
				const drainingClose = drainingExecutor.close()
				let closeFinished = false
				void drainingClose
					.finally(() => {
						closeFinished = true
					})
					.catch(() => {})
				try {
					await new Promise((resolve) => setTimeout(resolve, 50))
					expect(closeFinished).toBe(false)
				} finally {
					held.resolve()
				}
				await expect(drainingClose).rejects.toThrow('RPC executor cleanup failed')
				const runaway = executor.run({ session, contracts, code: 'for (;;) {}' })
				await new Promise<void>((resolve) => setTimeout(resolve, 1_200))
				const closing = session.close()
				const cancelled = await runaway
				expect(cancelled.isErr()).toBe(true)
				expect(cancelled.isErr() ? cancelled.error.code : undefined).toBe('ABORTED')
				await closing
			} finally {
				await executor.close()
				await session.close()
			}
		},
		45_000,
	)
})
