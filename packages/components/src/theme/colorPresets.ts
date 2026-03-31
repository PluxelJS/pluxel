import type { MantineColorsTuple } from '@mantine/core'
import { createMantinePaletteFromSeed } from './material'

interface ColorPresetDefinition {
	key: string
	name: string
	/** 代表色 - 用于预览 */
	color: string
}

export interface ColorPreset extends ColorPresetDefinition {
	/** 完整的 10 色阶调色板 */
	palette: MantineColorsTuple
}

/** 颜色预设 - 使用 Material tonal palette 生成完整色阶 */
const COLOR_PRESET_DEFINITIONS: ColorPresetDefinition[] = [
	{
		key: 'sage',
		name: '鼠尾草',
		color: '#7b907c',
	},
	{
		key: 'indigo',
		name: '靛蓝',
		color: '#4f46e5',
	},
	{
		key: 'blue',
		name: '天蓝',
		color: '#3b82f6',
	},
	{
		key: 'cyan',
		name: '青色',
		color: '#06b6d4',
	},
	{
		key: 'teal',
		name: '青绿',
		color: '#14b8a6',
	},
	{
		key: 'emerald',
		name: '翠绿',
		color: '#10b981',
	},
	{
		key: 'violet',
		name: '紫罗兰',
		color: '#8b5cf6',
	},
	{
		key: 'fuchsia',
		name: '洋红',
		color: '#d946ef',
	},
	{
		key: 'rose',
		name: '玫瑰',
		color: '#f43f5e',
	},
	{
		key: 'orange',
		name: '橙色',
		color: '#f97316',
	},
	{
		key: 'amber',
		name: '琥珀',
		color: '#f59e0b',
	},
	{
		key: 'slate',
		name: '石墨',
		color: '#64748b',
	},
	{
		key: 'zinc',
		name: '锌灰',
		color: '#71717a',
	},
]

export const COLOR_PRESETS: ColorPreset[] = COLOR_PRESET_DEFINITIONS.map((preset) => ({
	...preset,
	palette: createMantinePaletteFromSeed(preset.color),
}))
const COLOR_PRESET_MAP = new Map(COLOR_PRESETS.map((preset) => [preset.key, preset] as const))

/** 默认主题色 key */
export const DEFAULT_COLOR_KEY = 'sage'

/** 根据 key 获取颜色预设 */
export function getColorPreset(key: string): ColorPreset {
	return COLOR_PRESET_MAP.get(key) ?? COLOR_PRESETS[0]
}

export function resolveThemeColorKey(key: string | null | undefined): string {
	return typeof key === 'string' ? getColorPreset(key).key : DEFAULT_COLOR_KEY
}

/** localStorage key */
export const THEME_COLOR_STORAGE_KEY = 'pluxel:theme:accent-color'
