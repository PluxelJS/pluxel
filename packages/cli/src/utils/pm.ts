import { spawn } from 'node:child_process'
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

function normalizeAgent(agent: AgentName | null): PM | undefined {
	if (!agent) return undefined
	if (agent === 'pnpm' || agent === 'npm' || agent === 'yarn') return agent
	if (agent === 'bun') return 'bun'
	return undefined
}
