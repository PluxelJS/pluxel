import { writeFile } from 'node:fs/promises'
import { ScriptExecutionError } from '@pluxel/host/internal/agent/runtime'
import { readBoundedFile } from '../client/dev'
import { decodeScriptReceipt, MAX_TOKEN_LENGTH } from '../client/receipt'
import { printRunProgress } from './output'

/** Complete persistence before announcing preparation or allowing submission. */
export async function savePreparedReceipt(receipt: string, file?: string): Promise<void> {
	if (file !== undefined) await writeFile(file, receipt + '\n', { mode: 0o600, flag: 'wx' })
	printRunProgress('prepared', receipt)
}

export async function readReceipt(token?: string, file?: string): Promise<string> {
	if ((token === undefined) === (file === undefined))
		throw new ScriptExecutionError('invalid_input', 'Use one receipt token or --receipt-file')
	if (file === undefined) return token!
	// Accept one file line ending, then use the client's canonical receipt validation.
	const buffer = await readBoundedFile(file, MAX_TOKEN_LENGTH + 2)
	const receipt = buffer.toString('utf8').replace(/\r?\n$/, '')
	decodeScriptReceipt(receipt)
	return receipt
}
