import type { DetectOptions } from 'package-manager-detector'
import { resolve } from 'pathe'

export interface CliDefaults {
	publish: {
		access: string
		requireOidc: boolean
		audienceEnv: string
		oidcTokenEnv: string
		marketBaseUrl: string
		marketBaseEnv: string
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
		requireOidc: true,
		audienceEnv: 'PLUXEL_OIDC_AUDIENCE',
		oidcTokenEnv: 'PLUXEL_OIDC_TOKEN',
		marketBaseUrl: 'https://market.pluxel.dev',
		marketBaseEnv: 'PLUXEL_MARKET_BASE_URL',
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

export function resolvePublishEnv(env: NodeJS.ProcessEnv = process.env) {
	return {
		audience: env[CLI_DEFAULTS.publish.audienceEnv],
		oidcToken: env[CLI_DEFAULTS.publish.oidcTokenEnv],
		marketBaseUrl: env[CLI_DEFAULTS.publish.marketBaseEnv],
	}
}

export function resolveStateDir(root: string, env: NodeJS.ProcessEnv = process.env) {
	const overridden = env[CLI_DEFAULTS.paths.stateDirEnv]
	if (overridden?.trim()) return overridden
	return resolve(root || '.', CLI_DEFAULTS.paths.stateDirName)
}
