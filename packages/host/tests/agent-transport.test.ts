import { newMessagePortRpcSession, RpcTarget } from 'capnweb'
import { expect, it } from 'vitest'
import {
	SCRIPT_PROTOCOL,
	ScriptExecutionError,
	ScriptExecutor,
	scriptFailure,
	type ScriptFailure,
} from '../src/agent-runtime'
import {
	connectScriptControl,
	createScriptControlClient,
	createScriptControlTarget,
	type ScriptConnectionTarget,
	type ScriptControlTarget,
} from '../src/agent/transport'

function fixture() {
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const executor = new ScriptExecutor({
		instanceId: 'owner',
		async execute(_input, run) {
			run.phase('execute')
			entered.resolve()
			await release.promise
			return { completed: true }
		},
	})
	let authorized = true
	const target = createScriptControlTarget({
		executor,
		subject: 'alice',
		assertAuthorized() {
			if (!authorized) throw new ScriptExecutionError('unauthorized', 'Authorization withdrawn')
		},
		describe: () => ({}),
	})
	const request = { protocol: SCRIPT_PROTOCOL, instanceId: 'owner', runId: 'run' }
	return {
		executor,
		target,
		request,
		release,
		revoke() {
			authorized = false
		},
		async start() {
			await executor.submit(
				{
					runId: 'run',
					code: {
						kind: 'project',
						file: '/task.ts',
						exportName: 'default',
						sourceHash: 'a'.repeat(64),
					},
				},
				'alice',
			)
			await entered.promise
		},
		async [Symbol.asyncDispose]() {
			release.resolve()
			target[Symbol.dispose]()
			await executor.close()
		},
	}
}

it('returns a pending snapshot at the wait bound and a settled snapshot as soon as available', async () => {
	await using scope = fixture()
	await scope.start()
	expect(await scope.target.result({ ...scope.request, waitMs: 1 })).toMatchObject({
		ok: true,
		value: { state: 'running' },
	})
	const pending = scope.target.result({ ...scope.request, waitMs: 1000 })
	scope.release.resolve()
	expect(await pending).toMatchObject({
		ok: true,
		value: { state: 'succeeded', value: { completed: true } },
	})
})

it('rejects invalid wait bounds and unknown request fields without changing the run', async () => {
	await using scope = fixture()
	await scope.start()
	for (const waitMs of [-1, 1001, 0.5, null, '1']) {
		expect(await scope.target.result({ ...scope.request, waitMs })).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' },
		})
	}
	expect(await scope.target.result({ ...scope.request, extra: true })).toMatchObject({
		ok: false,
		error: { code: 'invalid_request' },
	})
	expect(scope.executor.result('run', 'alice').state).toBe('running')
})

it('rechecks authorization after waiting and hides other subjects runs', async () => {
	await using scope = fixture()
	await scope.start()
	await expect(
		scope.executor.settled('run', 'bob', { timeoutMs: 1000, signal: new AbortController().signal }),
	).rejects.toMatchObject({ code: 'run_not_found' })
	const pending = scope.target.result({ ...scope.request, waitMs: 1000 })
	scope.revoke()
	scope.release.resolve()
	expect(await pending).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
})

it('drops a disposed session wait while the original run can settle and be queried', async () => {
	await using scope = fixture()
	await scope.start()
	const pending = scope.target.result({ ...scope.request, waitMs: 1000 })
	scope.target[Symbol.dispose]()
	expect(await pending).toMatchObject({ ok: false, error: { code: 'session_closed' } })
	expect(scope.executor.result('run', 'alice').state).toBe('running')
	scope.release.resolve()
	expect(await scope.executor.settled('run', 'alice')).toMatchObject({
		state: 'succeeded',
		value: { completed: true },
	})
})

/** Exercise native RPC payload lifetimes and decoding without opening a network listener. */
function failurePeer(failure: unknown) {
	class FailureTarget extends RpcTarget {
		connect() {
			return { ok: false, error: failure }
		}
		describe() {
			return { ok: false, error: failure }
		}
	}
	const { port1, port2 } = new MessageChannel()
	const server = newMessagePortRpcSession(port1, new FailureTarget())
	const remote = newMessagePortRpcSession<ScriptConnectionTarget & ScriptControlTarget>(port2)
	return {
		remote,
		[Symbol.dispose]() {
			remote[Symbol.dispose]()
			server[Symbol.dispose]()
			port1.close()
			port2.close()
		},
	}
}

it('restores valid structured failures from connection and operation responses received by Capn Web', async () => {
	const failure: ScriptFailure = {
		code: 'persistence_failed',
		message: 'Write outcome is unknown',
		details: { code: 'persistence_failed', message: 'Write outcome is unknown', state: 'unknown' },
		hint: 'Read the original receipt',
		context: { path: '$.items[0].handle', valueKind: 'class instance' },
		diagnostics: [
			{ file: '/project/task.ts', line: 3, column: 7, code: 2551, message: 'Unknown member' },
		],
		stack: 'ScriptExecutionError: Write outcome is unknown\n    at /remote/task.ts:3:7',
	}
	using peer = failurePeer(failure)
	using control = createScriptControlClient(peer.remote.dup(), { instanceId: 'owner' })
	for (const receive of [() => connectScriptControl(peer.remote, {}), () => control.describe()]) {
		const error = await receive().catch((cause) => cause)
		expect(error).toBeInstanceOf(ScriptExecutionError)
		expect(error).toMatchObject(failure)
		expect(scriptFailure(error)).toMatchObject(failure)
		expect(error.context).not.toBe(failure.context)
	}
})

it.each([
	{ name: 'hint', fields: { hint: 42 } },
	{ name: 'stack', fields: { stack: [] } },
	{ name: 'details', fields: { details: { code: 'failure', message: false } } },
	{ name: 'diagnostics collection', fields: { diagnostics: {} } },
	{
		name: 'diagnostic code',
		fields: { diagnostics: [{ code: '2551', message: 'Unknown member' }] },
	},
	{ name: 'diagnostic message', fields: { diagnostics: [{ code: 2551, message: 42 }] } },
	{
		name: 'diagnostic file',
		fields: { diagnostics: [{ code: 2551, message: 'Unknown member', file: false }] },
	},
	{
		name: 'diagnostic line',
		fields: { diagnostics: [{ code: 2551, message: 'Unknown member', line: 0 }] },
	},
	{
		name: 'diagnostic column',
		fields: { diagnostics: [{ code: 2551, message: 'Unknown member', column: -1 }] },
	},
])('rejects malformed $name from native connection and operation responses', async ({ fields }) => {
	using peer = failurePeer({ code: 'execution_failed', message: 'Original failure', ...fields })
	using control = createScriptControlClient(peer.remote.dup(), { instanceId: 'owner' })
	for (const receive of [() => connectScriptControl(peer.remote, {}), () => control.describe()]) {
		const error = await receive().catch((cause) => cause)
		expect(error).toBeInstanceOf(ScriptExecutionError)
		expect(error).toMatchObject({ code: 'protocol_mismatch' })
		expect(scriptFailure(error)).toMatchObject({ code: 'protocol_mismatch' })
	}
})
