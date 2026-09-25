import { execFile as execFileCallback, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Result } from '@pluxel/commands'
import { JsonWireError, copyJson } from '../internal/json-wire'
import { createRpcHttpCarrier } from './http'
import type { RpcDescription, RpcKernelSession } from './kernel'

const execFile = promisify(execFileCallback)
const guestPath = fileURLToPath(new URL('./guest.cjs', import.meta.url))
const maxProcessRuns = 2
let activeProcessRuns = 0
const recoveryDirectoryName = 'pxrpc'
const ownerFile = 'owner.json'
const runFile = 'run.json'
const runLock = 'launch.lock'
const admissionLock = 'admission.lock'

async function withAdmissionLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	// The pipe closes on host death, so flock cannot strand the admission lock.
	const child = spawn(
		'flock',
		['-w', '10', '-x', path, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
		{
			stdio: ['pipe', 'pipe', 'pipe'],
		},
	)
	const exited = new Promise<number>((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', (code) => resolve(code ?? -1))
	})
	void exited.catch(() => {})
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			new Promise<void>((resolve, reject) => {
				child.stdout!.once('data', (data: Buffer) => {
					if (data.toString() === 'ready\n') resolve()
					else reject(new Error('RPC admission lock handshake failed'))
				})
				child.once('error', reject)
				child.once('exit', () => reject(new Error('RPC admission lock could not be acquired')))
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('RPC admission lock timed out')), 12_000)
			}),
		])
		clearTimeout(timer)
		const result = await work()
		child.stdin!.end()
		if ((await exited) !== 0) throw new Error('RPC admission lock exited unexpectedly')
		return result
	} finally {
		clearTimeout(timer)
		child.stdin?.end()
		if (child.exitCode === null && child.signalCode === null) child.kill()
		await exited.catch(() => {})
	}
}

type OwnerRecord = Readonly<{
	bootId: string
	pid: number
	startTime: string
	nonce: string
	graphRoot: string
	runRoot: string
}>
type RunRecord = Readonly<{ nonce: string; name: string; image: string }>

function processStartTime(status: string): string {
	const closing = status.lastIndexOf(')')
	const fields = status
		.slice(closing + 2)
		.trim()
		.split(/\s+/)
	const startTime = fields[19]
	if (closing < 0 || !startTime || !/^\d+$/.test(startTime))
		throw new Error('Cannot identify RPC executor process')
	return startTime
}

async function ownerIsActive(owner: OwnerRecord, bootId: string): Promise<boolean> {
	if (owner.bootId !== bootId) return false
	try {
		return processStartTime(await readFile(`/proc/${owner.pid}/stat`, 'utf8')) === owner.startTime
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
		// An unreadable process identity cannot prove that the owner has exited.
		return true
	}
}

function validOwner(value: unknown): value is OwnerRecord {
	if (!value || typeof value !== 'object') return false
	const owner = value as Partial<OwnerRecord>
	return (
		typeof owner.bootId === 'string' &&
		/^[0-9a-f-]{36}$/.test(owner.bootId) &&
		Number.isSafeInteger(owner.pid) &&
		owner.pid! > 0 &&
		typeof owner.startTime === 'string' &&
		/^\d+$/.test(owner.startTime) &&
		typeof owner.nonce === 'string' &&
		/^[0-9a-f]{32}$/.test(owner.nonce) &&
		typeof owner.graphRoot === 'string' &&
		owner.graphRoot.startsWith('/') &&
		typeof owner.runRoot === 'string' &&
		owner.runRoot.startsWith('/')
	)
}

function validRun(value: unknown): value is RunRecord {
	if (!value || typeof value !== 'object') return false
	const run = value as Partial<RunRecord>
	return (
		typeof run.nonce === 'string' &&
		/^[0-9a-f]{32}$/.test(run.nonce) &&
		run.name === `pluxel-rpc-run-${run.nonce}` &&
		typeof run.image === 'string' &&
		/^[0-9a-f]{64}$/.test(run.image)
	)
}

type CompileFailureCode = 'CODE_SYNTAX' | 'CODE_TYPECHECK'
type OtherFailureCode =
	| 'CONTRACT_CHANGED'
	| 'FORBIDDEN'
	| 'RUN_PENDING_CALLS'
	| 'RUN_SCRIPT'
	| 'RUN_TRANSPORT'
	| 'RUN_LIMIT'
	| 'ABORTED'
	| 'TIMEOUT'
	| 'INTERNAL'
	| 'OUTPUT_ENCODING'
	| 'OUTPUT_LIMIT'
type CompileDiagnostic = Readonly<{
	line: number
	column: number
	code: string
	message: string
}>

export type RunFailure = Readonly<{
	message: string
	calls: readonly Readonly<{ callId: string; outcome: 'not_started' | 'unknown' }>[]
	cause?: unknown
}> &
	(
		| Readonly<{
				code: CompileFailureCode
				phase: 'compile'
				diagnostics: readonly CompileDiagnostic[]
		  }>
		| Readonly<{
				code: OtherFailureCode
				phase: 'prepare' | 'compile' | 'execute' | 'drain' | 'encode'
				diagnostics?: never
		  }>
	)

export type RpcRunInput = Readonly<{
	session: RpcKernelSession
	contracts: readonly RpcDescription[]
	code: string
	signal?: AbortSignal
	deadlineMs?: number
}>

/** Pin a run's selected discovery scope before any asynchronous preparation. @internal */
export function captureRpcRunInput(input: RpcRunInput): Omit<RpcRunInput, 'contracts'> & {
	contracts: readonly RpcDescription[] | undefined
} {
	return Object.freeze({
		session: input.session,
		contracts: Array.isArray(input.contracts) ? Object.freeze([...input.contracts]) : undefined,
		code: input.code,
		signal: input.signal,
		deadlineMs: input.deadlineMs,
	})
}

type Budgets = Readonly<{
	wallMs: number
	memoryMiB: number
	pids: number
	cpus: number
	tmpMiB: number
	maxRpcCalls: number
	maxConcurrentRpc: number
	maxRpcBytes: number
	drainMs: number
	maxCodeBytes: number
	maxConcurrentRuns: number
}>

const defaultBudgets: Budgets = Object.freeze({
	wallMs: 2_500,
	memoryMiB: 64,
	pids: 16,
	cpus: 0.5,
	tmpMiB: 8,
	maxRpcCalls: 4,
	maxConcurrentRpc: 2,
	maxRpcBytes: 1_024,
	drainMs: 2_000,
	maxCodeBytes: 65_536,
	maxConcurrentRuns: 2,
})

export type RpcExecutorOptions = Readonly<{
	image: string
	compilerPath: string
	capnwebPath: string
	dockerPath?: string
	budgets?: Partial<Budgets>
	/** Internal run observations; listener failures do not change execution. */
	observe?: (event: RpcExecutorEvent) => void
}>

export type RpcExecutorEvent = Readonly<{
	kind: 'compile_attempt' | 'sandbox_start' | 'transport_request'
	at: string
	runId: string
}>

function failure(
	code: OtherFailureCode,
	phase: RunFailure['phase'],
	calls: RunFailure['calls'] = [],
	cause?: unknown,
): RunFailure {
	const message = {
		CONTRACT_CHANGED: 'RPC description is no longer current',
		FORBIDDEN: 'RPC run is not authorized',
		RUN_PENDING_CALLS: 'Code returned with unfinished RPC calls',
		RUN_SCRIPT: 'Code execution failed',
		RUN_TRANSPORT: 'RPC transport did not complete',
		RUN_LIMIT: 'RPC run exceeded its budget',
		ABORTED: 'RPC run was cancelled',
		TIMEOUT: 'RPC run reached its deadline',
		INTERNAL: 'RPC executor failed',
		OUTPUT_ENCODING: 'Program output is not JSON',
		OUTPUT_LIMIT: 'Program output exceeded its budget',
	}[code]
	return {
		code,
		message,
		phase,
		calls,
		...(cause === undefined ? {} : { cause }),
	}
}

function compileFailure(
	code: CompileFailureCode,
	diagnostics: readonly CompileDiagnostic[],
): RunFailure {
	return {
		code,
		message:
			code === 'CODE_SYNTAX'
				? 'Code contains a syntax error'
				: 'Code does not match the RPC contract',
		phase: 'compile',
		calls: [],
		diagnostics,
	}
}

function validateBudgets(budgets: Budgets): void {
	for (const key of [
		'wallMs',
		'memoryMiB',
		'pids',
		'tmpMiB',
		'maxRpcCalls',
		'maxConcurrentRpc',
		'maxRpcBytes',
		'drainMs',
		'maxCodeBytes',
		'maxConcurrentRuns',
	] as const) {
		if (!Number.isSafeInteger(budgets[key]) || budgets[key] < 1)
			throw new TypeError(`Invalid RPC ${key} budget`)
	}
	if (!Number.isFinite(budgets.cpus) || budgets.cpus <= 0 || budgets.cpus > 1)
		throw new TypeError('Invalid RPC CPU budget')
	if (budgets.maxConcurrentRpc > budgets.maxRpcCalls)
		throw new TypeError('Concurrent RPC budget exceeds call budget')
	if (budgets.maxRpcCalls > 1_024)
		throw new TypeError('RPC call budget exceeds control message capacity')
	if (budgets.maxConcurrentRuns > maxProcessRuns)
		throw new TypeError('Concurrent RPC run budget exceeds process capacity')
	if (budgets.wallMs > 60_000 || budgets.drainMs > 60_000)
		throw new TypeError('RPC wall and drain budgets must not exceed 60 seconds')
}

/** Verifies the tested rootless Podman backend before any run can be created. */
export async function createRpcExecutor(options: RpcExecutorOptions) {
	const observe = (kind: RpcExecutorEvent['kind'], runId: string) => {
		try {
			options.observe?.(Object.freeze({ kind, at: new Date().toISOString(), runId }))
		} catch {
			// A diagnostic listener cannot alter an admitted run or its receipts.
		}
	}
	const budgets = Object.freeze({ ...defaultBudgets, ...options.budgets })
	validateBudgets(budgets)
	if (!/^[a-f0-9]{64}$/.test(options.image))
		throw new TypeError('RPC executor requires a full trusted local image ID')
	if (!options.compilerPath || !options.capnwebPath)
		throw new TypeError('RPC executor requires a compiler and Cap’n Web module')
	const dockerPath = options.dockerPath ?? 'docker'
	const docker = async (args: readonly string[], timeoutMs = 10_000) => {
		const result = await execFile(dockerPath, [...args], {
			encoding: 'utf8',
			maxBuffer: 1_048_576,
			timeout: timeoutMs,
		})
		return result.stdout.trim()
	}
	const host = JSON.parse(await docker(['info', '--format', '{{json .Host}}']))
	if (
		host.os !== 'linux' ||
		host.arch !== 'amd64' ||
		!host.security?.rootless ||
		!host.security?.seccompEnabled ||
		host.cgroupVersion !== 'v2' ||
		host.ociRuntime?.name !== 'crun'
	)
		throw new Error(
			'RPC isolation requires Linux amd64, rootless Podman, seccomp, cgroup v2 and crun',
		)
	if (!/^podman version 5\.8\.6$/.test(await docker(['--version'])))
		throw new Error('RPC isolation backend version is unverified')
	const imageId = await docker(['image', 'inspect', options.image, '--format', '{{.Id}}'])
	if (imageId !== options.image) throw new Error('RPC isolation image ID changed')
	const isolationArgs = [
		'--network=none',
		'--userns=keep-id:uid=1001,gid=1001',
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
		`--timeout=${Math.ceil(budgets.wallMs / 1_000)}`,
		'--security-opt=no-new-privileges',
		'--cap-drop=ALL',
		'--user=1001:1001',
	] as const
	const probeCode = `
const fs = require('node:fs')
const status = fs.readFileSync('/proc/self/status', 'utf8').split('\\n')
const field = (name) => status.find((line) => line.startsWith(name + ':'))?.split(':')[1]?.trim()
const root = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n')
  .find((line) => line.split(' ')[4] === '/')
const tmp = fs.statfsSync('/tmp')
console.log(JSON.stringify({
  node: process.version,
  uid: process.getuid(),
  gid: process.getgid(),
  memory: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
  pids: fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(),
  cpu: fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
  tmpType: tmp.type,
  tmpBytes: tmp.blocks * tmp.bsize,
  rootReadOnly: root?.split(' ')[5]?.split(',').includes('ro'),
  routes: fs.readFileSync('/proc/net/route', 'utf8').trim().split('\\n').length - 1,
  privateFile: fs.readFileSync('/private/check', 'utf8'),
  capEff: field('CapEff'),
  noNewPrivs: field('NoNewPrivs'),
  seccomp: field('Seccomp'),
}))`
	const probe = await (async () => {
		const privateProbeDirectory = await mkdtemp(join(tmpdir(), 'pluxel-rpc-probe-'))
		try {
			await chmod(privateProbeDirectory, 0o700)
			await writeFile(join(privateProbeDirectory, 'check'), 'private-probe', { mode: 0o600 })
			return JSON.parse(
				await docker([
					'run',
					'--rm',
					'--pull=never',
					...isolationArgs,
					'--mount',
					`type=bind,source=${privateProbeDirectory},destination=/private,readonly=true`,
					imageId,
					'node',
					'-e',
					probeCode,
				]),
			)
		} finally {
			await rm(privateProbeDirectory, { recursive: true, force: true })
		}
	})()
	const [cpuQuota, cpuPeriod] = String(probe.cpu).split(' ').map(Number)
	if (
		probe.node !== 'v24.20.0' ||
		probe.uid !== 1001 ||
		probe.gid !== 1001 ||
		Number(probe.memory) !== budgets.memoryMiB * 1_048_576 ||
		Number(probe.pids) !== budgets.pids ||
		!Number.isFinite(cpuQuota) ||
		!Number.isFinite(cpuPeriod) ||
		cpuPeriod <= 0 ||
		cpuQuota / cpuPeriod > budgets.cpus + 0.01 ||
		probe.tmpType !== 16_914_836 ||
		probe.tmpBytes > budgets.tmpMiB * 1_048_576 ||
		probe.rootReadOnly !== true ||
		probe.routes !== 0 ||
		probe.privateFile !== 'private-probe' ||
		!/^0+$/.test(probe.capEff) ||
		probe.noNewPrivs !== '1' ||
		probe.seccomp !== '2'
	)
		throw new Error('RPC isolation backend did not enforce required limits')
	const recoveryRoot = join(tmpdir(), recoveryDirectoryName)
	if (
		Buffer.byteLength(join(recoveryRoot, 'o-000000000000', 'r-000000000000', 's', 'gateway.sock')) >
		107
	)
		throw new Error('RPC temporary directory is too long for a Unix socket')
	await execFile('flock', ['--version'], { encoding: 'utf8', timeout: 2_000 })
	await mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
	const rootStatus = await lstat(recoveryRoot)
	if (
		!rootStatus.isDirectory() ||
		rootStatus.uid !== process.getuid() ||
		(rootStatus.mode & 0o077) !== 0
	)
		throw new Error('RPC recovery directory is not private to this user')
	const bootIdFile = await readFile('/proc/sys/kernel/random/boot_id', 'utf8')
	const bootId = bootIdFile.trim()
	const store = JSON.parse(await docker(['info', '--format', '{{json .Store}}']))
	const processStat = await readFile('/proc/self/stat', 'utf8')
	if (
		typeof store.graphRoot !== 'string' ||
		!store.graphRoot.startsWith('/') ||
		typeof store.runRoot !== 'string' ||
		!store.runRoot.startsWith('/')
	)
		throw new Error('RPC isolation backend storage identity is unavailable')
	const owner: OwnerRecord = {
		bootId,
		pid: process.pid,
		startTime: processStartTime(processStat),
		nonce: randomBytes(16).toString('hex'),
		graphRoot: store.graphRoot,
		runRoot: store.runRoot,
	}
	const ownerDirectory = join(recoveryRoot, `o-${owner.nonce.slice(0, 12)}`)
	const stagingDirectory = join(recoveryRoot, `.o-${owner.nonce.slice(0, 12)}.staging`)
	await withAdmissionLock(join(recoveryRoot, admissionLock), async () => {
		await mkdir(stagingDirectory, { mode: 0o700 })
		try {
			await writeFile(join(stagingDirectory, ownerFile), JSON.stringify(owner), { mode: 0o600 })
			await rename(stagingDirectory, ownerDirectory)
		} catch (cause) {
			await rm(stagingDirectory, { recursive: true, force: true })
			throw cause
		}
	})

	async function containerExists(name: string): Promise<boolean> {
		try {
			await docker(['container', 'exists', name], 2_000)
			return true
		} catch (cause) {
			if ((cause as { code?: unknown }).code === 1) return false
			throw cause
		}
	}

	async function removeOwnedRun(
		directory: string,
		record: RunRecord,
		ownerNonce: string,
	): Promise<void> {
		try {
			await execFile('flock', ['-n', '-x', join(directory, runLock), 'true'], {
				encoding: 'utf8',
				timeout: 2_000,
			})
		} catch (cause) {
			throw new Error('RPC container launch is still in progress or its lock cannot be verified', {
				cause,
			})
		}
		if (await containerExists(record.name)) {
			const inspected: unknown = JSON.parse(
				await docker(['container', 'inspect', record.name], 2_000),
			)
			const container = Array.isArray(inspected) ? inspected[0] : undefined
			const mounts = container?.Mounts
			const hasMount = (source: string, destination: string) =>
				Array.isArray(mounts) &&
				mounts.some(
					(mount: { Source?: unknown; Destination?: unknown; RW?: unknown }) =>
						mount.Source === source && mount.Destination === destination && mount.RW === false,
				)
			if (
				!container ||
				!/^[a-f0-9]{64}$/.test(container.Id) ||
				String(container.Name).replace(/^\//, '') !== record.name ||
				String(container.Image).replace(/^sha256:/, '') !== record.image ||
				container.Config?.Labels?.['io.pluxel.rpc.owner'] !== ownerNonce ||
				container.Config?.Labels?.['io.pluxel.rpc.run'] !== record.nonce ||
				!hasMount(join(directory, 's'), '/rpc') ||
				!hasMount(join(directory, 'out'), '/program')
			)
				throw new Error('RPC container ownership could not be verified')
			if (container.State?.Running === true) {
				try {
					await docker(['kill', container.Id], 5_000)
				} catch (cause) {
					if (await containerExists(record.name)) {
						const current: unknown = JSON.parse(
							await docker(['container', 'inspect', record.name], 2_000),
						)
						if (Array.isArray(current) && current[0]?.State?.Running === true) throw cause
					}
				}
			}
			try {
				await docker(['rm', '-f', container.Id], 10_000)
			} catch (cause) {
				// Another recovery process may have removed the same verified ID.
				if (await containerExists(record.name)) throw cause
			}
			if (await containerExists(record.name))
				throw new Error('RPC container still exists after removal')
		}
		await rm(directory, { recursive: true, force: true })
	}

	const recoveryFailures: unknown[] = []
	async function recoverOrphans(): Promise<void> {
		for (const entry of await readdir(recoveryRoot, { withFileTypes: true })) {
			if (/^\.o-[0-9a-f]{12}\.staging$/.test(entry.name)) {
				const directory = join(recoveryRoot, entry.name)
				try {
					const status = await lstat(directory)
					if (
						!status.isDirectory() ||
						status.uid !== process.getuid() ||
						(status.mode & 0o077) !== 0
					)
						throw new Error('RPC staging directory ownership could not be verified')
					// Owner publication holds the same lock, so any staging directory here is abandoned.
					await rm(directory, { recursive: true, force: true })
				} catch (cause) {
					recoveryFailures.push(cause)
				}
				continue
			}
			if (!entry.isDirectory() || !/^o-[0-9a-f]{12}$/.test(entry.name)) continue
			const directory = join(recoveryRoot, entry.name)
			try {
				const status = await lstat(directory)
				if (!status.isDirectory() || status.uid !== process.getuid() || (status.mode & 0o077) !== 0)
					continue
				let oldOwner: unknown
				try {
					oldOwner = JSON.parse(await readFile(join(directory, ownerFile), 'utf8'))
				} catch (cause) {
					// A concurrent creator may not have written its owner record yet.
					if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue
					throw cause
				}
				if (
					!validOwner(oldOwner) ||
					entry.name !== `o-${oldOwner.nonce.slice(0, 12)}` ||
					oldOwner.graphRoot !== owner.graphRoot ||
					oldOwner.runRoot !== owner.runRoot ||
					(await ownerIsActive(oldOwner, bootId))
				)
					continue
				let complete = true
				for (const runEntry of await readdir(directory, { withFileTypes: true })) {
					if (runEntry.name === ownerFile) continue
					if (!runEntry.name.startsWith('r-')) {
						complete = false
						continue
					}
					if (!runEntry.isDirectory() || !/^r-[0-9a-f]{12}$/.test(runEntry.name)) {
						complete = false
						continue
					}
					const runDirectory = join(directory, runEntry.name)
					try {
						const runStatus = await lstat(runDirectory)
						if (
							!runStatus.isDirectory() ||
							runStatus.uid !== process.getuid() ||
							(runStatus.mode & 0o077) !== 0
						)
							throw new Error('RPC run directory ownership could not be verified')
						let oldRun: unknown
						try {
							oldRun = JSON.parse(await readFile(join(runDirectory, runFile), 'utf8'))
						} catch (cause) {
							if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
							// The record is written before Podman can be launched.
							await rm(runDirectory, { recursive: true, force: true })
							continue
						}
						if (!validRun(oldRun) || runEntry.name !== `r-${oldRun.nonce.slice(0, 12)}`)
							throw new Error('RPC run record could not be verified')
						await removeOwnedRun(runDirectory, oldRun, oldOwner.nonce)
					} catch (cause) {
						complete = false
						recoveryFailures.push(cause)
					}
				}
				if (complete) await rm(directory, { recursive: true, force: true })
			} catch (cause) {
				recoveryFailures.push(cause)
			}
		}
	}
	const recovery = withAdmissionLock(join(recoveryRoot, admissionLock), recoverOrphans).catch(
		(cause) => {
			recoveryFailures.push(cause)
		},
	)
	async function reserveRun(record: RunRecord): Promise<string | undefined> {
		return withAdmissionLock(join(recoveryRoot, admissionLock), async () => {
			await recoverOrphans()
			if (recoveryFailures.length > 0)
				throw new AggregateError(recoveryFailures, 'RPC orphan recovery failed')
			let occupied = 0
			for (const entry of await readdir(recoveryRoot, { withFileTypes: true })) {
				if (!entry.name.startsWith('o-')) continue
				if (!entry.isDirectory() || !/^o-[0-9a-f]{12}$/.test(entry.name))
					throw new Error('RPC owner record could not be verified')
				const path = join(recoveryRoot, entry.name)
				const status = await lstat(path)
				if (!status.isDirectory() || status.uid !== process.getuid() || (status.mode & 0o077) !== 0)
					throw new Error('RPC owner directory could not be verified')
				let saved: unknown
				try {
					saved = JSON.parse(await readFile(join(path, ownerFile), 'utf8'))
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
						// A creator cannot reserve a run before writing its owner record.
						const pendingEntries = await readdir(path)
						if (pendingEntries.length === 0) continue
					}
					throw cause
				}
				const entries = await readdir(path, { withFileTypes: true })
				if (entries.length === 1 && entries[0].name === ownerFile) continue
				if (
					!validOwner(saved) ||
					entry.name !== `o-${saved.nonce.slice(0, 12)}` ||
					saved.graphRoot !== owner.graphRoot ||
					saved.runRoot !== owner.runRoot ||
					!(await ownerIsActive(saved, bootId))
				)
					throw new Error('RPC owner identity could not be verified')
				for (const runEntry of entries) {
					if (runEntry.name === ownerFile) continue
					if (!runEntry.isDirectory() || !/^r-[0-9a-f]{12}$/.test(runEntry.name))
						throw new Error('RPC run reservation could not be verified')
					const recorded: unknown = JSON.parse(
						await readFile(join(path, runEntry.name, runFile), 'utf8'),
					)
					if (!validRun(recorded) || runEntry.name !== `r-${recorded.nonce.slice(0, 12)}`)
						throw new Error('RPC run reservation could not be verified')
					occupied++
				}
			}
			if (occupied >= maxProcessRuns) return undefined
			const directory = join(ownerDirectory, `r-${record.nonce.slice(0, 12)}`)
			await mkdir(directory, { mode: 0o700 })
			try {
				await writeFile(join(directory, runFile), JSON.stringify(record), { mode: 0o600 })
			} catch (cause) {
				await rm(directory, { recursive: true, force: true })
				throw cause
			}
			return directory
		})
	}
	let open = true
	const stopped = new AbortController()
	const active = new Set<Promise<unknown>>()
	const unsettled = new Set<Promise<void>>()
	const closeFailures: unknown[] = []
	let closing: Promise<void> | undefined

	async function run(input: RpcRunInput) {
		const { session, contracts, code, signal, deadlineMs } = captureRpcRunInput(input)
		if (!open || signal?.aborted || session.closedSignal.aborted)
			return Result.err(failure('ABORTED', 'prepare'))
		if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0))
			return Result.err(failure('INTERNAL', 'prepare', [], new TypeError('Invalid RPC deadline')))
		if (deadlineMs !== undefined && Date.now() >= deadlineMs)
			return Result.err(failure('TIMEOUT', 'prepare'))
		if (active.size >= budgets.maxConcurrentRuns || activeProcessRuns >= maxProcessRuns)
			return Result.err(failure('RUN_LIMIT', 'prepare'))
		if (
			!contracts ||
			contracts.length > 50 ||
			contracts.some((description) => !session.isDescriptionCurrent(description)) ||
			new Set(contracts.map(({ id }) => id)).size !== contracts.length
		)
			return Result.err(failure('CONTRACT_CHANGED', 'prepare'))
		if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > budgets.maxCodeBytes)
			return Result.err(failure('RUN_LIMIT', 'prepare'))
		const snapshot: RpcRunInput = { session, contracts, code, signal, deadlineMs }
		activeProcessRuns++
		let ongoing: Promise<void> | undefined
		const task = execute(snapshot, (work, cause) => {
			closeFailures.push(cause)
			const tracked = work.finally(() => unsettled.delete(tracked))
			unsettled.add(tracked)
			ongoing = tracked
		}).catch((cause) => Result.err(failure('INTERNAL', 'execute', [], cause)))
		active.add(task)
		void task.finally(() => {
			active.delete(task)
			if (ongoing) void ongoing.finally(() => activeProcessRuns--)
			else activeProcessRuns--
		})
		session.trackBorrowedRun(task)
		return task
	}

	async function execute(
		input: RpcRunInput,
		onDrainFailure: (work: Promise<void>, cause: unknown) => void,
	) {
		const deadlineReason = Symbol('RPC deadline')
		const deadline = new AbortController()
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined
		const armDeadline = () => {
			const remaining = input.deadlineMs! - Date.now()
			if (remaining <= 0) deadline.abort(deadlineReason)
			else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647))
		}
		if (input.deadlineMs !== undefined) armDeadline()
		const runSignal = input.signal
			? AbortSignal.any([input.signal, input.session.closedSignal, stopped.signal, deadline.signal])
			: AbortSignal.any([input.session.closedSignal, stopped.signal, deadline.signal])
		const runNonce = randomBytes(16).toString('hex')
		const runRecord: RunRecord = {
			nonce: runNonce,
			name: `pluxel-rpc-run-${runNonce}`,
			image: imageId,
		}
		const directory = join(ownerDirectory, `r-${runNonce.slice(0, 12)}`)
		try {
			await recovery
			const reserved = await reserveRun(runRecord)
			if (!reserved) {
				clearTimeout(deadlineTimer)
				return Result.err(failure('RUN_LIMIT', 'prepare'))
			}
		} catch (cause) {
			clearTimeout(deadlineTimer)
			return Result.err(failure('INTERNAL', 'prepare', [], cause))
		}
		const sourceDirectory = join(directory, 'source')
		const outputDirectory = join(directory, 'out')
		const socketDirectory = join(directory, 's')
		const containerName = runRecord.name
		let carrier: ReturnType<typeof createRpcHttpCarrier> | undefined
		let server: ReturnType<typeof createServer> | undefined
		let httpRun: ReturnType<ReturnType<typeof createRpcHttpCarrier>['openRun']> | undefined
		let container = ''
		let timer: ReturnType<typeof setTimeout> | undefined
		let killReason: 'aborted' | 'deadline' | 'wall-time' | undefined
		let calls: RunFailure['calls'] = []
		const observedCalls = new Map<string, 'not_started' | 'unknown'>()
		let completion:
			| { kind: 'result'; value: unknown; calls?: string[] }
			| { kind: 'output_error'; code: string; calls?: string[] }
			| {
					kind: 'script_error' | 'transport_error' | 'limit_error' | 'pending_error'
					calls?: string[]
			  }
			| undefined
		let pendingAtCompletion = false
		let launchAttempted = false
		const outcome = await (async () => {
			try {
				await writeFile(join(directory, runLock), '', { mode: 0o600 })
				await Promise.all([mkdir(sourceDirectory), mkdir(outputDirectory), mkdir(socketDirectory)])
				await chmod(sourceDirectory, 0o700)
				await chmod(outputDirectory, 0o700)
				await chmod(socketDirectory, 0o700)
				const declarations = input.contracts.map((item, index) => {
					const name = `api${index}`
					return writeFile(join(sourceDirectory, `${name}.d.ts`), item.declaration).then(() => name)
				})
				const names = await Promise.all(declarations)
				const prefix = names
					.map((name, index) => `import type { RpcClient as Client${index} } from './${name}'`)
					.join('\n')
				const aliases =
					names.map((_, index) => `Client${index}`).join(' & ') || '{ open(id: never): never }'
				const prefixLines = names.length + 2
				const source = `${prefix}\ntype Rpc = ${aliases}\nasync function userRun(rpc: Rpc): Promise<unknown> {\n${input.code}\n}\nexport default userRun\n`
				await writeFile(join(sourceDirectory, 'program.ts'), source)
				const config = {
					compilerOptions: {
						target: 'ES2022',
						module: 'CommonJS',
						strict: true,
						types: [] as string[],
						lib: ['ES2022'],
						noResolve: true,
						skipLibCheck: true,
						rootDir: sourceDirectory,
						outDir: outputDirectory,
					},
					files: [
						join(sourceDirectory, 'program.ts'),
						...names.map((name) => join(sourceDirectory, `${name}.d.ts`)),
					],
				}
				await writeFile(join(directory, 'tsconfig.json'), JSON.stringify(config))
				try {
					observe('compile_attempt', runNonce)
					await execFile(
						options.compilerPath,
						['-p', join(directory, 'tsconfig.json'), '--pretty', 'false'],
						{ encoding: 'utf8', maxBuffer: 1_048_576, timeout: 10_000, signal: runSignal },
					)
				} catch (cause) {
					if (runSignal.aborted)
						return Result.err(
							failure(runSignal.reason === deadlineReason ? 'TIMEOUT' : 'ABORTED', 'compile'),
						)
					const output = `${(cause as { stdout?: string }).stdout ?? ''}${(cause as { stderr?: string }).stderr ?? ''}`
					const diagnostics = [
						...output.matchAll(/program\.ts\((\d+),(\d+)\): error (TS\d+): (.+)/g),
					].map((match) => ({
						line: Math.max(1, Number(match[1]) - prefixLines),
						column: Number(match[2]),
						code: match[3],
						message: match[4],
					}))
					if (diagnostics.length === 0) return Result.err(failure('INTERNAL', 'compile', [], cause))
					const code = diagnostics.some(({ code: diagnosticCode }) =>
						/^TS1\d{3}$/.test(diagnosticCode),
					)
						? 'CODE_SYNTAX'
						: 'CODE_TYPECHECK'
					return Result.err(compileFailure(code, diagnostics))
				}
				if (runSignal.aborted)
					return Result.err(
						failure(runSignal.reason === deadlineReason ? 'TIMEOUT' : 'ABORTED', 'prepare'),
					)
				if (input.contracts.some((description) => !input.session.isDescriptionCurrent(description)))
					return Result.err(failure('CONTRACT_CHANGED', 'prepare'))
				await copyFile(options.capnwebPath, join(outputDirectory, 'capnweb.mjs'))
				await writeFile(
					join(outputDirectory, 'methods.json'),
					JSON.stringify(
						input.contracts.map(({ id, methods }) => ({
							id,
							methods: methods.map(({ method }) => method),
						})),
					),
				)
				carrier = createRpcHttpCarrier(
					{
						maxRequestBytes: budgets.maxRpcBytes,
						maxBodyMs: 1_000,
						maxBatchMessages: 16,
						maxCallsPerBatch: budgets.maxConcurrentRpc,
						maxConcurrentCalls: budgets.maxConcurrentRpc,
						maxCallsPerRun: budgets.maxRpcCalls,
						maxResponseBytes: 65_536,
						drainMs: budgets.drainMs,
					},
					() => observe('transport_request', runNonce),
				)
				const session = input.session
				const allowedMethods = new Map(
					input.contracts.map(({ id, methods }) => [
						id,
						new Set(methods.map(({ method }) => method)),
					]),
				)
				const observedSession: RpcKernelSession = {
					principal: session.principal,
					closedSignal: session.closedSignal,
					search: (searchOptions) => session.search(searchOptions),
					describe: (describeOptions) => session.describe(describeOptions),
					isDescriptionCurrent: (description) => session.isDescriptionCurrent(description),
					revoke: (ids) => session.revoke(ids),
					call: (call) => session.call(call),
					callForDelivery: (call) => {
						if (call.callId) observedCalls.set(call.callId, 'unknown')
						if (!allowedMethods.get(call.id)?.has(call.method)) {
							if (call.callId) observedCalls.set(call.callId, 'not_started')
							return Promise.resolve({
								result: {
									ok: false as const,
									error: {
										code: 'FORBIDDEN' as const,
										message: 'RPC access denied',
										callId: call.callId!,
										outcome: 'not_started' as const,
									},
								},
								release() {},
							})
						}
						return session.callForDelivery(call).then((delivery) => {
							if (call.callId) {
								const result = delivery.result
								if (result.ok === false) observedCalls.set(call.callId, result.error.outcome)
								else observedCalls.set(call.callId, 'unknown')
							}
							return delivery
						})
					},
					trackBorrowedRun: (task) => session.trackBorrowedRun(task),
					close: () => session.close(),
					[Symbol.asyncDispose]: () => session[Symbol.asyncDispose](),
				}
				httpRun = carrier.openRun(observedSession, (callId, callOutcome) => {
					if (callOutcome === 'unknown' || !observedCalls.has(callId))
						observedCalls.set(callId, callOutcome)
				})
				server = createServer((request, response) => {
					if (request.url === '/result') {
						void (async () => {
							if (
								request.method !== 'POST' ||
								request.headers.authorization !== `Bearer ${httpRun!.token}` ||
								request.headers['x-run-id'] !== httpRun!.runId ||
								request.headers['x-session-id'] !== httpRun!.sessionId ||
								completion
							) {
								response.writeHead(403).end()
								return
							}
							try {
								const chunks: Buffer[] = []
								let size = 0
								for await (const chunk of request) {
									size += chunk.length
									if (size > 70_000) throw new RangeError('RPC result exceeds budget')
									chunks.push(chunk)
								}
								const message: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
								if (
									!message ||
									typeof message !== 'object' ||
									!('kind' in message) ||
									(message.kind !== 'result' &&
										message.kind !== 'output_error' &&
										message.kind !== 'script_error' &&
										message.kind !== 'transport_error' &&
										message.kind !== 'limit_error' &&
										message.kind !== 'pending_error')
								)
									throw new TypeError('Invalid RPC result')
								if (
									'calls' in message &&
									(!Array.isArray(message.calls) ||
										message.calls.length > budgets.maxRpcCalls + 1 ||
										message.calls.some(
											(callId) =>
												typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(callId),
										) ||
										new Set(message.calls).size !== message.calls.length)
								)
									throw new TypeError('Invalid RPC call report')
								if (message.kind === 'result' && !('value' in message))
									throw new TypeError('Missing RPC result')
								if (
									message.kind === 'output_error' &&
									(!('code' in message) || typeof message.code !== 'string')
								)
									throw new TypeError('Invalid RPC output failure')
								if (completion) {
									response.writeHead(403).end()
									return
								}
								const state = httpRun!.stats()
								pendingAtCompletion = state.pendingRequests > 0 || state.admitted !== state.settled
								if ('calls' in message && Array.isArray(message.calls)) {
									for (const callId of message.calls) {
										if (!observedCalls.has(callId)) observedCalls.set(callId, 'unknown')
									}
								}
								httpRun!.seal()
								completion = message as typeof completion
								response.writeHead(204).end()
							} catch {
								response.writeHead(400).end()
							}
						})()
						return
					}
					void carrier!.handle(request, response).catch((cause) => response.destroy(cause))
				})
				server.maxConnections = budgets.maxConcurrentRpc + 4
				server.requestTimeout = 1_000
				server.timeout = 1_000
				await new Promise<void>((resolve, reject) =>
					server!.listen(join(socketDirectory, 'gateway.sock'), (cause?: Error) =>
						cause ? reject(cause) : resolve(),
					),
				)
				await chmod(join(socketDirectory, 'gateway.sock'), 0o600)
				const environmentPath = join(directory, 'guest.env')
				await writeFile(
					environmentPath,
					`RPC_TOKEN=${httpRun.token}\nRPC_RUN_ID=${httpRun.runId}\nRPC_SESSION_ID=${httpRun.sessionId}\n`,
					{ mode: 0o600 },
				)
				const guest = await readFile(guestPath, 'utf8')
				const args = [
					'run',
					'-d',
					'--pull=never',
					'--name',
					containerName,
					'--label',
					`io.pluxel.rpc.owner=${owner.nonce}`,
					'--label',
					`io.pluxel.rpc.run=${runNonce}`,
					...isolationArgs,
					'--mount',
					`type=bind,source=${socketDirectory},destination=/rpc,readonly=true`,
					'--mount',
					`type=bind,source=${outputDirectory},destination=/program,readonly=true`,
					'--env-file',
					environmentPath,
					'--env',
					`RPC_MAX_CALLS=${budgets.maxRpcCalls}`,
					'--env',
					`RPC_MAX_CONCURRENT=${budgets.maxConcurrentRpc}`,
					imageId,
					'node',
					'-e',
					guest,
				]
				if (runSignal.aborted)
					return Result.err(
						failure(runSignal.reason === deadlineReason ? 'TIMEOUT' : 'ABORTED', 'prepare'),
					)
				launchAttempted = true
				observe('sandbox_start', runNonce)
				const launch = await execFile(
					'flock',
					['-x', join(directory, runLock), dockerPath, ...args],
					{
						encoding: 'utf8',
						maxBuffer: 1_048_576,
						timeout: 10_000,
					},
				)
				container = launch.stdout.trim()
				const stop = (reason: 'aborted' | 'deadline' | 'wall-time') => {
					if (killReason) return
					killReason = reason
					void docker(['kill', container]).catch(() => {})
				}
				const abort = () => stop(runSignal.reason === deadlineReason ? 'deadline' : 'aborted')
				runSignal.addEventListener('abort', abort, { once: true })
				if (runSignal.aborted) stop(runSignal.reason === deadlineReason ? 'deadline' : 'aborted')
				timer = setTimeout(() => stop('wall-time'), budgets.wallMs)
				let exitCode: number
				try {
					exitCode = Number(await docker(['wait', container], budgets.wallMs + 10_000))
				} finally {
					runSignal.removeEventListener('abort', abort)
					clearTimeout(timer)
				}
				try {
					await httpRun.close()
				} catch (cause) {
					onDrainFailure(httpRun.waitForSettled(), cause)
					calls = [...observedCalls].map(([callId, callOutcome]) => ({
						callId,
						outcome: callOutcome,
					}))
					return Result.err(failure('RUN_TRANSPORT', 'drain', calls, cause))
				}
				calls = [...observedCalls].map(([callId, callOutcome]) => ({
					callId,
					outcome: callOutcome,
				}))
				if (killReason === 'aborted') return Result.err(failure('ABORTED', 'execute', calls))
				if (killReason === 'deadline') return Result.err(failure('TIMEOUT', 'execute', calls))
				if (killReason === 'wall-time' || exitCode === 137)
					return Result.err(failure('RUN_LIMIT', 'execute', calls))
				if (pendingAtCompletion) return Result.err(failure('RUN_PENDING_CALLS', 'drain', calls))
				if (exitCode === 21) return Result.err(failure('RUN_PENDING_CALLS', 'drain', calls))
				if (exitCode === 23) return Result.err(failure('RUN_LIMIT', 'execute', calls))
				if (exitCode === 24) return Result.err(failure('RUN_TRANSPORT', 'execute', calls))
				if (exitCode === 22) {
					const kind =
						completion?.kind === 'output_error' && completion.code === 'OUTPUT_LIMIT'
							? 'OUTPUT_LIMIT'
							: 'OUTPUT_ENCODING'
					return Result.err(failure(kind, 'encode', calls))
				}
				if (exitCode !== 0)
					return Result.err(
						failure(
							completion?.kind === 'script_error' ? 'RUN_SCRIPT' : 'RUN_TRANSPORT',
							'execute',
							calls,
						),
					)
				if (completion?.kind !== 'result')
					return Result.err(failure('RUN_TRANSPORT', 'encode', calls))
				try {
					const value = copyJson(completion.value, 65_536).value
					return Result.ok(value)
				} catch (cause) {
					return Result.err(
						failure(
							cause instanceof JsonWireError ? cause.code : 'OUTPUT_ENCODING',
							'encode',
							calls,
						),
					)
				}
			} catch (cause) {
				calls = [...observedCalls].map(([callId, callOutcome]) => ({
					callId,
					outcome: callOutcome,
				}))
				return Result.err(failure('INTERNAL', 'execute', calls, cause))
			}
		})()
		clearTimeout(timer)
		clearTimeout(deadlineTimer)
		calls = [...observedCalls].map(([callId, callOutcome]) => ({ callId, outcome: callOutcome }))
		const cleanupFailures: unknown[] = []
		if (launchAttempted) {
			try {
				await withAdmissionLock(join(recoveryRoot, admissionLock), () =>
					removeOwnedRun(directory, runRecord, owner.nonce),
				)
			} catch (cause) {
				cleanupFailures.push(cause)
			}
		}
		try {
			await httpRun?.close()
		} catch (cause) {
			cleanupFailures.push(cause)
		}
		try {
			await carrier?.close()
		} catch (cause) {
			cleanupFailures.push(cause)
		}
		server?.closeAllConnections()
		if (server) {
			try {
				await new Promise<void>((resolve) => server!.close(() => resolve()))
			} catch (cause) {
				cleanupFailures.push(cause)
			}
		}
		if (!launchAttempted) {
			try {
				await withAdmissionLock(join(recoveryRoot, admissionLock), () =>
					rm(directory, { recursive: true, force: true }),
				)
			} catch (cause) {
				cleanupFailures.push(cause)
			}
		}
		if (cleanupFailures.length > 0) {
			closeFailures.push(...cleanupFailures)
			return Result.err(
				failure(
					'RUN_TRANSPORT',
					'drain',
					calls,
					new AggregateError(cleanupFailures, 'RPC executor cleanup failed'),
				),
			)
		}
		return outcome
	}

	function close(): Promise<void> {
		if (closing) return closing
		open = false
		stopped.abort()
		closing = (async () => {
			await Promise.all(active)
			await Promise.all(unsettled)
			await recovery
			if (closeFailures.length === 0) {
				try {
					await withAdmissionLock(join(recoveryRoot, admissionLock), () =>
						rm(ownerDirectory, { recursive: true, force: true }),
					)
				} catch (cause) {
					closeFailures.push(cause)
				}
			}
			closeFailures.push(...recoveryFailures)
			if (closeFailures.length > 0)
				throw new AggregateError(closeFailures, 'RPC executor cleanup failed')
		})()
		return closing
	}

	return Object.freeze({ run, close })
}
