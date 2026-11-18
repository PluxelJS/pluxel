import { describe, expect, it, vi } from 'vitest'
import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { Ok, Panic, Result, TaggedError } from '@pluxel/core/better-result'
import { snapshotScriptResult } from '../src/agent/result-codec'
import { createPluginControlReference } from '../src/control-reference'
import {
	ScriptExecutor,
	ScriptExecutionError,
	ScriptError,
	scriptFailure,
	snapshotJson,
	type ScriptSubmission,
} from '../src/agent-runtime'

const subject = 'admin:alice'

@Plugin({ forkable: true })
class JsonAddressOwner extends BasePlugin {}

function input(runId: string, extra: Partial<ScriptSubmission> = {}): ScriptSubmission {
	return {
		runId,
		code: {
			kind: 'project',
			file: '/project/script.ts',
			exportName: 'default',
			sourceHash: 'a'.repeat(64),
		},
		...extra,
	}
}
function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((finish) => {
		resolve = finish
	})
	return { promise, resolve }
}

describe('script execution owner', () => {
	it('settles invalid custom SDK error details with an explicit encoding diagnostic', async () => {
		await using executor = new ScriptExecutor({
			instanceId: 'owner',
			async execute() {
				throw new ScriptError({
					code: 'persistence_failed',
					state: 'unknown',
					message: 'Write outcome unknown',
					// Simulate a custom caller violating the failure DTO contract.
					report: new Date() as never,
				})
			},
		})
		await executor.submit(input('invalid-details'), subject)
		const result = await executor.settled('invalid-details', subject)
		expect(result).toMatchObject({
			state: 'failed',
			error: {
				code: 'persistence_failed',
				message: expect.stringContaining('Failure details could not be encoded'),
			},
		})
		expect(result).not.toHaveProperty('error.details')
	})
	it('rejects oversized or nonportable input before execution with input diagnostics', async () => {
		const execute = vi.fn(async () => null)
		await using executor = new ScriptExecutor({ instanceId: 'owner', execute })
		await expect(
			executor.submit(input('large', { input: 'x'.repeat(1024 * 1024) }), subject),
		).rejects.toMatchObject({ code: 'input_too_large' })
		await expect(
			executor.submit(input('behavior', { input: { items: [new Date()] } as never }), subject),
		).rejects.toMatchObject({
			code: 'invalid_input',
			context: { path: '$.items[0]', valueKind: 'class instance' },
		})
		expect(execute).not.toHaveBeenCalled()
	})
	it('rechecks authorization after asynchronous hashing and before committing admission', async () => {
		const hashing = deferred(),
			release = deferred<ArrayBuffer>()
		const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => {
			hashing.resolve()
			return release.promise
		})
		const execute = vi.fn(async () => null)
		await using executor = new ScriptExecutor({ instanceId: 'owner', execute })
		let authorized = true
		try {
			const request = executor.submit(input('withdrawn'), subject, () => {
				if (!authorized)
					throw new ScriptExecutionError('unauthorized', 'Authorization was withdrawn')
			})
			await hashing.promise
			authorized = false
			executor.abortSubject(subject)
			release.resolve(new ArrayBuffer(32))
			await expect(request).rejects.toMatchObject({ code: 'unauthorized' })
			expect(execute).not.toHaveBeenCalled()
			expect(() => executor.result('withdrawn', subject)).toThrow(
				expect.objectContaining({ code: 'run_not_found' }),
			)
		} finally {
			release.resolve(new ArrayBuffer(32))
			digest.mockRestore()
		}
	})
	it('controls HMR independently while a script waits and replacement cancels only scripts', async () => {
		const entered = deferred(),
			release = deferred()
		const control = vi.fn(async () => {
			executor.abortScripts('host_changed')
			return { mode: 'paused' }
		})
		const executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async () => {
				entered.resolve()
				await release.promise
			},
			control,
		})
		try {
			await executor.submit(input('blocked'), subject)
			await entered.promise
			await executor.submit(input('queued'), subject)
			await executor.submitControl({ runId: 'apply', action: 'apply' }, subject)
			expect(await executor.settled('apply', subject)).toMatchObject({
				kind: 'hmr',
				action: 'apply',
				state: 'succeeded',
				value: { mode: 'paused' },
			})
			expect(executor.result('blocked', subject)).toMatchObject({
				state: 'cancelling',
				cancelReason: 'host_changed',
			})
			expect(executor.result('queued', subject)).toMatchObject({ state: 'cancelled' })
			await executor.submitControl({ runId: 'apply', action: 'apply' }, subject)
			expect(control).toHaveBeenCalledTimes(1)
			await expect(
				executor.submitControl({ runId: 'apply', action: 'resume' }, subject),
			).rejects.toMatchObject({ code: 'request_conflict' })
			await expect(executor.submit(input('apply'), subject)).rejects.toMatchObject({
				code: 'request_conflict',
			})
		} finally {
			release.resolve()
			await executor.close()
		}
	})
	it('keeps accepted code until real settlement and cancels queued calls without executing them', async () => {
		const entered = deferred(),
			release = deferred()
		const starts: string[] = []
		const executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async (request) => {
				starts.push(request.runId)
				if (request.runId === 'first') {
					entered.resolve()
					await release.promise
				}
				return request.runId
			},
		})
		try {
			await executor.submit(input('first'), subject)
			await entered.promise
			for (let index = 0; index < 16; index++)
				await executor.submit(input(`queued-${index}`), subject)
			await expect(executor.submit(input('overflow'), subject)).rejects.toMatchObject({
				code: 'queue_full',
			})
			expect(executor.cancel('queued-0', subject)).toMatchObject({
				state: 'cancelled',
				phase: 'admission',
			})
			expect(executor.cancel('first', subject)).toMatchObject({ state: 'cancelling' })
			expect(executor.result('queued-1', subject)).toMatchObject({ state: 'queued' })
			expect(starts).toEqual(['first'])
			release.resolve()
			expect(await executor.settled('first', subject)).toMatchObject({ state: 'cancelled' })
			expect(await executor.settled('queued-1', subject)).toMatchObject({
				state: 'succeeded',
				value: 'queued-1',
			})
		} finally {
			release.resolve()
			await executor.close()
		}
	})
	it('deduplicates concurrent delivery, retains original subject and permits disconnected querying', async () => {
		const execute = vi.fn(async () => ({ count: 1 }))
		await using executor = new ScriptExecutor({ instanceId: 'owner', execute })
		await Promise.all([
			executor.submit(input('same'), subject),
			executor.submit(input('same'), subject),
		])
		const result = await executor.settled('same', subject)
		expect(result).toMatchObject({
			state: 'succeeded',
			value: { count: 1 },
			requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
		})
		expect(await executor.submit(input('same'), subject)).toEqual(result)
		expect(execute).toHaveBeenCalledTimes(1)
		await expect(
			executor.submit(input('same', { input: { changed: true } }), subject),
		).rejects.toMatchObject({ code: 'request_conflict' })
		expect(() => executor.result('same', 'admin:bob')).toThrow(
			expect.objectContaining({ code: 'run_not_found' }),
		)
		expect(() => executor.cancel('same', 'admin:bob')).toThrow(
			expect.objectContaining({ code: 'run_not_found' }),
		)
		await expect(executor.submit(input('same'), 'admin:bob')).rejects.toMatchObject({
			code: 'run_not_found',
		})
	})
	it.each(['none', 'finally', 'using', 'scope_closed', 'cancelled', 'lookalike'] as const)(
		'retains timeout and actual %s failure until code settles',
		async (failure) => {
			const entered = deferred(),
				aborted = deferred(),
				release = deferred()
			const executor = new ScriptExecutor({
				instanceId: 'owner',
				execute: async (_request, run) => {
					run.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
					entered.resolve()
					await release.promise
					run.phase('cleanup')
					if (failure === 'scope_closed' || failure === 'cancelled')
						throw new ScriptError({ code: failure, message: 'Controlled cancellation' })
					if (failure === 'lookalike')
						throw Object.assign(new Error('resource cleanup failed'), { code: 'scope_closed' })
					if (failure === 'finally') throw new Error('resource cleanup failed')
					if (failure === 'using') {
						using resource = {
							[Symbol.dispose]() {
								throw new Error('resource cleanup failed')
							},
						}
						void resource
						run.signal.throwIfAborted()
					}
					return null
				},
			})
			try {
				await executor.submit(input('timeout', { timeoutMs: 50 }), subject)
				await entered.promise
				await aborted.promise
				expect(executor.result('timeout', subject)).toMatchObject({
					state: 'cancelling',
					cancelReason: 'timeout',
				})
				release.resolve()
				const result = await executor.settled('timeout', subject)
				expect(result).toMatchObject({ state: 'cancelled', error: { code: 'timeout' } })
				const expectedFailure = {
					executionError: { message: expect.stringContaining('resource cleanup failed') },
				}
				const independentFailure = ['finally', 'using', 'lookalike'].includes(failure)
				expect(result).toMatchObject(independentFailure ? expectedFailure : {})
				expect('executionError' in result).toBe(independentFailure)
			} finally {
				release.resolve()
				await executor.close()
			}
		},
	)
	it('closes admission and drains actual active work before owner close completes', async () => {
		const entered = deferred(),
			release = deferred()
		const executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async () => {
				entered.resolve()
				await release.promise
			},
		})
		await executor.submit(input('active'), subject)
		await entered.promise
		await executor.submit(input('queued'), subject)
		let closed = false
		const close = (async () => {
			await executor.close()
			closed = true
		})()
		expect(executor.result('queued', subject)).toMatchObject({ state: 'cancelled' })
		await expect(executor.submit(input('later'), subject)).rejects.toMatchObject({
			code: 'owner_closed',
		})
		expect(closed).toBe(false)
		release.resolve()
		await close
		expect(closed).toBe(true)
	})
	it('retains tombstones after result eviction and never replays an effect after encode failure', async () => {
		let writes = 0
		await using executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async (request) => {
				writes++
				return request.runId === 'write' ? 1n : null
			},
		})
		await executor.submit(input('write'), subject)
		expect(await executor.settled('write', subject)).toMatchObject({
			state: 'failed',
			phase: 'encode',
			error: { code: 'result_not_serializable' },
		})
		await executor.submit(input('write'), subject)
		expect(writes).toBe(1)
		for (let index = 0; index < 100; index++) {
			await executor.submit(input(`run-${index}`), subject)
			await executor.settled(`run-${index}`, subject)
		}
		await expect(executor.submit(input('write'), subject)).rejects.toMatchObject({
			code: 'result_expired',
		})
		expect(writes).toBe(101)
	})
})

describe('portable result encoding', () => {
	it('reports exact JSON paths and value categories without evaluating author behavior', () => {
		const getter = vi.fn(() => 1)
		const accessor = Object.defineProperty({}, 'count', { enumerable: true, get: getter })
		const domain = new Date()
		const toJSON = vi.spyOn(domain, 'toJSON')
		const circular: Record<string, unknown> = {}
		circular.parent = circular
		const cases = [
			{
				encode: () => snapshotJson({ items: [{ 'metric.value': 1n }] }),
				path: '$.items[0]["metric.value"]',
				valueKind: 'bigint',
			},
			{
				encode: () => snapshotScriptResult(Result.err({ entries: [{ count: 1n }] })),
				path: '$.error.entries[0].count',
				valueKind: 'bigint',
			},
			{
				encode: () => snapshotScriptResult(Result.ok({ box: accessor })),
				path: '$.value.box.count',
				valueKind: 'accessor',
			},
			{
				encode: () => snapshotJson({ record: { createdAt: domain } }),
				path: '$.record.createdAt',
				valueKind: 'class instance',
			},
			{
				encode: () => snapshotJson({ selected: circular }),
				path: '$.selected.parent',
				valueKind: 'circular reference',
			},
			{
				encode: () => snapshotJson({ meta: { [Symbol('hidden')]: true } }),
				path: '$.meta[Symbol(hidden)]',
				valueKind: 'symbol key',
			},
		]
		for (const { encode, path, valueKind } of cases) {
			let failure: unknown
			try {
				encode()
			} catch (error) {
				failure = error
			}
			expect(failure).toMatchObject({
				code: 'result_not_serializable',
				message: expect.stringContaining(path),
				context: { path, valueKind },
			})
			expect(scriptFailure(failure)).toMatchObject({
				code: 'result_not_serializable',
				context: { path, valueKind },
			})
		}
		expect(getter).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
	})

	it('retains known receiver error fields and bounds compiler diagnostics without reading accessors', () => {
		const context = { path: '$.items[1].id', valueKind: 'bigint' }
		const diagnostic = {
			file: '/project/script.ts',
			line: 3,
			column: 4,
			code: 2551,
			message: 'Typo',
		}
		const receiver = new ScriptExecutionError('typecheck_failed', 'Check failed', {
			context,
			hint: 'Correct the selected field',
			diagnostics: Array.from({ length: 101 }, () => diagnostic),
		})
		const projected = scriptFailure(receiver)
		expect(projected).toMatchObject({
			code: 'typecheck_failed',
			context,
			hint: 'Correct the selected field',
		})
		expect(projected.diagnostics).toHaveLength(100)
		expect(projected.diagnostics?.[0]).toEqual(diagnostic)
		context.path = 'changed after projection'
		diagnostic.message = 'changed after projection'
		expect(projected.context).toEqual({ path: '$.items[1].id', valueKind: 'bigint' })
		expect(projected.diagnostics?.[0]?.message).toBe('Typo')
		const details = {
			code: 'persistence_failed' as const,
			message: 'Write outcome is unknown',
			state: 'unknown' as const,
		}
		expect(
			scriptFailure(new ScriptExecutionError(details.code, details.message, { details })),
		).toMatchObject({
			details,
		})
		const getter = vi.fn(() => [diagnostic])
		const accessor = Object.defineProperty(new Error('Do not inspect behavior'), 'diagnostics', {
			get: getter,
		})
		expect(scriptFailure(accessor)).not.toHaveProperty('diagnostics')
		expect(getter).not.toHaveBeenCalled()
	})

	it('settles a failed receipt without reading accessors in nested Error metadata', async () => {
		const getter = vi.fn(() => {
			throw new Error('Error metadata getter must not run')
		})
		const message = Object.defineProperty(new Error('hidden message'), 'message', { get: getter })
		const aggregate = Object.defineProperty(new AggregateError([], 'aggregate'), 'errors', {
			get: getter,
		})
		const suppressed = Object.defineProperties(new SuppressedError(null, null, 'suppressed'), {
			error: { get: getter },
			suppressed: { get: getter },
		})
		const items = Object.defineProperty([], '0', { get: getter })
		const indexed = new AggregateError([], 'indexed aggregate')
		Object.defineProperty(indexed, 'errors', { value: items })
		const causes = [message, aggregate, suppressed, indexed]
		await using executor = new ScriptExecutor({
			instanceId: 'owner',
			execute: async (request, run) => {
				run.phase('execute')
				throw new Error('workflow failed', { cause: causes[Number(request.input)] })
			},
		})
		for (let index = 0; index < causes.length; index++) {
			const id = `metadata-${index}`
			await executor.submit(input(id, { input: index }), subject)
			expect(await executor.settled(id, subject)).toMatchObject({
				state: 'failed',
				phase: 'execute',
				error: { code: 'execution_failed', message: expect.stringContaining('workflow failed | ') },
			})
		}
		expect(scriptFailure(new Error('wrapper', { cause: message })).message).toBe('wrapper | Error')
		expect(getter).not.toHaveBeenCalled()
	})

	it('reports bounded Error causes without evaluating cause accessors or domain serialization', () => {
		const cause = new Error('underlying business failure')
		const error = new Error('operation failed', { cause })
		expect(scriptFailure(error)).toMatchObject({
			code: 'execution_failed',
			message: 'operation failed | underlying business failure',
		})
		cause.cause = error
		expect(scriptFailure(error).message).toContain('[circular error]')
		const combined = new Error('wrapper', {
			cause: new AggregateError(
				[new SuppressedError(new Error('operation'), new Error('cleanup'), 'disposal')],
				'aggregate',
			),
		})
		expect(scriptFailure(combined).message).toBe(
			'wrapper | aggregate | disposal | operation | cleanup',
		)
		const getter = vi.fn(() => cause)
		const accessor = Object.defineProperty(new Error('no accessor evaluation'), 'cause', {
			get: getter,
		})
		expect(scriptFailure(accessor).message).toBe('no accessor evaluation')
		expect(getter).not.toHaveBeenCalled()
		const toJSON = vi.fn(() => 'must not serialize')
		expect(scriptFailure(new Error('object cause', { cause: { toJSON } })).message).toBe(
			'object cause | Non-Error value',
		)
		expect(toJSON).not.toHaveBeenCalled()
		let chain = new Error('original defect')
		for (let index = 0; index < 100; index++) chain = new Error(`layer ${index}`, { cause: chain })
		expect(scriptFailure(chain).message).not.toContain('original defect')
		expect(scriptFailure(new Error('outer', { cause: 'x'.repeat(10_000) })).message.length).toBe(
			4096,
		)
	})

	it('retains explicitly supplied diagnostic data without copying arbitrary Error properties', () => {
		const context = { root: '/original/project', instanceId: 'original-owner' }
		const error = Object.assign(new Error('Owner is unavailable'), {
			code: 'dev_unavailable',
			password: 'not diagnostic data',
		})
		const failure = scriptFailure(error, 'query_failed', {
			hint: 'Query the original receipt',
			context,
		})
		expect(failure).toMatchObject({
			code: 'dev_unavailable',
			message: 'Owner is unavailable',
			hint: 'Query the original receipt',
			context,
		})
		expect(failure).not.toHaveProperty('password')
		expect(failure.context).not.toBe(context)
		expect(
			scriptFailure('Unknown owner', 'query_failed', { hint: 'x'.repeat(5000) }).hint,
		).toHaveLength(4096)
	})

	it('uses the shared native codec only for genuine top-level Results', () => {
		const json = {
			'~standard': {
				version: 1 as const,
				vendor: 'native-result-test',
				validate: (value: unknown) => ({ value: snapshotJson(value) }),
			},
		}
		const native = Result.codec({
			serialize: { ok: json, err: json },
			deserialize: { ok: json, err: json },
		})
		for (const result of [
			Result.ok({ count: 3 }),
			Result.err({ code: 'expected_rejection', message: 'Domain result' }),
			Result.ok(),
		])
			expect(snapshotScriptResult(result)).toEqual(native.serialize(result).unwrap())
		const ordinary = { status: 'ok', value: { ordinary: true } }
		expect(snapshotScriptResult(ordinary)).toEqual(ordinary)
		expect(snapshotScriptResult({ status: 'error', error: 'ordinary JSON' })).toEqual({
			status: 'error',
			error: 'ordinary JSON',
		})
		expect(() => snapshotJson(Result.ok(1))).toThrow('plain JSON')
		expect(() => snapshotScriptResult({ nested: Result.ok(1) })).toThrow('plain JSON')
		class ForeignOk {
			readonly status = 'ok'
			readonly value = 1
		}
		class CustomOk extends Ok<number> {}
		expect(() => snapshotScriptResult(new ForeignOk())).toThrow('plain JSON')
		expect(() => snapshotScriptResult(new CustomOk(1))).toThrow('plain JSON')
	})

	it('never evaluates Result or payload accessors and rejects unknown domain classes', () => {
		const getter = vi.fn(() => 1)
		const invalid = Object.defineProperty(Result.ok(1), 'value', { get: getter })
		expect(() => snapshotScriptResult(invalid)).toThrow('accessors')
		const accessor = Object.defineProperty({}, 'count', { enumerable: true, get: getter })
		expect(() => snapshotScriptResult(Result.ok(accessor))).toThrow('accessors')
		class DomainError extends TaggedError('DomainError')<{ id: string }> {}
		const domain = new DomainError({ id: 'counter' })
		const toJSON = vi.spyOn(domain, 'toJSON')
		expect(() => snapshotScriptResult(Result.err(domain))).toThrow('plain JSON')
		expect(() => snapshotScriptResult(Result.err(new Error('plain Error')))).toThrow('plain JSON')
		expect(getter).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
	})

	it('projects original class and generated node addresses as portable identities at any payload depth', () => {
		const generated = createPluginControlReference({
			format: 2,
			definition: JsonAddressOwner.address(),
			contracts: { config: null, instance: `sha256:${'a'.repeat(64)}` },
		})
		for (const address of [
			JsonAddressOwner.nodeAddress(),
			JsonAddressOwner.nodeAddress('east'),
			generated.nodeAddress(),
			generated.nodeAddress('east'),
		]) {
			const pure = parsePluginNodeAddress(address)
			expect(snapshotJson(address)).toEqual(pure)
			expect(snapshotJson({ items: [{ owner: address }] })).toEqual({ items: [{ owner: pure }] })
			expect(snapshotScriptResult(Result.ok(address))).toEqual({ status: 'ok', value: pure })
			expect(snapshotScriptResult(Result.err({ code: 'selected_target', owner: address }))).toEqual(
				{
					status: 'error',
					error: { code: 'selected_target', owner: pure },
				},
			)
		}
	})

	it('rejects detached, foreign and unrelated symbol data without evaluating evidence accessors', () => {
		const address = JsonAddressOwner.nodeAddress()
		const pure = parsePluginNodeAddress(address)
		const marker = Symbol.for('@pluxel/core/plugin-node-address-evidence')
		const getter = vi.fn(() => Object.freeze({}))
		for (const invalid of [
			{ ...address },
			Object.assign({}, address),
			{ ...pure, [marker]: Object.freeze({}) },
			Object.defineProperty({ ...pure }, marker, { enumerable: true, get: getter }),
		]) {
			expect(() => snapshotJson({ owner: invalid })).toThrow(
				expect.objectContaining({ code: 'result_not_serializable' }),
			)
			expect(() => snapshotScriptResult(Result.ok(invalid))).toThrow('copied or detached')
		}
		expect(getter).not.toHaveBeenCalled()
		expect(() => snapshotJson({ ...pure, [Symbol('other')]: true })).toThrow(
			expect.objectContaining({ code: 'result_not_serializable' }),
		)
	})

	it('charges registered address fields once under the ordinary JSON depth, node and byte budgets', () => {
		const address = createPluginControlReference({
			format: 2,
			definition: {
				entry: { kind: 'package-root', packageName: '@fixture/json-budget' },
				exportName: 'Counter',
			},
			contracts: { config: null, instance: `sha256:${'b'.repeat(64)}` },
		}).nodeAddress()
		const pure = parsePluginNodeAddress(address)
		expect(snapshotJson(address, { depth: 3, nodes: 7 })).toEqual(pure)
		for (const limits of [{ depth: 2 }, { nodes: 6 }, { bytes: 1 }]) {
			for (const value of [address, pure])
				expect(() => snapshotJson(value, limits)).toThrow(
					expect.objectContaining({ code: 'result_too_large' }),
				)
		}
	})

	it('preserves unknown descriptor-trap TypeErrors through JSON and native Result encoding', () => {
		const defect = new TypeError('Unexpected descriptor trap defect')
		const payload = new Proxy(
			{},
			{
				getOwnPropertyDescriptor: () => {
					throw defect
				},
			},
		)
		let jsonFailure: unknown
		try {
			snapshotJson(payload)
		} catch (error) {
			jsonFailure = error
		}
		expect(jsonFailure).toBe(defect)
		let resultFailure: unknown
		try {
			snapshotScriptResult(Result.ok(payload))
		} catch (error) {
			resultFailure = error
		}
		expect(resultFailure).toBeInstanceOf(Panic)
		expect((resultFailure as Error).cause).toBe(defect)
	})

	it('preserves native codec defects and the complete Result envelope budget', () => {
		expect(() => snapshotScriptResult(Result.ok('x'.repeat(1024 * 1024 - 2)))).toThrow(
			expect.objectContaining({ code: 'result_too_large' }),
		)
		expect(() => snapshotScriptResult(Result.err(1n))).toThrow(
			expect.objectContaining({ code: 'result_not_serializable' }),
		)
		const defect = new Error('Unexpected proxy defect')
		const payload = new Proxy(
			{},
			{
				ownKeys: () => {
					throw defect
				},
			},
		)
		const encode = () => snapshotScriptResult(Result.ok(payload))
		expect(encode).toThrow(Panic)
		expect(encode).toThrow(expect.objectContaining({ cause: defect }))
	})

	it('copies native JSON data without evaluating accessors or toJSON', () => {
		const source: { nested: { count: number }; absent: undefined; values: undefined[] } = {
			nested: { count: 1 },
			absent: undefined,
			values: [undefined],
		}
		const copy = snapshotJson(source)
		source.nested.count = 2
		expect(copy).toEqual({ nested: { count: 1 }, values: [null] })
		const getter = vi.fn(() => 1),
			toJSON = vi.fn(() => 1)
		expect(() =>
			snapshotJson(Object.defineProperty({}, 'value', { enumerable: true, get: getter })),
		).toThrow('accessors')
		expect(() => snapshotJson({ toJSON })).toThrow('Return JSON')
		expect(getter).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
		const dangerousKey = snapshotJson(JSON.parse('{"__proto__":{"value":1}}'))
		expect(Object.getPrototypeOf(dangerousKey)).toBe(Object.prototype)
		expect(Object.getOwnPropertyDescriptor(dangerousKey, '__proto__')?.value).toEqual({ value: 1 })
	})
	it('rejects cycles, capabilities, lossy numbers and oversized results', () => {
		const cycle: unknown[] = []
		cycle.push(cycle)
		expect(() => snapshotJson(cycle)).toThrow('Circular')
		expect(() => snapshotJson(new Date())).toThrow('plain JSON')
		expect(() => snapshotJson(NaN)).toThrow('Return JSON')
		expect(() => snapshotJson('x'.repeat(1024 * 1024))).toThrow('1 MiB')
	})
})
