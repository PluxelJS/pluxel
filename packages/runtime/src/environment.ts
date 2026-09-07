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
	/** Injected by Portless while a named development route is active. */
	readonly PORTLESS_URL?: string
	/** Portless child-process listener bind address. */
	readonly HOST?: string
	/** Portless child-process listener port. */
	readonly PORT?: string
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
	/** Validated named Portless origin for development URL presentation. */
	portlessOrigin?: string
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
	const portlessOrigin = optionalHttpOrigin(input.PORTLESS_URL, 'PORTLESS_URL')
	const hostBind =
		optionalText(input.PLUXEL_HOST_BIND, 'PLUXEL_HOST_BIND') ??
		(portlessOrigin ? optionalText(input.HOST, 'HOST') : undefined)
	const hostPort =
		optionalPort(input.PLUXEL_HOST_PORT, 'PLUXEL_HOST_PORT') ??
		(portlessOrigin ? optionalPort(input.PORT, 'PORT') : undefined)
	return Object.freeze({
		dataRoot,
		...(workbench === undefined ? {} : { workbench }),
		...(hostBind === undefined ? {} : { hostBind }),
		...(hostPort === undefined ? {} : { hostPort }),
		...(portlessOrigin === undefined ? {} : { portlessOrigin }),
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

function optionalPort(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined
	const normalized = value.trim()
	if (!/^\d+$/.test(normalized)) {
		throw new TypeError(`[pluxel/environment] ${name} must be an integer from 0 to 65535`)
	}
	const port = Number(normalized)
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError(`[pluxel/environment] ${name} must be an integer from 0 to 65535`)
	}
	return port
}

function optionalHttpOrigin(value: string | undefined, name: string): string | undefined {
	const text = optionalText(value, name)
	if (text === undefined) return undefined
	let url: URL
	try {
		url = new URL(text)
	} catch (error) {
		throw new TypeError(`[pluxel/environment] ${name} must be an HTTP(S) origin`, { cause: error })
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new TypeError(`[pluxel/environment] ${name} must be an HTTP(S) origin`)
	}
	return url.origin
}
