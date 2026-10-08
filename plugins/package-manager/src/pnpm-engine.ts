import { resolve } from 'node:path'
import type {
	InstallOptions,
	InstallResult,
	PackageManifest,
	ParsedBareSpecifier,
	ResolvedConfig,
} from '@pnpm/napi'

export type PnpmEngine = Readonly<{
	engineVersion(): string
	install(
		options: InstallOptions,
		onLog?: (event: Record<string, unknown>) => void,
	): Promise<InstallResult>
	parseBareSpecifier(spec: string, alias?: string): ParsedBareSpecifier | null
	readConfig(options: { dir: string }): ResolvedConfig
}>

let cached: PnpmEngine | undefined

export async function loadPnpmEngine(): Promise<PnpmEngine> {
	if (cached) return cached
	const namespace = await import('@pnpm/napi')
	const loaded = ('default' in namespace ? namespace.default : namespace) as PnpmEngine
	if (
		typeof loaded.engineVersion !== 'function' ||
		typeof loaded.install !== 'function' ||
		typeof loaded.parseBareSpecifier !== 'function' ||
		typeof loaded.readConfig !== 'function'
	) {
		throw new TypeError('@pnpm/napi does not expose the required pacquet engine API')
	}
	cached = Object.freeze({
		engineVersion: () => loaded.engineVersion(),
		parseBareSpecifier: (spec, alias) => loaded.parseBareSpecifier(spec, alias),
		readConfig(options) {
			assertWorkspaceDirectory(options.dir)
			return loaded.readConfig(options)
		},
		async install(options, onLog) {
			assertWorkspaceDirectory(options.dir)
			return loaded.install(options, onLog)
		},
	} satisfies PnpmEngine)
	return cached
}

function assertWorkspaceDirectory(directory: string): void {
	// Pacquet gives the first non-empty workspace environment variable precedence
	// over its explicit dir. A managed installation must never target its caller's workspace.
	for (const name of [
		'PNPM_CONFIG_WORKSPACE_DIR',
		'pnpm_config_workspace_dir',
		'NPM_CONFIG_WORKSPACE_DIR',
		'npm_config_workspace_dir',
	]) {
		const value = process.env[name]
		if (!value) continue
		if (resolve(value) !== resolve(directory)) {
			throw new Error(
				`Managed package installation cannot use ${name}=${value}: it differs from the explicit installation directory ${directory}. Start the application without this package-manager scheduling override.`,
			)
		}
		return
	}
}

export type { InstallOptions, InstallResult, PackageManifest, ParsedBareSpecifier, ResolvedConfig }
