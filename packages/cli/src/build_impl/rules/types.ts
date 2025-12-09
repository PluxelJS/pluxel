import type { TrackedPluginUsage } from '@pluxel/rolldown'

export interface RuleContext {
	packageJsonPath: string
	manifestField: string
	pluginUsages: Map<string, TrackedPluginUsage>
}

export type RuleMessages = string[] | undefined
