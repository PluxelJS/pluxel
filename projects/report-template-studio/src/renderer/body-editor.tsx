import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Alert, Button, Group, NativeSelect, Select, Text, Textarea } from '@mantine/core'
import { TypstRegionEditor, type TypstSlashCommand } from '@pluxel/plugin-typst/tiptap/react'
import {
	applyTypstCandidate,
	captureTypstCandidateTarget,
	exportTypstMarkdown,
	prepareTypstCandidate,
	validateTypstRegions,
	type TypstEditorConfig,
	type TypstMarkdownCandidate,
	type TypstPreparedCandidate,
} from '@pluxel/plugin-typst/tiptap'
import { studioEditorConfig } from '../shared/editor'
import type { EditorDescription, EditorDraft } from '../shared/contracts'
import { useWorkspace } from './workspace-context'

const studioSlashCommands: readonly TypstSlashCommand[] = [
	{
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
	},
]
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
				fontFamilies={studioFontFamilies}
				onEditor={connect}
				onReveal={(position) => workspace.revealRegion(entry, regionId, position)}
				onValidationError={(issues) =>
					setValidationError(issues.map((issue) => issue.message).join('\n'))
				}
				onChange={(content) => {
					setValidationError('')
					void workspace.writeRegion(entry, regionId, content)
				}}
			/>
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
	const [candidateTarget, setCandidateTarget] = useState<
		Omit<TypstMarkdownCandidate, 'markdown'> & { original: string }
	>()
	const [candidateReview, setCandidateReview] = useState<TypstPreparedCandidate>()
	const [candidateError, setCandidateError] = useState('')
	const [candidateScope, setCandidateScope] = useState('region')
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
					先固定目标，再查看原文与候选对照。字符选区扩展为完整顶层块；范围外图表和表格保留。正文、数据或模板变化会使候选过期。
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
						setCandidateTarget(undefined)
						setCandidateReview(undefined)
					}}
				/>
				<Button
					size="xs"
					variant="subtle"
					onClick={() => {
						const editor = editors.current.get(selected)
						if (!editor) return
						const target = captureTypstCandidateTarget({
							selection: editor.state.selection,
							regionId: selected,
							baseRevision: workspace.draftRevision(entry),
							scope: candidateScope === 'selection' ? 'blocks' : 'region',
						})
						if (!target.ok) {
							setCandidateError(target.issues.map((issue) => issue.message).join('\n'))
							return
						}
						const from = target.value.range?.from ?? 0
						const to = target.value.range?.to ?? editor.state.doc.content.size
						const original = exportTypstMarkdown({
							document: editor.state.doc.cut(from, to).toJSON(),
							regionId: selected,
							config,
							data: document.result?.data,
						})
						setCandidateTarget({
							...target.value,
							original: original.ok ? original.value.markdown : JSON.stringify(original.issues),
						})
						setCandidateReview(undefined)
						setCandidateError('')
					}}
				>
					固定候选目标
				</Button>
				<Textarea
					aria-label="Markdown 候选"
					value={candidate}
					onChange={(event) => {
						setCandidate(event.currentTarget.value)
						setCandidateReview(undefined)
					}}
					minRows={4}
				/>
				{candidateTarget && (
					<div className="studio-candidate-review">
						<Text size="xs">
							目标：{candidateTarget.regionId} ·{' '}
							{candidateTarget.range
								? `完整顶层块 [${candidateTarget.range.from}, ${candidateTarget.range.to})`
								: '整个区域'}
						</Text>
						{candidateTarget.baseRevision !== workspace.draftRevision(entry) && (
							<Text size="xs" c="orange">
								目标已过期；请明确重新固定目标。
							</Text>
						)}
						<div className="studio-candidate-comparison">
							<section>
								<Text size="xs" fw={600}>
									原内容
								</Text>
								<pre>{candidateTarget.original}</pre>
							</section>
							<section>
								<Text size="xs" fw={600}>
									待替换内容
								</Text>
								<pre>{candidate}</pre>
							</section>
						</div>
						<Text size="xs" c="dimmed">
							{candidateReview
								? '已准备；接纳将提交以上候选，一次撤销可恢复。'
								: '尚未准备或文字已修改，请查看修改预览后再接纳。'}
						</Text>
					</div>
				)}
				<Group mt="xs">
					<Button
						size="xs"
						disabled={!candidateTarget}
						onClick={() => {
							if (!candidateTarget) return
							const editor = editors.current.get(candidateTarget.regionId)
							if (!editor) return
							const { regionId, baseRevision, range } = candidateTarget
							const prepared = prepareTypstCandidate({
								candidate: { regionId, baseRevision, range, markdown: candidate },
								currentRevision: workspace.draftRevision(entry),
								document: editor.getJSON(),
								config,
								data: document.result?.data,
								canEdit: (id) =>
									!mismatch &&
									!editor.view.composing &&
									id === regionId &&
									description.regions.some((region) => region.id === id),
							})
							setCandidateReview(prepared.ok ? prepared.value : undefined)
							setCandidateError(
								prepared.ok ? '' : prepared.issues.map((issue) => issue.message).join('\n'),
							)
						}}
					>
						查看修改预览
					</Button>
					<Button
						size="xs"
						disabled={!candidateReview}
						onClick={() => {
							if (!candidateReview) return
							const editor = editors.current.get(candidateReview.regionId)
							if (!editor) return
							const applied = applyTypstCandidate({
								editor,
								candidate: candidateReview,
								currentRevision: () => workspace.draftRevision(entry),
								config,
								regionId: candidateReview.regionId,
								data: () => workspace.documents.get(entry)?.result?.data,
								canEdit: (id) =>
									id === candidateReview.regionId &&
									!editor.view.composing &&
									workspace.documents.get(entry)?.editor?.templateRevision ===
										description.templateRevision,
							})
							setCandidateError(
								applied.ok ? '' : applied.issues.map((issue) => issue.message).join('\n'),
							)
							if (applied.ok) {
								setSelected(candidateReview.regionId)
								setCandidateReview(undefined)
								setCandidateTarget(undefined)
							}
						}}
					>
						接纳候选
					</Button>
				</Group>
				{candidateError && (
					<Alert color="red" mt="xs">
						{candidateError}
					</Alert>
				)}
			</details>
		</div>
	)
}
