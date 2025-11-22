import type { TrackedPluginUsage } from '../plugins/import-tracker'

export interface RuleContext {
	packageJsonPath: string
	manifestField: string
	pluginUsages: Map<string, TrackedPluginUsage>
}

export type RuleMessages = string[] | undefined
