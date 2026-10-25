import type { ChainedCommands } from '@tiptap/core'
import { NodeSelection, type Selection } from '@tiptap/pm/state'

export function selectedTable(selection: Selection) {
	if (selection instanceof NodeSelection && selection.node.type.name === 'table')
		return { node: selection.node, position: selection.from }
	for (let depth = selection.$from.depth; depth > 0; depth--) {
		const node = selection.$from.node(depth)
		if (node.type.name !== 'table') continue
		const position = selection.$from.before(depth)
		if (selection.to < position + node.nodeSize) return { node, position }
	}
	return undefined
}

export function tableActions(withHeaderRow: boolean) {
	const actions: { label: string; command(chain: ChainedCommands): ChainedCommands }[] = [
		{ label: '增加行', command: (chain) => chain.addRowAfter() },
		{ label: '在上方插入行', command: (chain) => chain.addRowBefore() },
		{ label: '增加列', command: (chain) => chain.addColumnAfter() },
		{ label: '在左侧插入列', command: (chain) => chain.addColumnBefore() },
		{ label: '合并单元格', command: (chain) => chain.mergeCells() },
		{ label: '拆分单元格', command: (chain) => chain.splitCell() },
		...(withHeaderRow
			? [{ label: '切换表头', command: (chain: ChainedCommands) => chain.toggleHeaderRow() }]
			: []),
		{ label: '删除行', command: (chain) => chain.deleteRow() },
		{ label: '删除列', command: (chain) => chain.deleteColumn() },
		{ label: '删除表格', command: (chain) => chain.deleteTable() },
	]
	return actions
}
