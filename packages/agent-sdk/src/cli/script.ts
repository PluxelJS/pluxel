import { writeFile } from 'node:fs/promises'
import { define, type ArgValues } from 'gunshi'
import {
	scriptRunDefinition,
	scriptRunArgs,
	scriptResultDefinition,
	scriptCancelDefinition,
	scriptReceiptArgs,
} from './manifest'
import { validateCommandOptions } from './options'
import { runScript, getScriptResult, cancelScript, HostClientError } from '../client'
import { ScriptExecutionError, scriptFailure } from '@pluxel/host/internal/agent/runtime'
import { parseInput, readBoundedFile } from '../client/dev'
import { readScriptCredentials } from './credentials'
import { printFailure, printRun, printRunProgress } from './output'

type RunValues = ArgValues<typeof scriptRunArgs>
type ReceiptValues = ArgValues<typeof scriptReceiptArgs>

export const scriptRunCommand = define({
	...scriptRunDefinition,
	async run(ctx) {
		try {
			await validateCommandOptions(ctx)
			const values = ctx.values as RunValues
			if (values.input !== undefined && values['input-file'] !== undefined)
				throw new ScriptExecutionError('invalid_input', 'Use one of --input and --input-file')
			const inputFile = values['input-file']
				? await readBoundedFile(values['input-file'])
				: undefined
			const inputText = inputFile === undefined ? values.input : inputFile.toString('utf8')
			const result = await runScript({
				target: {
					endpoint: values.endpoint,
					credentials: await readScriptCredentials(values['credentials-file']),
				},
				file: values.file,
				exportName: values.export,
				input: inputText === undefined ? undefined : parseInput(inputText),
				timeoutMs: Number(values.timeout),
				detach: values.detach,
				onPrepared: async (receipt) => {
					if (values['receipt-file'])
						await writeFile(values['receipt-file'], receipt + '\n', { mode: 0o600, flag: 'wx' })
					printRunProgress('prepared', receipt)
				},
				onAccepted: ({ receipt }) => printRunProgress('accepted', receipt),
			})
			printRun(ctx.log, result.receipt, result.run, values.detach)
		} catch (error) {
			printFailure(
				ctx.log,
				error instanceof HostClientError
					? error.failure
					: scriptFailure(error, 'submission_failed'),
				error instanceof HostClientError ? error.receipt : undefined,
			)
		}
	},
})

function receiptCommand(
	definition: typeof scriptResultDefinition | typeof scriptCancelDefinition,
	operation: typeof getScriptResult,
) {
	return define({
		...definition,
		async run(ctx) {
			const values = ctx.values as ReceiptValues
			try {
				await validateCommandOptions(ctx)
				const options = values['credentials-file']
					? { credentials: await readScriptCredentials(values['credentials-file']) }
					: {}
				const result = await operation(values.receipt, options)
				printRun(ctx.log, result.receipt, result.run)
			} catch (error) {
				printFailure(
					ctx.log,
					error instanceof HostClientError ? error.failure : scriptFailure(error, 'query_failed'),
					error instanceof HostClientError ? error.receipt : values.receipt,
				)
			}
		},
	})
}
export const scriptResultCommand = receiptCommand(scriptResultDefinition, getScriptResult)
export const scriptCancelCommand = receiptCommand(scriptCancelDefinition, cancelScript)
