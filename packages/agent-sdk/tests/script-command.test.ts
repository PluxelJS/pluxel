import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cli as gunshiCli } from 'gunshi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
	SCRIPT_ARTIFACT_FORMAT,
	ScriptExecutionError,
	scriptRequestHash,
	type ScriptSubmission,
} from '@pluxel/host/internal/agent/runtime'
import { decodeScriptReceipt, encodeScriptReceipt, type ScriptReceipt } from '../src/client/receipt'
import { scriptCommand } from '@pluxel/agent-sdk/internal/cli'

const mocks = vi.hoisted(() => ({ connect: vi.fn(), compile: vi.fn() }))
vi.mock('../src/client/execution', () => ({ connectScriptTarget: mocks.connect }))
vi.mock('@pluxel/rolldown/scripts', () => ({ compileScript: mocks.compile }))

const original: ScriptReceipt = {
	version: 3,
	connection: { kind: 'remote', endpoint: 'https://host.test/' },
	instanceId: 'owner',
	runId: 'original-run',
	requestHash: 'a'.repeat(64),
}
const directories: string[] = []
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
	events = []
	vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
		events.push(JSON.parse(String(text)))
		return true
	})
})
afterEach(async () => {
	process.exitCode = 0
	vi.restoreAllMocks()
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
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
			credentials: undefined,
			signal: undefined,
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

async function files() {
	const directory = await mkdtemp(join(tmpdir(), 'agent-cli-files-'))
	directories.push(directory)
	return {
		input: join(directory, 'input.json'),
		credentials: join(directory, 'credentials.json'),
		receipt: join(directory, 'receipt'),
	}
}

it('reads JSON and private credentials, and saves the original receipt before submission', async () => {
	const file = await files()
	await writeFile(file.input, '{"count":3}')
	await writeFile(file.credentials, '{"password":"private-value"}')
	let saved = ''
	mocks.connect.mockResolvedValue(
		connection({
			submit: async (input: ScriptSubmission) => {
				const text = await readFile(file.receipt, 'utf8')
				saved = text.trim()
				expect(decodeScriptReceipt(saved)).toMatchObject({
					runId: input.runId,
					requestHash: await scriptRequestHash(input),
				})
				expect(input).toMatchObject({
					input: { count: 3 },
					timeoutMs: 30000,
					code: { exportName: 'default' },
				})
				return {
					instanceId: original.instanceId,
					runId: input.runId,
					requestHash: await scriptRequestHash(input),
					state: 'succeeded',
				}
			},
		}),
	)
	const [output] = await command([
		'run',
		'task.ts',
		'--endpoint',
		'https://host.test/',
		'--input-file',
		file.input,
		'--credentials-file',
		file.credentials,
		'--receipt-file',
		file.receipt,
	])
	expect(output).toMatchObject({ ok: true, value: { receipt: saved, run: { state: 'succeeded' } } })
	expect(mocks.connect).toHaveBeenCalledWith(
		expect.objectContaining({ credentials: { password: 'private-value' } }),
	)
	expect(JSON.stringify([output, events])).not.toContain('private-value')
})

it('refuses to overwrite a receipt file and does not submit when persistence fails', async () => {
	const file = await files()
	await writeFile(file.receipt, 'previous receipt')
	const submit = vi.fn()
	mocks.connect.mockResolvedValue(connection({ submit }))
	const [failure] = await command([
		'run',
		'task.ts',
		'--endpoint',
		'https://host.test/',
		'--receipt-file',
		file.receipt,
	])
	expect(failure).toMatchObject({
		ok: false,
		error: { code: 'EEXIST', receipt: expect.any(String) },
	})
	expect(await readFile(file.receipt, 'utf8')).toBe('previous receipt')
	expect(submit).not.toHaveBeenCalled()
	expect(events).toEqual([])
})

it.each([
	['conflict', 'invalid_input'],
	['missing', 'ENOENT'],
	['malformed', 'invalid_input'],
	['large', 'input_too_large'],
	['credentials', 'invalid_credentials'],
])('preserves the %s file error before opening a target', async (kind, code) => {
	const file = await files()
	const flags = ['--input-file', file.input]
	if (kind === 'conflict') flags.push('--input', '{}')
	if (kind === 'malformed') await writeFile(file.input, '{')
	if (kind === 'large') await writeFile(file.input, ' '.repeat(1024 * 1024 + 1))
	if (kind === 'credentials') {
		await writeFile(file.credentials, '{"password":"private-value"')
		flags.splice(0, flags.length, '--credentials-file', file.credentials)
	}
	const [failure] = await command(['run', 'task.ts', '--endpoint', 'https://host.test/', ...flags])
	expect(failure).toMatchObject({ ok: false, error: { code } })
	expect(JSON.stringify(failure)).not.toContain('private-value')
	expect(mocks.connect).not.toHaveBeenCalled()
	expect(mocks.compile).not.toHaveBeenCalled()
	expect(events).toEqual([])
})

it('preserves authentication failure and a malformed original receipt as terminal errors', async () => {
	mocks.connect.mockRejectedValue(
		new ScriptExecutionError('authentication_failed', 'Authentication rejected'),
	)
	const [authentication] = await command(['run', 'task.ts', '--endpoint', 'https://host.test/'])
	expect(authentication).toMatchObject({ ok: false, error: { code: 'authentication_failed' } })
	const [receipt] = await command(['cancel', 'invalid-receipt'])
	expect(receipt).toMatchObject({
		ok: false,
		error: { code: 'invalid_receipt', receipt: 'invalid-receipt' },
	})
	expect(process.exitCode).toBe(1)
})

it.skipIf(process.platform === 'win32')('persists owner-only receipt files', async () => {
	const file = await files()
	mocks.connect.mockResolvedValue(
		connection({
			submit: async (input: ScriptSubmission) => ({
				instanceId: original.instanceId,
				runId: input.runId,
				requestHash: await scriptRequestHash(input),
				state: 'succeeded',
			}),
		}),
	)
	const [output] = await command([
		'run',
		'task.ts',
		'--endpoint',
		'https://host.test/',
		'--receipt-file',
		file.receipt,
	])
	expect(output).toMatchObject({ ok: true })
	const info = await stat(file.receipt)
	expect(info.mode & 0o777).toBe(0o600)
})
