import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Alert, Button, Group, NativeSelect, Select, Text, Textarea } from '@mantine/core'
import {
	TypstEditorToolbar,
	TypstFieldPicker,
	TypstBlockPicker,
	TypstRegionEditor,
	type TypstSlashCommand,
} from '@pluxel/plugin-typst/tiptap/react'
import {
	applyTypstCandidate,
	prepareTypstCandidate,
	validateTypstRegions,
	type TypstEditorConfig,
	type TypstMarkdownCandidate,
} from '@pluxel/plugin-typst/tiptap'
import { studioEditorConfig } from '../shared/editor'
import type { EditorDescription, EditorDraft } from '../shared/contracts'
import { useWorkspace } from './workspace-context'

const noticeCommand: TypstSlashCommand = {
	id: 'studio-notice',
	title: '提示块',
	description: '添加报告核对提醒',
	keywords: ['notice', '提示', '提醒'],
	command: (chain) =>
		chain.insertContent({
			type: 'notice',
			attrs: { tone: 'info' },
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'text', text: '请核对本报告的数据与建议。' }],
				},
			],
		}),
}
const studioSlashCommands = [noticeCommand]
const studioFontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']

function Region({
	entry,
	regionId,
	draft,
	config,
	active,
	onEditor,
}: {
	entry: string
	regionId: string
	draft: EditorDraft
	config: TypstEditorConfig
	active: boolean
	onEditor(editor: Editor | null): void
}) {
	const workspace = useWorkspace()
	const document = workspace.documents.get(entry)!
	const editorRef = useRef<Editor | null>(null)
	const [validationError, setValidationError] = useState('')
	const connect = useCallback(
		(editor: Editor | null) => {
			editorRef.current = editor
			onEditor(editor)
		},
		[onEditor],
	)
	const location = workspace.regionLocation
	useEffect(() => {
		const editor = editorRef.current
		if (!editor || !active || location?.entry !== entry || location.regionId !== regionId) return
		const max = editor.state.doc.content.size
		const from = Math.min(Math.max(0, location.from), max)
		const node = editor.state.doc.nodeAt(from)
		const selection =
			node?.isAtom && !node.isText && NodeSelection.isSelectable(node)
				? NodeSelection.create(editor.state.doc, from)
				: TextSelection.near(editor.state.doc.resolve(from))
		editor.view.dispatch(
			editor.state.tr
				.setSelection(selection)
				.setMeta('typst-navigation', location.source ?? true)
				.scrollIntoView(),
		)
		editor.view.focus()
	}, [active, entry, location, regionId])
	const pointer = useRef<{ x: number; y: number } | null>(null)
	return (
		<div
			hidden={!active}
			onPointerDown={(event) => {
				pointer.current = { x: event.clientX, y: event.clientY }
			}}
			onPointerUp={(event) => {
				const start = pointer.current
				pointer.current = null
				if (
					!start ||
					event.button !== 0 ||
					event.ctrlKey ||
					event.metaKey ||
					event.altKey ||
					event.shiftKey ||
					Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
					(event.target as HTMLElement).closest('.typst-content-block') ||
					!(event.target as HTMLElement).closest('.tiptap')
				)
					return
				const editor = editorRef.current
				if (editor?.state.selection instanceof NodeSelection) {
					const position = editor.state.selection.from
					if (editor.view.nodeDOM(position)?.contains(event.target as Node))
						workspace.revealRegion(entry, regionId, position)
					return
				}
				if (!window.getSelection()?.isCollapsed) return
				const selection = editor?.view.dom.ownerDocument.getSelection()
				if (!editor || !selection?.anchorNode || !editor.view.dom.contains(selection.anchorNode))
					return
				// DOM selection precedes ProseMirror's selectionchange transaction.
				workspace.revealRegion(
					entry,
					regionId,
					editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset),
				)
			}}
		>
			{validationError && (
				<Alert color="red" mb="sm">
					{validationError}
				</Alert>
			)}
			<TypstRegionEditor
				regionId={regionId}
				content={draft.regions[regionId]!}
				config={config}
				data={document.result?.data}
				className="studio-region-editor"
				placeholder="开始写作，输入 / 插入内容…"
				slashCommands={studioSlashCommands}
				onEditor={connect}
				onReveal={(position) => workspace.revealRegion(entry, regionId, position)}
				onValidationError={(issues) =>
					setValidationError(issues.map((issue) => issue.message).join('\n'))
				}
				onChange={(content) => {
					setValidationError('')
					void workspace.writeRegion(entry, regionId, content)
				}}
			>
				{(editor) => (
					<>
						<TypstEditorToolbar editor={editor} fontFamilies={studioFontFamilies}>
							<TypstFieldPicker
								editor={editor}
								fields={config.fields.filter((field) => {
									const rule = config.regions.find((region) => region.id === regionId)
									return (
										!rule?.fields ||
										rule.fields.some((path) => JSON.stringify(path) === JSON.stringify(field.path))
									)
								})}
							/>
							<TypstBlockPicker editor={editor} />
							<Button
								type="button"
								size="compact-xs"
								variant="subtle"
								color="gray"
								aria-label="插入提示块"
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => noticeCommand.command(editor.chain().focus()).run()}
							>
								提示块
							</Button>
						</TypstEditorToolbar>
					</>
				)}
			</TypstRegionEditor>
		</div>
	)
}

export function BodyEditor({
	entry,
	description,
}: {
	entry: string
	description: EditorDescription
}) {
	const workspace = useWorkspace()
	const document = workspace.documents.get(entry)!
	const draft = document.editor
	const [selected, setSelected] = useState(description.regions[0]?.id ?? '')
	const [candidate, setCandidate] = useState('')
	const [candidateRevision, setCandidateRevision] = useState<string | null>(null)
	const [candidateError, setCandidateError] = useState('')
	const [candidateRegion, setCandidateRegion] = useState(selected)
	const [candidateScope, setCandidateScope] = useState('region')
	const [candidateRange, setCandidateRange] = useState<TypstMarkdownCandidate['range']>()
	const editors = useRef(new Map<string, Editor>())
	const configKey = JSON.stringify({
		regions: description.regions,
		fields: description.fields,
		table: description.table,
		templates: description.templates,
		sourceBlocks: description.sourceBlocks,
	})
	const config = useMemo(() => studioEditorConfig(description), [configKey])
	const callbacks = useMemo(
		() =>
			new Map(
				description.regions.map((region) => [
					region.id,
					(editor: Editor | null) => {
						if (editor) editors.current.set(region.id, editor)
						else editors.current.delete(region.id)
					},
				]),
			),
		[configKey],
	)
	const location = workspace.regionLocation
	useEffect(() => {
		if (location?.entry === entry) setSelected(location.regionId)
	}, [entry, location])
	const mismatch = draft && draft.templateRevision !== description.templateRevision
	if (!draft)
		return (
			<Alert color="blue" title="尚未初始化正文">
				<Text size="sm">使用当前模板的初始正文创建区域草稿，保留已填写的数据。</Text>
				<Button size="xs" mt="sm" onClick={() => workspace.initializeEditorDraft(entry)}>
					初始化正文
				</Button>
			</Alert>
		)
	const checked = validateTypstRegions({ regions: draft.regions, config })
	if (!checked.ok)
		return (
			<Alert color="red" title="区域草稿需要修复">
				{checked.issues.map((issue) => issue.message).join('\n')}
				<details>
					<summary>保留的原始区域 JSON</summary>
					<pre>{JSON.stringify(draft.regions, null, 2)}</pre>
				</details>
			</Alert>
		)
	return (
		<div className="body-editor-scroll">
			{mismatch && (
				<Alert color="orange" title="模板修订已改变">
					<Text size="sm">草稿保持原样。校验现有正文后可显式采用当前模板。</Text>
					<Button size="xs" onClick={() => void workspace.adoptEditorTemplate(entry)}>
						采用当前模板
					</Button>
				</Alert>
			)}
			<Group className="body-editor-header" justify="space-between" mb="md" align="end">
				<Select
					label="正文区域"
					size="xs"
					value={selected}
					onChange={(value) => value && setSelected(value)}
					data={description.regions.map((region) => ({
						value: region.id,
						label: region.label ?? region.id,
					}))}
				/>
			</Group>
			{description.regions.map((region) => (
				<Region
					key={`${draft.templateId}:${draft.templateRevision}:${region.id}`}
					entry={entry}
					regionId={region.id}
					draft={draft}
					config={config}
					active={selected === region.id}
					onEditor={callbacks.get(region.id)!}
				/>
			))}
			<details className="studio-candidate">
				<summary>Markdown 导入与候选内容</summary>
				<Text size="xs" c="dimmed">
					候选独立暂存；选中块按完整顶层块替换，其他图表、组件与正文保留。开始后修改正文、数据或模板会使候选过期。
				</Text>
				<NativeSelect
					label="候选范围"
					size="xs"
					value={candidateScope}
					data={[
						{ value: 'region', label: '整个区域' },
						{ value: 'selection', label: '当前选中顶层块' },
					]}
					onChange={(event) => {
						setCandidateScope(event.currentTarget.value)
						setCandidateRevision(null)
						setCandidateRange(undefined)
					}}
				/>
				<Button
					size="xs"
					variant="subtle"
					onClick={() => {
						const editor = editors.current.get(selected)
						if (!editor) return
						let range: TypstMarkdownCandidate['range']
						if (candidateScope === 'selection') {
							const { $from, $to } = editor.state.selection
							range = {
								from: $from.depth ? $from.before(1) : $from.pos,
								to: $to.depth ? $to.after(1) : $to.pos,
							}
							if (range.from === range.to) {
								setCandidateError('请将光标放入正文块，或选中需要替换的完整块。')
								return
							}
						}
						setCandidateRange(range)
						setCandidateRevision(workspace.draftRevision(entry))
						setCandidateRegion(selected)
						setCandidateError('')
					}}
				>
					开始候选
				</Button>
				{candidateRevision !== null && (
					<Text size="xs" c="dimmed">
						{candidateRange ? '已固定选中块范围' : '已固定整个区域'} · {candidateRegion}
					</Text>
				)}
				<Textarea
					aria-label="Markdown 候选"
					value={candidate}
					onChange={(event) => setCandidate(event.currentTarget.value)}
					minRows={4}
				/>
				<Button
					size="xs"
					mt="xs"
					disabled={candidateRevision === null}
					onClick={() => {
						const editor = editors.current.get(candidateRegion)
						if (!editor || candidateRevision === null) return
						const prepared = prepareTypstCandidate({
							candidate: {
								regionId: candidateRegion,
								baseRevision: candidateRevision,
								markdown: candidate,
								range: candidateRange,
							},
							currentRevision: workspace.draftRevision(entry),
							document: draft.regions[candidateRegion]!,
							config,
							data: document.result?.data,
							canEdit: (id) =>
								!mismatch &&
								id === candidateRegion &&
								description.regions.some((region) => region.id === id),
						})
						if (!prepared.ok) {
							setCandidateError(prepared.issues.map((issue) => issue.message).join('\n'))
							return
						}
						const applied = applyTypstCandidate({
							editor,
							candidate: prepared.value,
							currentRevision: () => workspace.draftRevision(entry),
							config,
							regionId: candidateRegion,
							data: () => workspace.documents.get(entry)?.result?.data,
							canEdit: (id) =>
								id === candidateRegion &&
								workspace.documents.get(entry)?.editor?.templateRevision ===
									description.templateRevision,
						})
						setCandidateError(
							applied.ok ? '' : applied.issues.map((issue) => issue.message).join('\n'),
						)
						if (applied.ok) setCandidateRevision(null)
					}}
				>
					接纳候选
				</Button>
				{candidateError && (
					<Alert color="red" mt="xs">
						{candidateError}
					</Alert>
				)}
			</details>
		</div>
	)
}
