import { cli as gunshiCli } from 'gunshi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
	SCRIPT_ARTIFACT_FORMAT,
	ScriptExecutionError,
	scriptRequestHash,
	type ScriptSubmission,
} from '@pluxel/host/agent/runtime'
import { decodeScriptReceipt, encodeScriptReceipt, type ScriptReceipt } from '../src/script/receipt'
import { scriptCommand } from '../src/commands/script'

const mocks = vi.hoisted(() => ({ connect: vi.fn(), compile: vi.fn(), credentials: vi.fn() }))
vi.mock('../src/script/client', () => ({
	connectScriptTarget: mocks.connect,
	readScriptCredentials: mocks.credentials,
}))
vi.mock('../src/capability-loader', () => ({
	loadOfficialCapability: async () => ({ compileScript: mocks.compile }),
}))

const original: ScriptReceipt = {
	version: 3,
	connection: { kind: 'remote', endpoint: 'https://host.test/' },
	instanceId: 'owner',
	runId: 'original-run',
	requestHash: 'a'.repeat(64),
}
let events: Record<string, unknown>[] = []
beforeEach(() => {
	mocks.connect.mockReset()
	mocks.compile.mockReset().mockResolvedValue({
		kind: 'artifact',
		format: SCRIPT_ARTIFACT_FORMAT,
		code: 'code',
		sourceHash: 'a'.repeat(64),
		exportName: 'default',
	})
	mocks.credentials.mockReset().mockResolvedValue({})
	events = []
	vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
		events.push(JSON.parse(String(text)))
		return true
	})
})
afterEach(() => {
	process.exitCode = 0
	vi.restoreAllMocks()
})

function connection(control: object) {
	return {
		control,
		description: { instanceId: original.instanceId, codeKinds: ['artifact'] },
		[Symbol.dispose]: vi.fn(),
	}
}
async function command(args: string[]) {
	const output: string[] = []
	const log = vi.spyOn(console, 'log').mockImplementation((text) => output.push(String(text)))
	try {
		await gunshiCli(['script', ...args], { run() {} }, { subCommands: { script: scriptCommand } })
		return output.map((text) => JSON.parse(text))
	} finally {
		log.mockRestore()
	}
}

it('prints the same run envelope and stages for uploaded code, preserving a returned domain Err', async () => {
	const submit = vi.fn(async (input: ScriptSubmission) => ({
		instanceId: original.instanceId,
		runId: input.runId,
		requestHash: await scriptRequestHash(input),
		state: 'succeeded',
		value: { status: 'error', error: { code: 'expected_business_failure' } },
	}))
	mocks.connect.mockResolvedValue(connection({ submit }))
	const output = await command(['run', 'task.ts', '--endpoint', 'https://host.test/'])
	expect(output).toHaveLength(1)
	expect(output[0]).toMatchObject({
		ok: true,
		value: { receipt: expect.any(String), run: { state: 'succeeded', value: { status: 'error' } } },
	})
	expect(process.exitCode).toBe(0)
	expect(events).toEqual([
		{ stage: 'prepared', receipt: output[0].value.receipt },
		{ stage: 'accepted', receipt: output[0].value.receipt },
	])
	expect(decodeScriptReceipt(output[0].value.receipt)).toMatchObject({
		connection: original.connection,
		instanceId: original.instanceId,
		runId: output[0].value.run.runId,
		requestHash: output[0].value.run.requestHash,
	})
	expect(submit).toHaveBeenCalledTimes(1)
})

it('retains a prepared receipt after a lost admission response and queries it without a new submission', async () => {
	let accepted: Record<string, unknown> | undefined
	const submit = vi.fn(async (input: ScriptSubmission) => {
		accepted = {
			instanceId: original.instanceId,
			runId: input.runId,
			requestHash: await scriptRequestHash(input),
			state: 'succeeded',
			value: { changed: true },
		}
		throw new Error('Connection lost after admission')
	})
	const result = vi.fn(async () => accepted)
	mocks.connect.mockResolvedValue(connection({ submit, result }))
	const [failure] = await command(['run', 'task.ts', '--endpoint', 'https://host.test/'])
	expect(failure).toMatchObject({
		ok: false,
		error: { code: 'outcome_unknown', receipt: expect.any(String) },
	})
	expect(events).toEqual([{ stage: 'prepared', receipt: failure.error.receipt }])
	const [queried] = await command(['result', failure.error.receipt])
	expect(queried).toEqual({ ok: true, value: { receipt: failure.error.receipt, run: accepted } })
	expect(submit).toHaveBeenCalledTimes(1)
	expect(result).toHaveBeenCalledWith(accepted!.runId)
})

it.each(['result', 'cancel'])(
	'routes %s to the original authenticated endpoint and rejects mismatched retained content',
	async (method) => {
		const query = vi.fn(async () => ({
			...original,
			requestHash: 'b'.repeat(64),
			state: 'succeeded',
		}))
		mocks.connect.mockResolvedValue(connection({ [method]: query }))
		const receipt = encodeScriptReceipt(original)
		const [failure] = await command([method, receipt])
		expect(failure).toMatchObject({ ok: false, error: { code: 'receipt_mismatch', receipt } })
		expect(mocks.connect).toHaveBeenCalledWith({
			endpoint: 'https://host.test/',
			instanceId: original.instanceId,
			credentials: {},
		})
		expect(mocks.compile).not.toHaveBeenCalled()
	},
)

it('rejects target override flags and unavailable original owners without replay', async () => {
	const receipt = encodeScriptReceipt(original)
	const [invalid] = await command(['result', receipt, '--endpoint', 'https://replacement.test/'])
	expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_input', receipt } })
	expect(mocks.connect).not.toHaveBeenCalled()
	mocks.connect.mockRejectedValue(
		new ScriptExecutionError('instance_mismatch', 'Original owner unavailable'),
	)
	const [gone] = await command(['result', receipt])
	expect(gone).toMatchObject({ ok: false, error: { code: 'instance_mismatch', receipt } })
	expect(mocks.compile).not.toHaveBeenCalled()
})
