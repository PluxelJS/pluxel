import type { PluginDependencyMode } from '../../rolldown/plugins/pluginSemanticsPlugin'

export interface RuleContext {
	packageJsonPath: string
	pluginUsages: Map<string, PluginDependencyMode>
	workbenchArtifacts?: boolean
	artifactRoot?: string
	control?: boolean
	workbenchCapnwebVersion?: string
	tinybaseVersion?: string
}

export type RuleMessages = string[] | undefined
