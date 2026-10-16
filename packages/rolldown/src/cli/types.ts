import type { ResolvedConfig } from 'vite-plus/pack'

export type BuildLogger = (...args: unknown[]) => void
export type BuildSuccessHook = (config: ResolvedConfig, signal: AbortSignal) => Promise<void> | void

export interface BuildRuntimeConfig {
	projectRoot: string
	packageJsonPath: string
	watch: boolean
	debug: boolean
	tsdownConfigPath?: string
}
