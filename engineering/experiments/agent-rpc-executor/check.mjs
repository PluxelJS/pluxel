import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
	RpcTarget,
	newHttpBatchRpcSession,
	nodeHttpBatchRpcResponse,
} from '../../../packages/services/node_modules/capnweb/dist/index.js'
import { executeSandboxedRun, verifyBackend } from '../agent-rpc-sandbox/executor.mjs'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))
const image = process.env.RPC_SANDBOX_IMAGE
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const typePrefix = `type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
interface TextApi {
  echo(input: { text: string }): Promise<RpcResult<{ text: string }>>
  slow(input: { text: string }): Promise<RpcResult<{ text: string }>>
}
interface Rpc { open(id: 'text'): TextApi }
async function userRun(rpc: Rpc): Promise<unknown> {
`
const prefixLines = typePrefix.split('\n').length - 1
const runtime = `
function encodeJson(value) {
  const seen = new Set()
  let nodes = 0
  function visit(item, depth) {
    if (++nodes > 10000 || depth > 32) throw Error('OUTPUT_LIMIT')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) {
      if (seen.has(item)) throw Error('OUTPUT_ENCODING')
      seen.add(item)
      const result = item.map((entry) => visit(entry, depth + 1))
      seen.delete(item)
      return result
    }
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype || seen.has(item)) throw Error('OUTPUT_ENCODING')
    seen.add(item)
    const result = {}
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || key === '__proto__') throw Error('OUTPUT_ENCODING')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (!descriptor.enumerable || !('value' in descriptor)) throw Error('OUTPUT_ENCODING')
      result[key] = visit(descriptor.value, depth + 1)
    }
    seen.delete(item)
    return result
  }
  if (value === undefined) return null
  const result = visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw Error('OUTPUT_LIMIT')
  return result
}
async function run(rawRpc) {
  const pending = new Set()
  function call(method, input) {
    const task = rawRpc.invoke({ method, input })
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const rpc = Object.freeze({ open(id) {
    if (id !== 'text') throw Error('FORBIDDEN')
    return Object.freeze({ echo: (input) => call('echo', input), slow: (input) => call('slow', input) })
  } })
  const value = await userRun(rpc)
  if (pending.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    process.exit(21)
  }
  try { return encodeJson(value) }
  catch (error) { return { __runError: error.message } }
}
`

async function compile(body) {
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-rpc-executor-ts-'))
	try {
		const source = join(directory, 'program.ts')
		await writeFile(source, `${typePrefix}${body}\n}\n`)
		await writeFile(
			join(directory, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: 'commonjs',
					strict: true,
					types: [],
					lib: ['ES2022'],
					skipLibCheck: true,
					outDir: join(directory, 'out'),
				},
				files: [source],
			}),
		)
		try {
			await execFile(
				join(here, '../../../node_modules/.bin/tsc'),
				['-p', join(directory, 'tsconfig.json'), '--pretty', 'false'],
				{ maxBuffer: 1024 * 1024 },
			)
		} catch (error) {
			const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
			const diagnostics = [
				...output.matchAll(/program\.ts\((\d+),(\d+)\): error (TS\d+): (.+)/g),
			].map((match) => ({
				line: Math.max(1, Number(match[1]) - prefixLines),
				column: Number(match[2]),
				code: match[3],
				message: match[4],
			}))
			return {
				error: {
					code: diagnostics.some((item) => /^TS1\d{3}$/.test(item.code))
						? 'CODE_SYNTAX'
						: 'CODE_TYPECHECK',
					phase: 'compile',
					diagnostics,
				},
			}
		}
		const code = await readFile(join(directory, 'out', 'program.js'), 'utf8')
		return { code: `${code}\n${runtime}` }
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

function createCapnTransport() {
	const token = randomBytes(24).toString('hex')
	const records = { batches: [], calls: [], openedStubs: 0, disposedStubs: 0 }
	class TextTarget extends RpcTarget {
		async echo(input) {
			records.calls.push({ method: 'echo', input })
			return { ok: true, value: { text: input.text } }
		}
		async slow(input) {
			records.calls.push({ method: 'slow', input })
			await wait(700)
			return { ok: true, value: { text: input.text } }
		}
	}
	const server = createServer((request, response) => {
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(403).end()
			return
		}
		records.batches.push({ calls: [] })
		void nodeHttpBatchRpcResponse(request, response, new TextTarget()).catch((error) => {
			if (!response.destroyed) response.destroy(error)
		})
	})
	let url
	let queue = []
	let timer
	const active = new Set()
	function flush() {
		clearTimeout(timer)
		timer = undefined
		const jobs = queue
		queue = []
		for (let offset = 0; offset < jobs.length; offset += 2) {
			const batch = jobs.slice(offset, offset + 2)
			const task = (async () => {
				const stub = newHttpBatchRpcSession(
					new Request(url, { headers: { authorization: `Bearer ${token}` } }),
				)
				records.openedStubs++
				try {
					const results = await Promise.allSettled(batch.map((job) => stub[job.method](job.input)))
					for (const [index, result] of results.entries()) {
						if (result.status === 'fulfilled') batch[index].resolve(result.value)
						else batch[index].reject(result.reason)
					}
				} finally {
					stub[Symbol.dispose]()
					records.disposedStubs++
				}
			})()
			active.add(task)
			void task.finally(() => active.delete(task))
		}
	}
	return {
		records,
		async start() {
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
			url = `http://127.0.0.1:${server.address().port}/`
		},
		onInvoke(payload) {
			if (!['echo', 'slow'].includes(payload?.method) || typeof payload?.input?.text !== 'string')
				throw Error('FORBIDDEN')
			return new Promise((resolve, reject) => {
				queue.push({ method: payload.method, input: payload.input, resolve, reject })
				if (!timer) timer = setTimeout(flush, 10)
			})
		},
		async close() {
			if (queue.length > 0) flush()
			await Promise.allSettled(active)
			server.closeAllConnections()
			await new Promise((resolve) => server.close(resolve))
			assert.equal(records.openedStubs, records.disposedStubs)
		},
	}
}

async function runBody(body, options = {}) {
	if (options.signal?.aborted)
		return { ok: false, error: { code: 'ABORTED', phase: 'prepare', calls: [] } }
	const compiled = await compile(body)
	if (compiled.error) return { ok: false, error: { ...compiled.error, calls: [] } }
	const transport = createCapnTransport()
	await transport.start()
	try {
		const report = await executeSandboxedRun({
			code: compiled.code,
			image,
			onInvoke: transport.onInvoke,
			onStarted: options.signal
				? async ({ firstAdmission, stop }) => {
						options.signal.addEventListener(
							'abort',
							() => {
								void stop('aborted')
							},
							{ once: true },
						)
						if (options.signal.aborted) await stop('aborted')
						if (options.onAdmission) void firstAdmission.then(options.onAdmission)
					}
				: undefined,
		})
		const calls = transport.records.calls.map((_, index) => ({
			callId: `observed-${index + 1}`,
			outcome: 'unknown',
		}))
		let error
		if (report.killReason === 'aborted') error = { code: 'ABORTED', phase: 'execute' }
		else if (report.killReason === 'wall-time' || report.exitCode === 137)
			error = { code: 'RUN_LIMIT', phase: 'execute' }
		else if (report.exitCode === 21) error = { code: 'RUN_PENDING_CALLS', phase: 'drain' }
		else if (report.exitCode !== 0) error = { code: 'RUN_SCRIPT', phase: 'execute' }
		else if (report.result?.__runError) error = { code: report.result.__runError, phase: 'encode' }
		return {
			ok: !error,
			...(error ? { error: { ...error, calls } } : { value: report.result }),
			report: {
				exitCode: report.exitCode,
				activeAtExit: report.activeAtExit,
				drainMs: report.drainMs,
				admitted: report.admitted,
				settled: report.settled,
				batches: transport.records.batches.length,
				openedStubs: transport.records.openedStubs,
				disposedStubs: transport.records.disposedStubs,
			},
		}
	} finally {
		await transport.close()
	}
}

await verifyBackend(image)
const results = { typeError: await runBody(`return await rpc.open('text').echo({ text: 123 })`) }
assert.equal(results.typeError.error.code, 'CODE_TYPECHECK')
assert.equal(results.typeError.error.diagnostics[0].line, 1)
results.syntaxError = await runBody(`return await rpc.open('text').echo({ text: })`)
assert.equal(results.syntaxError.error.code, 'CODE_SYNTAX')
results.sequential = await runBody(
	`const text = rpc.open('text'); const first = await text.echo({ text: 'first' }); if (!first.ok) return first; return await text.echo({ text: first.value.text + '-second' })`,
)
assert.deepEqual(results.sequential.value, { ok: true, value: { text: 'first-second' } })
assert.equal(results.sequential.report.batches, 2)
results.parallel = await runBody(
	`const text = rpc.open('text'); return await Promise.all([text.echo({ text: 'a' }), text.echo({ text: 'b' })])`,
)
assert.equal(results.parallel.report.batches, 1)
assert.equal(results.parallel.report.openedStubs, 1)
results.pending = await runBody(
	`void rpc.open('text').slow({ text: 'pending' }); return { done: true }`,
)
assert.equal(results.pending.error.code, 'RUN_PENDING_CALLS')
assert.equal(results.pending.report.activeAtExit, 1)
assert.equal(results.pending.report.settled, 1)
assert.ok(results.pending.report.drainMs >= 100)
const controller = new AbortController()
const cancelled = runBody(`return await rpc.open('text').slow({ text: 'cancel' })`, {
	signal: controller.signal,
	onAdmission: () => setTimeout(() => controller.abort(), 50),
})
results.cancelled = await cancelled
assert.equal(results.cancelled.error.code, 'ABORTED')
assert.equal(results.cancelled.report.activeAtExit, 1)
assert.equal(results.cancelled.report.settled, 1)
results.output = await runBody(`return { count: 2, values: ['a', 'b'] }`)
assert.deepEqual(results.output.value, { count: 2, values: ['a', 'b'] })
results.undefined = await runBody(`return undefined`)
assert.equal(results.undefined.value, null)
results.badOutput = await runBody(`return 1n`)
assert.equal(results.badOutput.error.code, 'OUTPUT_ENCODING')
console.log(JSON.stringify(results, null, 2))
