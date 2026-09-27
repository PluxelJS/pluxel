import type { DetectOptions } from 'package-manager-detector'
import { resolve } from 'pathe'

export interface CliDefaults {
	publish: {
		access: string
		marketBaseUrl: string
		oidcTokenEnv: string
	}
	packageManager: {
		fallback: 'pnpm' | 'npm' | 'yarn' | 'bun'
		detectOptions?: DetectOptions
	}
	paths: {
		stateDirName: string
		stateDirEnv: string
		workspaceCandidatesFile: string
	}
}

export const CLI_DEFAULTS: CliDefaults = {
	publish: {
		access: 'public',
		marketBaseUrl: 'https://market.pluxel.dev',
		oidcTokenEnv: 'PLUXEL_OIDC_TOKEN',
	},
	packageManager: {
		fallback: 'pnpm',
		detectOptions: {
			strategies: ['lockfile', 'packageManager-field', 'devEngines-field'],
		},
	},
	paths: {
		stateDirName: '.pluxel',
		stateDirEnv: 'PLUXEL_STATE_DIR',
		workspaceCandidatesFile: 'workspaces.json',
	},
}

export function resolveStateDir(root: string, env: NodeJS.ProcessEnv = process.env) {
	const overridden = env[CLI_DEFAULTS.paths.stateDirEnv]
	if (overridden !== undefined) {
		if (!overridden.trim())
			throw new TypeError(`${CLI_DEFAULTS.paths.stateDirEnv} must be a nonempty path when set`)
		return overridden
	}
	return resolve(root || '.', CLI_DEFAULTS.paths.stateDirName)
}
