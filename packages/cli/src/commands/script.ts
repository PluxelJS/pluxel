import { randomUUID } from 'node:crypto'
import { open, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { define, type ArgValues } from 'gunshi'
import {
	scriptCommandDefinition,
	scriptRunDefinition,
	scriptRunArgs,
	scriptResultDefinition,
	scriptCancelDefinition,
	scriptReceiptArgs,
} from '../command-manifest'
import { validateCommandOptions } from '../command-options'
import { loadOfficialCapability } from '../capability-loader'
import {
	ScriptExecutionError,
	scriptFailure,
	snapshotJson,
	scriptRequestHash,
	type ScriptRunSnapshot,
	type ScriptSubmission,
} from '@pluxel/host/agent'
import {
	connectScriptTarget,
	readScriptCredentials,
	encodeScriptReceipt,
	decodeScriptReceipt,
	verifyScriptReceipt,
	type RemoteScriptReceipt,
} from '../script/client'

type RunValues = ArgValues<typeof scriptRunArgs>
type ReceiptValues = ArgValues<typeof scriptReceiptArgs>
const terminal = (run: ScriptRunSnapshot) =>
	['succeeded', 'failed', 'cancelled'].includes(run.state)
function printRun(
	log: (value: string) => void,
	receipt: string,
	run: ScriptRunSnapshot,
	detached = false,
): void {
	log(JSON.stringify({ receipt, run }))
	if (run.state === 'failed' || run.state === 'cancelled') process.exitCode = 1
	else if (!detached && !terminal(run)) process.exitCode = 2
}
async function boundedInput(file: string, maximum = 1024 * 1024): Promise<string> {
	await using handle = await open(file, 'r')
	const stat = await handle.stat()
	if (!stat.isFile())
		throw new ScriptExecutionError('invalid_input', 'Input must be a regular file')
	const bytes = Buffer.alloc(maximum + 1)
	let size = 0
	while (size < bytes.length) {
		const chunk = await handle.read(bytes, size, bytes.length - size, null)
		if (!chunk.bytesRead) break
		size += chunk.bytesRead
	}
	if (size > maximum) throw new ScriptExecutionError('input_too_large', 'JSON input exceeds 1 MiB')
	return bytes.subarray(0, size).toString('utf8')
}

export const scriptRunCommand = define({
	...scriptRunDefinition,
	async run(ctx) {
		let receipt: string | undefined
		try {
			validateCommandOptions(ctx)
			const values = ctx.values as RunValues
			const timeoutMs = Number(values.timeout)
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
				throw new ScriptExecutionError(
					'invalid_input',
					'--timeout must be an integer between 1 and 300000',
				)
			if (values.input !== undefined && values['input-file'] !== undefined)
				throw new ScriptExecutionError('invalid_input', 'Use one of --input and --input-file')
			const inputText = values['input-file']
				? await boundedInput(values['input-file'])
				: values.input
			if (inputText !== undefined && Buffer.byteLength(inputText) > 1024 * 1024)
				throw new ScriptExecutionError('input_too_large', 'JSON input exceeds 1 MiB')
			let input: ScriptSubmission['input']
			try {
				input = inputText === undefined ? undefined : snapshotJson(JSON.parse(inputText))
			} catch (error) {
				if (error instanceof ScriptExecutionError && error.code === 'result_too_large')
					throw new ScriptExecutionError(
						'input_too_large',
						'JSON input exceeds the portable input limit',
					)
				throw error
			}
			const { compileScript } = await loadOfficialCapability('rolldown-scripts')
			const code = await compileScript({ file: resolve(values.file), exportName: values.export })
			using connection = await connectScriptTarget({
				endpoint: values.endpoint,
				credentials: await readScriptCredentials(values['credentials-file']),
			})
			if (!connection.description.codeKinds.includes('artifact'))
				throw new ScriptExecutionError(
					'loading_unavailable',
					'Selected target does not accept uploaded scripts',
				)
			const submission: ScriptSubmission = {
				runId: randomUUID(),
				code,
				...(input !== undefined ? { input } : {}),
				timeoutMs,
			}
			const request: RemoteScriptReceipt = {
				version: 2,
				endpoint: new URL(values.endpoint).href,
				instanceId: connection.description.instanceId,
				runId: submission.runId,
				requestHash: await scriptRequestHash(submission),
			}
			receipt = encodeScriptReceipt(request)
			if (values['receipt-file'])
				await writeFile(values['receipt-file'], receipt + '\n', { mode: 0o600, flag: 'wx' })
			process.stderr.write(JSON.stringify({ stage: 'prepared', receipt }) + '\n')
			let run = await connection.control.submit(submission)
			verifyScriptReceipt(run, request)
			process.stderr.write(JSON.stringify({ stage: 'accepted', receipt }) + '\n')
			if (!values.detach) {
				const deadline = Date.now() + timeoutMs + 5000
				while (!terminal(run) && Date.now() < deadline) {
					await setTimeout(50)
					run = await connection.control.result(request.runId)
					verifyScriptReceipt(run, request)
				}
			}
			printRun(ctx.log, receipt, run, values.detach)
		} catch (error) {
			ctx.log(
				JSON.stringify({
					...(receipt ? { receipt } : {}),
					error: scriptFailure(error, receipt ? 'outcome_unknown' : 'submission_failed'),
				}),
			)
			process.exitCode = 1
		}
	},
})

function receiptCommand(
	definition: typeof scriptResultDefinition | typeof scriptCancelDefinition,
	method: 'result' | 'cancel',
) {
	return define({
		...definition,
		async run(ctx) {
			const values = ctx.values as ReceiptValues
			try {
				validateCommandOptions(ctx)
				const receipt = decodeScriptReceipt(values.receipt)
				using connection = await connectScriptTarget({
					endpoint: receipt.endpoint,
					instanceId: receipt.instanceId,
					credentials: await readScriptCredentials(values['credentials-file']),
				})
				const run = await connection.control[method](receipt.runId)
				verifyScriptReceipt(run, receipt)
				printRun(ctx.log, values.receipt, run)
			} catch (error) {
				ctx.log(
					JSON.stringify({ receipt: values.receipt, error: scriptFailure(error, 'query_failed') }),
				)
				process.exitCode = 1
			}
		},
	})
}
export const scriptResultCommand = receiptCommand(scriptResultDefinition, 'result')
export const scriptCancelCommand = receiptCommand(scriptCancelDefinition, 'cancel')
export const scriptCommand = define({ ...scriptCommandDefinition, run() {} })
