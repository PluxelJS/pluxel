import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'pathe'

export type PM = 'pnpm' | 'npm' | 'yarn'

export function detectPm(root: string, fallback: PM = 'pnpm'): PM {
	try {
		if (fs.existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
		if (fs.existsSync(join(root, 'yarn.lock'))) return 'yarn'
		if (fs.existsSync(join(root, 'package-lock.json'))) return 'npm'
	} catch {}
	const ua = process.env.npm_config_user_agent || ''
	if (ua.startsWith('pnpm')) return 'pnpm'
	if (ua.startsWith('yarn')) return 'yarn'
	if (ua.startsWith('npm')) return 'npm'
	return fallback
}

export async function runPackageManager(pm: PM, args: string[], cwd: string) {
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn(pm, args, {
			stdio: 'inherit',
			cwd,
			shell: process.platform === 'win32',
		})
		child.on('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`${pm} ${args.join(' ')} failed`))
		})
	})
}
