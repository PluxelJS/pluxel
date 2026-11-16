import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { type AgentName, detect as detectAgent, getUserAgent } from 'package-manager-detector'
import { CLI_DEFAULTS } from '../config'

export type PM = 'pnpm' | 'npm' | 'yarn' | 'bun'

export async function detectPm(
	root: string,
	fallback: PM = CLI_DEFAULTS.packageManager.fallback,
): Promise<PM> {
	const userAgent = normalizeAgent(getUserAgent())
	if (userAgent) return userAgent

	try {
		const detected = await detectAgent({
			cwd: root,
			...CLI_DEFAULTS.packageManager.detectOptions,
		})
		const normalized = normalizeAgent(detected?.name)
		if (normalized) return normalized
	} catch {
		// fall through to fallback
	}

	return fallback
}

export async function installDependencies(cwd: string, pm?: PM): Promise<void> {
	const env = { ...process.env }
	if (pm) {
		const manifest = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')) as {
			packageManager?: unknown
		}
		const declared = manifest.packageManager
		env.VP_PACKAGE_MANAGER =
			typeof declared === 'string' && declared.startsWith(`${pm}@`) ? declared : `${pm}@latest`
	}
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn('vp', ['install'], {
			stdio: 'inherit',
			cwd,
			env,
			shell: process.platform === 'win32',
		})
		child.once('error', reject)
		child.once('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`vp install failed in ${cwd} (${code})`))
		})
	})
}

function normalizeAgent(agent: AgentName | null): PM | undefined {
	if (!agent) return undefined
	if (agent === 'pnpm' || agent === 'npm' || agent === 'yarn') return agent
	if (agent === 'bun') return 'bun'
	return undefined
}
