import {
	env as standardEnvironment,
	isCI,
	isDevelopment,
	isProduction,
	isTest,
	nodeVersion,
	platform,
	provider,
	runtime,
} from 'std-env'

/**
 * Runtime-agnostic environment exposed by Pluxel hosts.
 * Applications may augment this interface with their own deployment variables.
 */
export interface PluxelEnvironmentVariables extends Readonly<Record<string, string | undefined>> {
	readonly PLUXEL_CONFIG?: string
	readonly PLUXEL_DATA_ROOT?: string
	readonly PLUXEL_WORKBENCH?: 'true' | 'false'
	readonly PLUXEL_HOST_BIND?: string
	readonly PLUXEL_HOST_PORT?: string
	readonly PLUXEL_TLS_CERT?: string
	readonly PLUXEL_TLS_KEY?: string
	readonly PLUXEL_TLS_PASSPHRASE?: string
	readonly PLUXEL_VAULT_DEPLOY_IDENTITY?: string
	readonly PLUXEL_HMR_PROFILE?: string
	readonly PLUXEL_HMR_CONFIG?: string
	readonly PLUXEL_HMR_PORT?: string
	readonly PLUXEL_HMR_ATTRIBUTION?: string
}

/** The universal `std-env` environment with Pluxel's official variables typed. */
export const env = standardEnvironment as PluxelEnvironmentVariables

/** Validated effective Host environment shared by launchers and deployment integrations. */
export type PluxelHostEnvironment = Readonly<{
	/** Shared data root. Defaults to `.pluxel`; integrations derive owned subdirectories from it. */
	dataRoot: string
	/** Explicit Workbench override. Omitted preserves the host/build default. */
	workbench?: boolean
	/** Explicit physical listener bind address. Meaningful only to listener-owning launchers. */
	hostBind?: string
	/** Explicit physical listener port. Meaningful only to listener-owning launchers. */
	hostPort?: number
}>

/** Browser-safe facts about the current JavaScript and deployment environment. */
export type PluxelPlatformSnapshot = Readonly<{
	runtime: Readonly<{
		name: string | null
		version: string | null
	}>
	deployment: Readonly<{
		provider: string | null
		ci: boolean
	}>
	mode: 'development' | 'production' | 'test' | 'unknown'
	platform: string | null
}>

/**
 * Resolve framework-owned deployment variables and framework-wide defaults.
 * Invalid explicit values fail startup instead of silently selecting another behavior.
 */
export function resolveHostEnv(
	input: Readonly<Record<string, string | undefined>> = env,
): PluxelHostEnvironment {
	const dataRoot = optionalText(input.PLUXEL_DATA_ROOT, 'PLUXEL_DATA_ROOT') ?? '.pluxel'
	const workbench = optionalBoolean(input.PLUXEL_WORKBENCH, 'PLUXEL_WORKBENCH')
	const hostBind = optionalText(input.PLUXEL_HOST_BIND, 'PLUXEL_HOST_BIND')
	const hostPort = optionalPort(input.PLUXEL_HOST_PORT)
	return Object.freeze({
		dataRoot,
		...(workbench === undefined ? {} : { workbench }),
		...(hostBind === undefined ? {} : { hostBind }),
		...(hostPort === undefined ? {} : { hostPort }),
	})
}

/** Effective Pluxel Host environment resolved from the universal {@link env}. */
export const hostEnv = resolveHostEnv()

/** Detect a small, non-secret snapshot suitable for logs and management clients. */
export function describePluxelPlatform(): PluxelPlatformSnapshot {
	return Object.freeze({
		runtime: Object.freeze({
			name: runtime || null,
			version: runtime === 'node' ? nodeVersion : null,
		}),
		deployment: Object.freeze({
			provider: provider || null,
			ci: isCI,
		}),
		mode: isTest ? 'test' : isProduction ? 'production' : isDevelopment ? 'development' : 'unknown',
		platform: platform || null,
	})
}

function optionalText(value: string | undefined, name: string): string | undefined {
	if (value === undefined) return undefined
	const normalized = value.trim()
	if (!normalized) throw new TypeError(`[pluxel/environment] ${name} must not be empty`)
	return normalized
}

function optionalBoolean(value: string | undefined, name: string): boolean | undefined {
	if (value === undefined) return undefined
	switch (value.trim().toLowerCase()) {
		case 'true':
			return true
		case 'false':
			return false
		default:
			throw new TypeError(`[pluxel/environment] ${name} must be "true" or "false"`)
	}
}

function optionalPort(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const normalized = value.trim()
	if (!/^\d+$/.test(normalized)) {
		throw new TypeError('[pluxel/environment] PLUXEL_HOST_PORT must be an integer from 0 to 65535')
	}
	const port = Number(normalized)
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError('[pluxel/environment] PLUXEL_HOST_PORT must be an integer from 0 to 65535')
	}
	return port
}
