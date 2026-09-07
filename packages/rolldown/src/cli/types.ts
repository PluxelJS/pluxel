import type { ResolvedConfig } from 'tsdown'

export type BuildLogger = (...args: unknown[]) => void
export type BuildSuccessHook = (config: ResolvedConfig, signal: AbortSignal) => Promise<void> | void

export interface BuildRuntimeConfig {
	projectRoot: string
	packageJsonPath: string
	manifestField: string
	watch: boolean
	debug: boolean
	tsdownConfigPath?: string
}
