import type { PluginDependencyMode } from '../../rolldown/plugins/pluginSemanticsPlugin'

export interface RuleContext {
	packageJsonPath: string
	pluginUsages: Map<string, PluginDependencyMode>
	workbenchArtifacts?: boolean
	artifactRoot?: string
	workbenchCapnwebVersion?: string
	tinybaseVersion?: string
}

export type RuleMessages = string[] | undefined
