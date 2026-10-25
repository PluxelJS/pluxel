import { CommandManager, type ChainedCommands, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Transaction } from '@tiptap/pm/state'
import { templateDefinitions } from './blocks'
import {
	allowedFields,
	allowedNode,
	canEdit,
	type EditorUiContext,
	type IconName,
} from './editor-ui'
import { validateTypstRegions } from './validation'

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

export function convertBlock(
	editor: Editor,
	chain: ChainedCommands,
	type: BlockType,
): ChainedCommands {
	if (editor.isActive('blockquote')) chain = chain.lift('blockquote')
	if (editor.isActive('codeBlock')) chain = chain.setParagraph()
	if (type.startsWith('heading-'))
		return chain.setHeading({ level: Number(type.slice(-1)) as 1 | 2 | 3 | 4 | 5 | 6 })
	if (type === 'blockquote') return chain.setParagraph().wrapIn('blockquote')
	if (type === 'codeBlock') return chain.setCodeBlock()
	return chain.setParagraph()
}

export interface InsertEntry extends TypstSlashCommand {
	icon: IconName
	group: '段落' | '内容' | '数据字段' | '模板组件'
}

export function insertEntries(editor: Editor, ui: EditorUiContext): InsertEntry[] {
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
			command: (chain) => convertBlock(editor, chain, block.value),
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
		!editor.isActive('table')
	)
		entries.push({
			id: 'table',
			title: '表格',
			description: '插入 3 × 3 表格',
			keywords: ['table'],
			icon: 'table',
			group: '内容',
			command: (chain) =>
				chain.insertTable({
					rows: 3,
					cols: 3,
					withHeaderRow: allowedNode(ui, editor, 'tableHeader'),
				}),
		})
	if (allowedNode(ui, editor, 'typstSource'))
		entries.push({
			id: 'typstSource',
			title: 'Typst 源码块',
			description: '编写当前文档的 Typst 源码',
			keywords: ['typst', 'source', '源码'],
			icon: 'code',
			group: '内容',
			command: (chain) => chain.insertTypstSource(''),
		})
	for (const item of ui.slashCommands)
		entries.push({ ...item, id: `custom:${item.id}`, icon: 'plus', group: '内容' })
	for (const field of allowedFields(ui, editor, ui.config?.fields ?? []))
		entries.push({
			id: `field:${JSON.stringify(field.path)}`,
			title: field.label,
			description: `数据字段 · ${field.path.join(' / ')}`,
			keywords: ['field', '字段', ...field.path],
			icon: 'field',
			group: '数据字段',
			command: (chain) =>
				chain.insertContent({ type: 'dataField', attrs: { path: [...field.path] } }),
		})
	if (allowedNode(ui, editor, 'templateBlock'))
		for (const definition of templateDefinitions(editor.extensionManager.extensions))
			entries.push({
				id: `template:${definition.id}`,
				title: definition.label,
				description: '模板组件',
				keywords: ['template', '组件', definition.id],
				icon: 'plus',
				group: '模板组件',
				command: (chain) => chain.insertTypstTemplateBlock({ template: definition.id }),
			})
	return [...entries, ...paragraphs]
}

export function matchesInsertion(entry: TypstSlashCommand, query: string): boolean {
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
	range?: { from: number; to: number },
): Transaction | undefined {
	if (!canEdit(editor, ui)) return undefined
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
	if (range) chain.deleteRange(range)
	const success = entry
		.command(chain)
		.command(({ tr }) => {
			transaction = tr
			return true
		})
		.run()
	if (!success || !transaction) return undefined
	if (
		ui.config &&
		ui.region &&
		!validateTypstRegions({
			regions: { [ui.region.id]: transaction.doc.toJSON() },
			config: ui.config,
		}).ok
	)
		return undefined
	return transaction.scrollIntoView()
}
