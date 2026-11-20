import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runNode = promisify(execFile)

export function runNodeModule(source: string, timeout = 10_000, flags: readonly string[] = []) {
	return runNode(process.execPath, [...flags, '--input-type=module', '-e', source], { timeout })
}
