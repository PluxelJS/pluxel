import { workbenchContract } from '@pluxel/runtime/workbench/contract'

export const FONT_MANAGER_PLUGIN_NAME = 'PluginContributionFontManager' as const
export const FONT_KIND = 'font-set' as const

export type FontSetDoc = {
	id: string
	name: string
	previewText: string
	description: string
}

export const FONT_SETS: readonly FontSetDoc[] = [
	{
		id: 'editorial-serif',
		name: 'Editorial Serif',
		previewText: 'The quick brown fox jumps over the lazy dog.',
		description: '适合长文、说明文与强调阅读质感的插件。',
	},
	{
		id: 'mono-grid',
		name: 'Mono Grid',
		previewText: '0123456789 ABC xyz',
		description: '适合日志、终端、指标与结构化内容场景。',
	},
	{
		id: 'neo-grotesk',
		name: 'Neo Grotesk',
		previewText: 'Design systems scale through constraints.',
		description: '适合偏产品化、信息密度较高的插件页面。',
	},
] as const

export type FontRef = {
	provider: string
	kind: string
	id: string
	label?: string
}

export interface FontSettingsCommands {
	current(): Promise<FontRef | null>
	set(ref: FontRef | null): Promise<FontRef | null>
}

export const FontSettingsPort = workbenchContract.port({
	id: 'pluxel.demo.font-settings',
	version: 1,
	resources: {
		settings: workbenchContract.rpc<FontSettingsCommands>(),
	},
})
