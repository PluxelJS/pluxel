import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { delimiter, dirname, resolve } from 'node:path'

/** Run a trusted package command with script-style PATH and the caller's terminal. */
export function runDevCommand(command: string, cwd: string, profile: string): Promise<number> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PLUXEL_DEV_PROFILE: profile,
		PLUXEL_DEV_PROJECT: cwd,
	}
	const pathKey =
		process.platform === 'win32'
			? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH')
			: 'PATH'
	const paths: string[] = []
	for (let directory = resolve(cwd); ; directory = dirname(directory)) {
		paths.push(resolve(directory, 'node_modules/.bin'))
		if (dirname(directory) === directory) break
	}
	env[pathKey] = [...paths, env[pathKey] ?? ''].join(delimiter)
	return new Promise((resolveExit, reject) => {
		const child = spawn(command, {
			cwd,
			env,
			shell: true,
			stdio: 'inherit',
			// Isolate POSIX signals from the invoking package manager. The inherited
			// terminal descriptors remain usable, including Vite's keyboard shortcuts.
			detached: process.platform !== 'win32',
		})
		let interrupted: NodeJS.Signals | undefined
		const forward = (signal: NodeJS.Signals) => {
			if (!child.pid) return
			interrupted = signal
			if (process.platform === 'win32') {
				const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
					stdio: 'ignore',
					windowsHide: true,
				})
				killer.once('error', () => child.kill(signal))
			} else {
				try {
					process.kill(-child.pid, signal)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
				}
			}
		}
		const interrupt = () => forward('SIGINT')
		const terminate = () => forward('SIGTERM')
		const hangup = () => forward('SIGHUP')
		const cleanup = () => {
			process.off('SIGINT', interrupt)
			process.off('SIGTERM', terminate)
			process.off('SIGHUP', hangup)
		}
		process.on('SIGINT', interrupt)
		process.on('SIGTERM', terminate)
		process.on('SIGHUP', hangup)
		child.once('error', (error) => {
			cleanup()
			reject(error)
		})
		child.once('exit', (code, signal) => {
			cleanup()
			const exitSignal = interrupted ?? signal
			resolveExit(exitSignal ? 128 + constants.signals[exitSignal] : (code ?? 1))
		})
	})
}
