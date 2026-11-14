import { BasePlugin, Plugin } from '@pluxel/core'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'
import { hashScriptSource, type ScriptArtifact } from '../src/agent'
import { createNodeScriptOwner } from '../src/agent/node'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'node-script-test',
		types: undefined as { input: Record<string, unknown>; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown }).count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'Expected a number', path: ['count'] }] }
		},
	},
}
let onChange: (() => Promise<void>) | undefined
@Plugin()
class Counter extends BasePlugin {
	readonly config = this.configs.use(schema)
	count = 2
	init() {
		this.configs.onUpdate(this.config, async ({ desired }) => {
			await onChange?.()
			this.count = desired.count
		})
	}
}
async function artifact(code: string): Promise<ScriptArtifact> {
	return {
		kind: 'artifact',
		format: 'pluxel-js-factory/1',
		code,
		sourceHash: await hashScriptSource(code),
		exportName: 'default',
	}
}
const subject = 'admin:alice'

it('executes a portable task on a real Host and creates fresh module locals on every run', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	const code = await artifact(`let runs = 0;
return {default: async (sdk, run) => sdk.Result.gen(async function* () {
  const selected = sdk.plugin(run.input);
  const before = yield* await selected.config.get();
  const count = before.config.count * 2;
  const changed = yield* await selected.config.patch({set: {count}}, {expectedManagedRevision: before.managedRevision});
  const actual = yield* await selected.config.get();
  return sdk.Result.ok({runs: ++runs, changed, actual});
})};`)
	for (const [id, expected] of [
		['first', 4],
		['second', 8],
	] as const) {
		await owner.executor.submit({ runId: id, code, input: Counter.nodeAddress() }, subject)
		const completed = await owner.executor.settled(id, subject)
		expect(completed).toMatchObject({
			state: 'succeeded',
			hostEpoch: owner.hostEpoch,
			value: {
				status: 'ok',
				value: {
					runs: 1,
					changed: { application: 'applied' },
					actual: { config: { count: expected } },
				},
			},
			revisions: {
				before: { configManagedRevision: expect.any(String) },
				after: { configManagedRevision: expect.any(String) },
			},
		})
	}
	await expect(
		owner.executor.submit(
			{ runId: 'wrong-hash', code: { ...code, sourceHash: '0'.repeat(64) } },
			subject,
		),
	).rejects.toMatchObject({ code: 'source_changed' })
	await expect(
		owner.executor.submit(
			{ runId: 'wrong-format', code: { ...code, format: 'other' as typeof code.format } },
			subject,
		),
	).rejects.toMatchObject({ code: 'artifact_incompatible' })
})

it('retains domain Err as a successful script value while defects and invalid payloads fail in their phase', async () => {
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	const domain = await artifact(
		'return {default: sdk => sdk.Result.err({code:"expected_rejection",message:"Domain result"})};',
	)
	await owner.executor.submit({ runId: 'domain', code: domain }, subject)
	const completed = await owner.executor.settled('domain', subject)
	expect(completed).toMatchObject({
		state: 'succeeded',
		value: { status: 'error', error: { code: 'expected_rejection', message: 'Domain result' } },
	})
	for (const [id, source, phase] of [
		['defect', 'return sdk.Result.ok(1).map(() => {throw new Error("author defect")})', 'execute'],
		[
			'payload',
			'return sdk.Result.err(new Error("Requires an explicit boundary codec"))',
			'encode',
		],
	] as const) {
		const code = await artifact(`return {default: sdk => {${source}}};`)
		await owner.executor.submit({ runId: id, code }, subject)
		expect(await owner.executor.settled(id, subject)).toMatchObject({ state: 'failed', phase })
	}
})

it('retains the original unknown defect in a native Result.gen failure receipt', async () => {
	await using host = await createHost({
		plugins: [],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	const code = await artifact(`return {default: sdk => sdk.Result.gen(async function* () {
  yield* await sdk.plugins.list();
  throw new Error("counter storage is unavailable");
})};`)
	await owner.executor.submit({ runId: 'generator-defect', code }, subject)
	expect(await owner.executor.settled('generator-defect', subject)).toMatchObject({
		state: 'failed',
		phase: 'execute',
		error: {
			code: 'execution_failed',
			message: 'generator body threw | counter storage is unavailable',
			stack: expect.stringContaining('Caused by: Error: counter storage is unavailable'),
		},
	})
})

it('preserves committed Host changes and versions after an execution or result-encoding failure', async () => {
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	await using owner = createNodeScriptOwner({ ctx: host.ctx })
	for (const [id, ending, count] of [
		['throw', 'throw new Error("after commit")', 5],
		['encode', 'return 1n', 9],
	] as const) {
		const code = await artifact(
			`return {default: async (sdk,run) => { await sdk.plugin(run.input).config.patch({set:{count:${count}}}); ${ending}; }};`,
		)
		await owner.executor.submit({ runId: id, code, input: Counter.nodeAddress() }, subject)
		const result = await owner.executor.settled(id, subject)
		expect(result).toMatchObject({
			state: 'failed',
			phase: id === 'throw' ? 'execute' : 'encode',
			revisions: { before: expect.any(Object), after: expect.any(Object) },
		})
		expect(await host.config.get(Counter.nodeAddress())).toMatchObject({
			config: { count },
			application: 'applied',
		})
	}
})

it('cancellation closes new SDK admission while an accepted mutation settles on the original Host', async () => {
	let entered!: () => void, release!: () => void
	const mutationEntered = new Promise<void>((resolve) => {
		entered = resolve
	})
	const mutationRelease = new Promise<void>((resolve) => {
		release = resolve
	})
	await using host = await createHost({
		plugins: [Counter],
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await host.startNode(Counter.nodeAddress())
	const owner = createNodeScriptOwner({ ctx: host.ctx })
	onChange = async () => {
		entered()
		await mutationRelease
	}
	try {
		const code = await artifact(
			'return {default:async(sdk,run)=>{await sdk.plugin(run.input).config.patch({set:{count:12}});return sdk.plugins.list();}};',
		)
		await owner.executor.submit({ runId: 'cancel', code, input: Counter.nodeAddress() }, subject)
		await mutationEntered
		expect(owner.executor.cancel('cancel', subject)).toMatchObject({ state: 'cancelling' })
		release()
		const cancelled = await owner.executor.settled('cancel', subject)
		expect(cancelled).toMatchObject({
			state: 'cancelled',
			revisions: { after: expect.any(Object) },
		})
		expect(cancelled).not.toHaveProperty('executionError')
		expect(await host.config.get(Counter.nodeAddress())).toMatchObject({
			config: { count: 12 },
			application: 'applied',
		})
		await owner.close()
		await expect(
			owner.executor.submit({ runId: 'after-close', code }, subject),
		).rejects.toMatchObject({ code: 'owner_closed' })
	} finally {
		release()
		onChange = undefined
		await owner.close()
	}
})
