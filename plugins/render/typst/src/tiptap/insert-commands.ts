import { CommandManager, isNodeActive, type ChainedCommands, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { allowedNode, canEdit, type EditorUiContext, type IconName } from './editor-ui'

/** Host insertion actions appear in both the insert menu and slash search.
 * Compose native commands without run(), focus(), dispatch or other side effects;
 * availability checks may call command more than once before committing one checked transaction. */
export interface TypstSlashCommand {
	id: string
	title: string
	description?: string
	keywords?: readonly string[]
	command(chain: ChainedCommands): ChainedCommands
}

export type BlockType =
	| 'paragraph'
	| 'blockquote'
	| 'codeBlock'
	| `heading-${1 | 2 | 3 | 4 | 5 | 6}`

export const blockTypes: { value: BlockType; label: string; node: string }[] = [
	{ value: 'paragraph', label: '正文', node: 'paragraph' },
	...[1, 2, 3, 4, 5, 6].map((level) => ({
		value: `heading-${level}` as BlockType,
		label: `标题 ${level}`,
		node: 'heading',
	})),
	{ value: 'blockquote', label: '引用', node: 'blockquote' },
	{ value: 'codeBlock', label: '代码块', node: 'codeBlock' },
]

export function convertBlock(chain: ChainedCommands, type: BlockType): ChainedCommands {
	return chain.command(({ state, commands, tr, dispatch }) => {
		// Native setNode only copies attrs for a single parent. Keep each selected
		// text block's alignment through its native mapping, including list lifting.
		const alignments: { position: number; value: unknown }[] = []
		if (dispatch && type !== 'codeBlock')
			state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
				if (node.type.name === 'paragraph' || node.type.name === 'heading')
					alignments.push({ position: position + 1, value: node.attrs.textAlign })
			})
		const mapFrom = tr.mapping.maps.length
		const preserveAlignment = (success: boolean) => {
			if (success && dispatch)
				for (const { position, value } of alignments) {
					const target = tr.doc.resolve(tr.mapping.slice(mapFrom).map(position))
					if (
						(target.parent.type.name === 'paragraph' || target.parent.type.name === 'heading') &&
						target.parent.attrs.textAlign !== value
					)
						tr.setNodeAttribute(target.before(), 'textAlign', value)
				}
			return success
		}
		if (type === 'codeBlock') {
			let containsInlineAtom = false
			state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
				if (!node.isTextblock) return
				node.forEach((child) => {
					if (!child.isText) containsInlineAtom = true
				})
				return false
			})
			if (containsInlineAtom) return false
		}
		if (isNodeActive(state, 'blockquote') && type !== 'blockquote' && !commands.lift('blockquote'))
			return false
		if (type.startsWith('heading-')) {
			const level = Number(type.slice(-1)) as 1 | 2 | 3 | 4 | 5 | 6
			return preserveAlignment(
				isNodeActive(state, 'heading', { level }) || commands.setHeading({ level }),
			)
		}
		if (type === 'blockquote') {
			if (isNodeActive(state, 'blockquote')) return true
			if (!isNodeActive(state, 'paragraph') && !commands.setParagraph()) return false
			return preserveAlignment(commands.wrapIn('blockquote'))
		}
		if (type === 'codeBlock') return isNodeActive(state, 'codeBlock') || commands.setCodeBlock()
		return preserveAlignment(isNodeActive(state, 'paragraph') || commands.setParagraph())
	})
}

export interface LocalInsertionTarget {
	at: number
	doc: ProseMirrorNode
}

export function isInsertionBoundary(doc: ProseMirrorNode, at: number): boolean {
	return (
		Number.isSafeInteger(at) && at >= 0 && at <= doc.content.size && doc.resolve(at).depth === 0
	)
}

export interface InsertEntry extends TypstSlashCommand {
	icon: IconName
	group: '段落' | '内容' | '数据字段' | '模板组件'
}

export interface TableSize {
	rows: number
	cols: number
	withHeaderRow: boolean
}

// Interactive creation stays bounded; native table commands retain their own full API.
export const tableSizeLimits = { rows: 50, cols: 20 } as const

export function tableEntry(size: TableSize): InsertEntry | undefined {
	if (
		!Number.isInteger(size.rows) ||
		size.rows < 1 ||
		size.rows > tableSizeLimits.rows ||
		!Number.isInteger(size.cols) ||
		size.cols < 1 ||
		size.cols > tableSizeLimits.cols ||
		typeof size.withHeaderRow !== 'boolean'
	)
		return undefined
	return {
		id: 'table',
		title: '表格',
		description: '选择行数、列数和表头',
		keywords: ['table'],
		icon: 'table',
		group: '内容',
		command: (chain) => chain.insertTable(size),
	}
}

export function insertEntries(
	editor: Editor,
	ui: EditorUiContext,
	local?: LocalInsertionTarget,
	query = '',
): InsertEntry[] {
	const paragraphs: InsertEntry[] = []
	for (const block of blockTypes) {
		if (!allowedNode(ui, editor, block.node)) continue
		const heading = block.value.startsWith('heading-')
		paragraphs.push({
			id: block.value,
			title: block.label,
			description: heading
				? `${block.value.slice(-1)} 级标题`
				: block.value === 'paragraph'
					? '普通正文段落'
					: block.value === 'blockquote'
						? '突出引用内容'
						: '保留空格与换行',
			keywords: heading
				? ['heading', 'title', `h${block.value.slice(-1)}`, '标题']
				: [block.value, '段落'],
			icon: heading
				? 'heading'
				: block.value === 'blockquote'
					? 'quote'
					: block.value === 'codeBlock'
						? 'code'
						: 'text',
			group: '段落',
			command: (chain) => convertBlock(chain, block.value),
		})
	}
	if (allowedNode(ui, editor, 'bulletList', 'listItem', 'paragraph'))
		paragraphs.push({
			id: 'bulletList',
			title: '无序列表',
			description: '用项目符号组织内容',
			keywords: ['bullet', 'list', '列表'],
			icon: 'bullet',
			group: '段落',
			command: (chain) => chain.toggleBulletList(),
		})
	if (allowedNode(ui, editor, 'orderedList', 'listItem', 'paragraph'))
		paragraphs.push({
			id: 'orderedList',
			title: '有序列表',
			description: '用编号组织步骤',
			keywords: ['ordered', 'number', 'list', '列表'],
			icon: 'ordered',
			group: '段落',
			command: (chain) => chain.toggleOrderedList(),
		})
	const entries: InsertEntry[] = []
	if (
		allowedNode(ui, editor, 'table', 'tableRow', 'tableCell', 'paragraph') &&
		(local || !editor.isActive('table'))
	)
		entries.push(
			tableEntry({ rows: 3, cols: 3, withHeaderRow: allowedNode(ui, editor, 'tableHeader') })!,
		)
	if (allowedNode(ui, editor, 'inlineMath'))
		entries.push({
			id: 'inlineMath',
			title: '行内公式',
			description: '在正文中插入 LaTeX 公式',
			keywords: ['math', 'latex', '公式'],
			icon: 'code',
			group: '内容',
			command: (chain) =>
				chain.command(({ commands, tr }) =>
					commands.insertInlineMath({ latex: 'x^2', pos: tr.selection.from }),
				),
		})
	if (allowedNode(ui, editor, 'blockMath'))
		entries.push({
			id: 'blockMath',
			title: '独立公式',
			description: '可编号、可引用的 LaTeX 公式',
			keywords: ['math', 'equation', 'latex', '公式'],
			icon: 'code',
			group: '内容',
			command: (chain) => chain.insertBlockMath({ latex: 'E = mc^2' }),
		})
	if (allowedNode(ui, editor, 'reference'))
		entries.push({
			id: 'reference',
			title: '交叉引用',
			description: '输入 @ 搜索图、表或公式',
			keywords: ['reference', '引用'],
			icon: 'link',
			group: '内容',
			command: (chain) => chain.insertContent({ type: 'text', text: '@' }),
		})
	if (allowedNode(ui, editor, 'horizontalRule'))
		entries.push({
			id: 'horizontalRule',
			title: '分隔线',
			description: '分隔文档内容',
			keywords: ['rule', 'divider', '分隔线'],
			icon: 'rule',
			group: '内容',
			command: (chain) => chain.setHorizontalRule(),
		})
	if (allowedNode(ui, editor, 'typstSource'))
		entries.push({
			id: 'typstSource',
			title: 'Typst 源码块',
			description: '编写当前文档的 Typst 源码',
			keywords: ['typst', 'source', '源码'],
			icon: 'code',
			group: '内容',
			command: (chain) =>
				chain.insertContent({ type: 'typstSource', attrs: { source: '#block[]', role: 'block' } }),
		})
	for (const item of ui.slashCommands)
		entries.push({ ...item, id: `custom:${item.id}`, icon: 'plus', group: '内容' })
	for (const entry of ui.sourceEntries?.(query) ?? []) entries.push(entry)
	return [...entries, ...paragraphs]
}

export function matchesInsertion(
	entry: Pick<TypstSlashCommand, 'title' | 'keywords'>,
	query: string,
): boolean {
	const normalized = query.trim().toLocaleLowerCase()
	return [entry.title, ...(entry.keywords ?? [])].some((term) =>
		term.toLocaleLowerCase().includes(normalized),
	)
}

/** Borrow native state to prepare without dispatching or running the region's
 * filterTransaction/onValidationError. Native composition and validators remain pure. */
export function prepareInsertion(
	editor: Editor,
	ui: EditorUiContext,
	entry: TypstSlashCommand,
	target?: { from: number; to: number } | LocalInsertionTarget,
): Transaction | undefined {
	if (!canEdit(editor, ui)) return undefined
	const local = target && 'at' in target ? target : undefined
	const range = target && 'from' in target ? target : undefined
	if (local && (local.doc !== editor.state.doc || !isInsertionBoundary(local.doc, local.at)))
		return undefined
	if (
		range &&
		(!Number.isSafeInteger(range.from) ||
			!Number.isSafeInteger(range.to) ||
			range.from < 0 ||
			range.to <= range.from ||
			range.to > editor.state.doc.content.size)
	)
		return undefined
	let transaction: Transaction | undefined
	const manager = new CommandManager({ editor, state: editor.state })
	const chain = manager.chain().command(({ tr }) => {
		closeHistory(tr)
		return true
	})
	if (local)
		chain
			.insertContentAt(local.at, { type: 'paragraph' }, { updateSelection: false })
			.setTextSelection(local.at + 1)
	if (range) chain.deleteRange(range)
	const success = entry
		.command(chain)
		.command(({ tr }) => {
			transaction = tr
			return true
		})
		.run()
	if (!success || !transaction) return undefined
	if (ui.validateDocument)
		return ui.validateDocument(transaction.doc.toJSON()) ? transaction.scrollIntoView() : undefined
	return transaction.scrollIntoView()
}
