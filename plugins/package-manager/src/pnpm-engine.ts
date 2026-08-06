import { createRequire } from 'node:module'
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

export function loadPnpmEngine(): PnpmEngine {
	if (cached) return cached
	const require = createRequire(import.meta.url)
	const loaded = require('@pnpm/napi') as PnpmEngine
	if (
		typeof loaded.engineVersion !== 'function' ||
		typeof loaded.install !== 'function' ||
		typeof loaded.parseBareSpecifier !== 'function' ||
		typeof loaded.readConfig !== 'function'
	) {
		throw new TypeError('@pnpm/napi does not expose the required pacquet engine API')
	}
	cached = Object.freeze(loaded)
	return cached
}

export type { InstallOptions, InstallResult, PackageManifest, ParsedBareSpecifier, ResolvedConfig }
