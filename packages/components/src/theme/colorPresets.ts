import type { MantineColorsTuple } from '@mantine/core'

export interface ColorPreset {
	key: string
	name: string
	/** 代表色 - 用于预览 */
	color: string
	/** 完整的 10 色阶调色板 */
	palette: MantineColorsTuple
}

/**
 * 颜色预设 - 基于 Mantine Colors Generator
 * https://mantine.dev/colors-generator/
 */
export const COLOR_PRESETS: ColorPreset[] = [
	{
		key: 'indigo',
		name: '靛蓝',
		color: '#4f46e5',
		palette: [
			'#eef2ff',
			'#e0e7ff',
			'#c7d2fe',
			'#a5b4fc',
			'#818cf8',
			'#6366f1',
			'#4f46e5',
			'#4338ca',
			'#3730a3',
			'#312e81',
		],
	},
	{
		key: 'blue',
		name: '天蓝',
		color: '#3b82f6',
		palette: [
			'#eff6ff',
			'#dbeafe',
			'#bfdbfe',
			'#93c5fd',
			'#60a5fa',
			'#3b82f6',
			'#2563eb',
			'#1d4ed8',
			'#1e40af',
			'#1e3a8a',
		],
	},
	{
		key: 'cyan',
		name: '青色',
		color: '#06b6d4',
		palette: [
			'#ecfeff',
			'#cffafe',
			'#a5f3fc',
			'#67e8f9',
			'#22d3ee',
			'#06b6d4',
			'#0891b2',
			'#0e7490',
			'#155e75',
			'#164e63',
		],
	},
	{
		key: 'teal',
		name: '青绿',
		color: '#14b8a6',
		palette: [
			'#f0fdfa',
			'#ccfbf1',
			'#99f6e4',
			'#5eead4',
			'#2dd4bf',
			'#14b8a6',
			'#0d9488',
			'#0f766e',
			'#115e59',
			'#134e4a',
		],
	},
	{
		key: 'emerald',
		name: '翠绿',
		color: '#10b981',
		palette: [
			'#ecfdf5',
			'#d1fae5',
			'#a7f3d0',
			'#6ee7b7',
			'#34d399',
			'#10b981',
			'#059669',
			'#047857',
			'#065f46',
			'#064e3b',
		],
	},
	{
		key: 'violet',
		name: '紫罗兰',
		color: '#8b5cf6',
		palette: [
			'#f5f3ff',
			'#ede9fe',
			'#ddd6fe',
			'#c4b5fd',
			'#a78bfa',
			'#8b5cf6',
			'#7c3aed',
			'#6d28d9',
			'#5b21b6',
			'#4c1d95',
		],
	},
	{
		key: 'fuchsia',
		name: '洋红',
		color: '#d946ef',
		palette: [
			'#fdf4ff',
			'#fae8ff',
			'#f5d0fe',
			'#f0abfc',
			'#e879f9',
			'#d946ef',
			'#c026d3',
			'#a21caf',
			'#86198f',
			'#701a75',
		],
	},
	{
		key: 'rose',
		name: '玫瑰',
		color: '#f43f5e',
		palette: [
			'#fff1f2',
			'#ffe4e6',
			'#fecdd3',
			'#fda4af',
			'#fb7185',
			'#f43f5e',
			'#e11d48',
			'#be123c',
			'#9f1239',
			'#881337',
		],
	},
	{
		key: 'orange',
		name: '橙色',
		color: '#f97316',
		palette: [
			'#fff7ed',
			'#ffedd5',
			'#fed7aa',
			'#fdba74',
			'#fb923c',
			'#f97316',
			'#ea580c',
			'#c2410c',
			'#9a3412',
			'#7c2d12',
		],
	},
	{
		key: 'amber',
		name: '琥珀',
		color: '#f59e0b',
		palette: [
			'#fffbeb',
			'#fef3c7',
			'#fde68a',
			'#fcd34d',
			'#fbbf24',
			'#f59e0b',
			'#d97706',
			'#b45309',
			'#92400e',
			'#78350f',
		],
	},
	{
		key: 'slate',
		name: '石墨',
		color: '#64748b',
		palette: [
			'#f8fafc',
			'#f1f5f9',
			'#e2e8f0',
			'#cbd5e1',
			'#94a3b8',
			'#64748b',
			'#475569',
			'#334155',
			'#1e293b',
			'#0f172a',
		],
	},
	{
		key: 'zinc',
		name: '锌灰',
		color: '#71717a',
		palette: [
			'#fafafa',
			'#f4f4f5',
			'#e4e4e7',
			'#d4d4d8',
			'#a1a1aa',
			'#71717a',
			'#52525b',
			'#3f3f46',
			'#27272a',
			'#18181b',
		],
	},
]

/** 默认主题色 key */
export const DEFAULT_COLOR_KEY = 'emerald'

/** 根据 key 获取颜色预设 */
export function getColorPreset(key: string): ColorPreset {
	return COLOR_PRESETS.find((p) => p.key === key) ?? COLOR_PRESETS[0]
}

/** localStorage key */
export const THEME_COLOR_STORAGE_KEY = 'pluxel:theme:accent-color'

/** 主题变更事件名 */
export const THEME_CHANGE_EVENT = 'pluxel:theme-change'
