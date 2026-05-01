import type { RuntimeOpCatalogEntry } from '@pluxel/runtime/web'
import { getOwnerLabel, type OpsExplorerSelection } from './model'

export function renderResult(value: unknown): string {
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

export function getRunTone(entry: RuntimeOpCatalogEntry): 'brand' | 'orange' {
	return entry.workbench.mutating || entry.workbench.confirm ? 'orange' : 'brand'
}

export function getOwnerDisplay(entry: RuntimeOpCatalogEntry): string {
	return entry.ownerKind === 'plugin' ? getOwnerLabel(entry.owner) : entry.owner
}

export function selectionLabel(selection: OpsExplorerSelection, toolsetName?: string): string {
	switch (selection.kind) {
		case 'all':
			return '全部 Ops'
		case 'toolset':
			return toolsetName ?? 'Toolset'
		case 'ungrouped':
			return '未归组'
		case 'runtime':
			return '宿主 Ops'
		case 'owner':
			return selection.owner.startsWith('plugin:')
				? selection.owner.slice('plugin:'.length)
				: selection.owner
	}
}

export function selectionDescription(selection: OpsExplorerSelection): string {
	switch (selection.kind) {
		case 'all':
			return '全量 live registry 工作台，可搜索、批量编组和执行。'
		case 'toolset':
			return '宿主侧 toolset，适合保存跨插件的常用工具组合与用途描述。'
		case 'ungrouped':
			return '当前还未纳入任何 toolset 的 ops。'
		case 'runtime':
			return '宿主 runtime 提供的 canonical control-plane ops。'
		case 'owner':
			return '按插件 owner 聚焦浏览当前命中的 ops。'
	}
}

export function formatRunStamp(at: number): string {
	try {
		return new Intl.DateTimeFormat('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).format(at)
	} catch {
		return new Date(at).toLocaleTimeString()
	}
}

export function getToolsetSummaryDescription(summary: {
	description?: string
	availableCount: number
	missingCount: number
}) {
	if (summary.description) return summary.description
	if (summary.missingCount > 0) {
		return `${summary.availableCount} 可用 · ${summary.missingCount} 缺失`
	}
	return `${summary.availableCount} 个 op`
}
