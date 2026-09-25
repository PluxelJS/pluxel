import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))

export const defaultBudgets = Object.freeze({
	wallMs: 2500,
	memoryMiB: 64,
	pids: 16,
	cpus: 0.5,
	tmpMiB: 8,
	maxRpcCalls: 4,
	maxConcurrentRpc: 2,
	maxRpcBytes: 1024,
	drainMs: 2000,
})

async function docker(args) {
	const result = await execFile('docker', args, {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024,
		timeout: 10_000,
	})
	return result.stdout.trim()
}

export async function verifyBackend(image) {
	if (!image) throw new Error('Set RPC_SANDBOX_IMAGE to a locally trusted Node 24 image')
	const host = JSON.parse(await docker(['info', '--format', '{{json .Host}}']))
	assert.equal(host.security?.rootless, true, 'Podman must be rootless')
	assert.equal(host.security?.seccompEnabled, true, 'Podman seccomp must be enabled')
	assert.equal(host.cgroupVersion, 'v2', 'cgroup v2 is required')
	assert.equal(host.ociRuntime?.name, 'crun', 'This experiment is verified with crun')
	const version = await docker(['--version'])
	assert.match(version, /^podman version 5\.8\.6$/, 'This experiment pins Podman 5.8.6')
	await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
	return { version, rootless: true, seccomp: true, cgroup: 'v2', oci: 'crun' }
}

function validateBudgets(budgets) {
	for (const key of [
		'wallMs',
		'memoryMiB',
		'pids',
		'tmpMiB',
		'maxRpcCalls',
		'maxConcurrentRpc',
		'maxRpcBytes',
		'drainMs',
	]) {
		if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 1)
			throw new Error(`Invalid ${key} budget`)
	}
	if (!Number.isFinite(budgets.cpus) || budgets.cpus <= 0 || budgets.cpus > 1)
		throw new Error('Invalid cpus budget')
	if (budgets.maxConcurrentRpc > budgets.maxRpcCalls)
		throw new Error('Concurrent RPC budget exceeds total RPC budget')
}

async function createGateway(directory, token, budgets, onInvoke) {
	const socket = join(directory, 'gateway.sock')
	let resolveFirstAdmission
	const firstAdmission = new Promise((resolve) => {
		resolveFirstAdmission = resolve
	})
	const active = new Set()
	const callIds = new Set()
	let admitted = 0
	let settled = 0
	let rejected = 0
	let peakActive = 0
	const reject = (response, status, message) => {
		rejected++
		response
			.writeHead(status, { 'content-type': 'application/json' })
			.end(JSON.stringify({ message }))
	}
	const server = createServer(async (request, response) => {
		try {
			if (
				request.method !== 'POST' ||
				request.url !== '/invoke' ||
				request.headers['x-run-token'] !== token
			) {
				reject(response, 403, 'Forbidden')
				return
			}
			const chunks = []
			let size = 0
			for await (const chunk of request) {
				size += chunk.length
				if (size > budgets.maxRpcBytes) {
					reject(response, 413, 'RPC payload budget exceeded')
					return
				}
				chunks.push(chunk)
			}
			let payload
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			} catch {
				reject(response, 400, 'Invalid JSON')
				return
			}
			if (typeof payload?.callId !== 'string' || callIds.has(payload.callId)) {
				reject(response, 400, 'Invalid or duplicate call ID')
				return
			}
			if (admitted >= budgets.maxRpcCalls) {
				reject(response, 429, 'RPC call budget exceeded')
				return
			}
			if (active.size >= budgets.maxConcurrentRpc) {
				reject(response, 429, 'Concurrent RPC budget exceeded')
				return
			}
			callIds.add(payload.callId)
			admitted++
			let work
			work = (async () => {
				try {
					const value = await Promise.resolve().then(() => onInvoke(payload.input))
					if (!response.destroyed)
						response
							.writeHead(200, { 'content-type': 'application/json' })
							.end(JSON.stringify(value))
				} catch (error) {
					if (!response.destroyed)
						response.writeHead(500, { 'content-type': 'application/json' }).end(
							JSON.stringify({
								message: error instanceof Error ? error.message : 'RPC handler failed',
							}),
						)
				} finally {
					settled++
					active.delete(work)
				}
			})()
			active.add(work)
			peakActive = Math.max(peakActive, active.size)
			resolveFirstAdmission()
		} catch (error) {
			if (!response.destroyed)
				reject(response, 400, error instanceof Error ? error.message : 'Bad request')
		}
	})
	server.maxConnections = budgets.maxConcurrentRpc + 4
	server.requestTimeout = 1000
	server.timeout = 1000
	server.keepAliveTimeout = 1000
	await new Promise((resolve, rejectListen) =>
		server.listen(socket, (error) => (error ? rejectListen(error) : resolve())),
	)
	await chmod(socket, 0o666)
	return {
		firstAdmission,
		get stats() {
			return { admitted, settled, rejected, active: active.size, peakActive }
		},
		async drain() {
			let timer
			try {
				await Promise.race([
					(async () => {
						while (active.size > 0) await Promise.allSettled(active)
					})(),
					new Promise((_, rejectDrain) => {
						timer = setTimeout(
							() => rejectDrain(new Error('Admitted RPC work did not drain within budget')),
							budgets.drainMs,
						)
					}),
				])
				assert.equal(active.size, 0)
				assert.equal(settled, admitted)
			} finally {
				clearTimeout(timer)
			}
		},
		async close() {
			server.closeAllConnections()
			await new Promise((resolve) => server.close(resolve))
		},
	}
}

export async function executeSandboxedRun({
	code,
	image,
	budgets: overrides = {},
	onInvoke,
	onStarted,
}) {
	if (typeof code !== 'string' || typeof onInvoke !== 'function')
		throw new Error('Code and onInvoke are required')
	const budgets = { ...defaultBudgets, ...overrides }
	validateBudgets(budgets)
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-rpc-sandbox-'))
	const containerName = `pluxel-rpc-sandbox-${process.pid}-${randomBytes(6).toString('hex')}`
	let gateway
	let timer
	let killReason
	try {
		const socketDirectory = join(directory, 'socket')
		await mkdir(socketDirectory)
		await chmod(directory, 0o755)
		await chmod(socketDirectory, 0o777)
		const canary = join(directory, 'host-canary.txt')
		await writeFile(canary, 'host-only')
		const token = randomBytes(32).toString('hex')
		gateway = await createGateway(socketDirectory, token, budgets, onInvoke)
		const guest = await readFile(join(here, 'guest.cjs'), 'utf8')
		const args = [
			'run',
			'-d',
			'--pull=never',
			'--name',
			containerName,
			'--network=none',
			'--pid=private',
			'--ipc=private',
			'--uts=private',
			'--read-only',
			'--tmpfs',
			`/tmp:rw,noexec,nosuid,size=${budgets.tmpMiB}m`,
			`--memory=${budgets.memoryMiB}m`,
			`--memory-swap=${budgets.memoryMiB}m`,
			`--pids-limit=${budgets.pids}`,
			`--cpus=${budgets.cpus}`,
			'--security-opt=no-new-privileges',
			'--cap-drop=ALL',
			'--user=1001:1001',
			'--mount',
			`type=bind,source=${socketDirectory},destination=/rpc,readonly=true`,
			'--env',
			`RPC_PROGRAM=${Buffer.from(code).toString('base64')}`,
			'--env',
			`RPC_TOKEN=${token}`,
			'--env',
			`RPC_HOST_CANARY=${canary}`,
			'--env',
			`RPC_HOST_PID=${process.pid}`,
			image,
			'node',
			'-e',
			guest,
		]
		const start = Date.now()
		const container = await docker(args)
		const stop = async (reason = 'manual') => {
			if (killReason) return
			killReason = reason
			await docker(['kill', container]).catch(() => {})
		}
		timer = setTimeout(
			() => {
				void stop('wall-time')
			},
			Math.max(0, budgets.wallMs - (Date.now() - start)),
		)
		const waiting = docker(['wait', container]).then(Number)
		void waiting.catch(() => {})
		if (onStarted) await onStarted({ firstAdmission: gateway.firstAdmission, stop })
		const exitCode = await waiting
		clearTimeout(timer)
		const activeAtExit = gateway.stats.active
		const drainStart = Date.now()
		await gateway.drain()
		const drainMs = Date.now() - drainStart
		const logs = await docker(['logs', '--tail=50', container]).catch(() => '')
		const resultLine = logs.split('\n').find((line) => line.startsWith('RPC_RESULT:'))
		return {
			exitCode,
			killReason: killReason ?? null,
			budgets,
			...gateway.stats,
			activeAtExit,
			drainMs,
			result: resultLine ? JSON.parse(resultLine.slice('RPC_RESULT:'.length)) : undefined,
			logs,
		}
	} finally {
		clearTimeout(timer)
		await docker(['rm', '-f', containerName]).catch(() => {})
		try {
			if (gateway) await gateway.drain()
		} finally {
			try {
				if (gateway) await gateway.close()
			} finally {
				await rm(directory, { recursive: true, force: true })
			}
		}
	}
}
