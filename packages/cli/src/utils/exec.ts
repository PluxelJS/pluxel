import { spawn } from 'node:child_process'

export interface ExecOptions {
	cwd?: string
	env?: NodeJS.ProcessEnv
}

export interface ExecResult {
	code: number | null
	stdout: string
	stderr: string
}

export function runCommand(command: string, args: string[], options: ExecOptions = {}) {
	return new Promise<ExecResult>((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
		})

		let stdout = ''
		let stderr = ''

		child.stdout?.on('data', (chunk: Buffer | string) => {
			stdout += chunk.toString()
		})
		child.stderr?.on('data', (chunk: Buffer | string) => {
			stderr += chunk.toString()
		})
		child.on('error', (error: Error) => {
			stderr += error.message
			resolve({ code: -1, stdout, stderr })
		})
		child.on('close', (code) => {
			resolve({ code, stdout, stderr })
		})
	})
}
