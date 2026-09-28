import type { PluginDependencyMode } from '../../rolldown/plugins/pluginSemanticsPlugin'

export interface RuleContext {
	packageJsonPath: string
	manifestField: string
	pluginUsages: Map<string, PluginDependencyMode>
	workbenchCapnwebVersion?: string
}

export type RuleMessages = string[] | undefined
