import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Alert, Button, Group, NativeSelect, Select, Text, Textarea } from '@mantine/core'
import { TypstSourceEditor, type TypstSlashCommand } from '@pluxel/plugin-typst/tiptap/react'
import {
	createTypstSourceProject,
	type TypstSourceProject,
	type TypstSourcePatch,
} from '@pluxel/plugin-typst/source/browser'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import type { EditorDescription } from '../shared/contracts'
import { sourceFiles } from '../shared/source-files'
import { useWorkspace } from './workspace-context'

const studioSlashCommands: readonly TypstSlashCommand[] = [
	{
		id: 'studio-notice',
		title: '提示块',
		description: '添加报告核对提醒',
		keywords: ['notice', '提示', '提醒'],
		command: (chain) =>
			chain.insertContent({
				type: 'typstSource',
				attrs: {
					source:
						'#block(fill: rgb("#e8f2ff"), inset: 8pt, width: 100%)[请核对本报告的数据与建议。]',
				},
			}),
	},
]
const studioFontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']
function Source({
	entry,
	path,
	project,
	active,
	onEditor,
}: {
	entry: string
	path: string
	project: TypstSourceProject
	active: boolean
	onEditor(path: string, editor: Editor | null): void
}) {
	const workspace = useWorkspace(),
		editorRef = useRef<Editor | null>(null),
		disconnect = useRef<(() => void) | undefined>(undefined)
	const connect = useCallback(
		(editor: Editor | null) => {
			disconnect.current?.()
			disconnect.current = editor ? workspace.registerBodyEditor(entry, path, editor) : undefined
			editorRef.current = editor
			if (editor)
				editor.setOptions({ editorProps: { attributes: { 'aria-label': `正文源码 ${path}` } } })
			onEditor(path, editor)
		},
		[workspace, entry, path, onEditor],
	)
	const pointer = useRef<{ x: number; y: number } | null>(null)
	const location = workspace.bodyLocation
	useEffect(() => {
		const editor = editorRef.current
		if (!editor || !active || location?.entry !== entry || location.path !== path) return
		const from = Math.min(Math.max(0, location.from), editor.state.doc.content.size),
			node = editor.state.doc.nodeAt(from)
		const selection =
			node?.isAtom && !node.isText && NodeSelection.isSelectable(node)
				? NodeSelection.create(editor.state.doc, from)
				: TextSelection.near(editor.state.doc.resolve(from))
		editor.view.focus()
		editor.view.dispatch(
			editor.state.tr.setSelection(selection).setMeta('typst-navigation', location.source ?? true),
		)
		const frame = requestAnimationFrame(() => {
			if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.scrollIntoView())
		})
		return () => cancelAnimationFrame(frame)
	}, [active, entry, path, location])
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
					(event.target as HTMLElement).closest('input,textarea,select,button,a') ||
					!(event.target as HTMLElement).closest('.tiptap')
				)
					return
				const editor = editorRef.current
				if (!editor) return
				const selection = editor.view.dom.ownerDocument.getSelection()
				if (
					selection?.isCollapsed &&
					selection.anchorNode &&
					editor.view.dom.contains(selection.anchorNode) &&
					(event.target as Node).contains(selection.anchorNode)
				) {
					// Native caret movement precedes ProseMirror's selectionchange transaction.
					workspace.revealBodySource(
						entry,
						path,
						editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset),
					)
					return
				}
				if (
					editor.state.selection instanceof NodeSelection &&
					editor.view.nodeDOM(editor.state.selection.from)?.contains(event.target as Node)
				)
					workspace.revealBodySource(entry, path, editor.state.selection.from)
			}}
		>
			<TypstSourceEditor
				project={project}
				path={path}
				editable={!workspace.documents.get(entry)?.bodyLocked}
				className="studio-region-editor"
				slashCommands={studioSlashCommands}
				fontFamilies={studioFontFamilies}
				onEditor={connect}
				onReveal={(position) => workspace.revealBodySource(entry, path, position)}
				onReference={(target, position) => void workspace.revealReference(entry, target, position)}
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
	const workspace = useWorkspace(),
		document = workspace.documents.get(entry)!,
		draft = document.editor
	const [project, setProject] = useState<TypstSourceProject>(),
		[error, setError] = useState(''),
		[selected, setSelected] = useState(description.sources[0]?.path ?? '')
	const [candidate, setCandidate] = useState(''),
		[scope, setScope] = useState('file'),
		[target, setTarget] = useState<{
			revision: number
			identity: string
			path: string
			from: number
			to: number
			original: string
		}>(),
		[prepared, setPrepared] = useState<TypstSourcePatch>()
	const editors = useRef(new Map<string, Editor>()),
		onEditor = useCallback((path: string, editor: Editor | null) => {
			if (editor) editors.current.set(path, editor)
			else editors.current.delete(path)
		}, [])
	const configKey = JSON.stringify(description)
	useEffect(() => {
		let active = true
		if (!draft) return
		void workspace
			.loadSourceProject(entry, configKey, () =>
				createTypstSourceProject({
					files: sourceFiles(document),
					writablePaths: [
						...description.sources.map((source) => source.path),
						entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json',
					],
					components: description.components,
					parserWasm,
				}),
			)
			.then((value) => {
				if (!active) return undefined
				setProject(value)
				setError('')
				return undefined
			})
			.catch((cause) => {
				if (active) setError(String(cause))
			})
		return () => {
			active = false
		}
	}, [entry, workspace, configKey, document.inputEpoch])
	const location = workspace.bodyLocation
	useEffect(() => {
		if (location?.entry === entry) setSelected(location.path)
	}, [entry, location])
	if (!project)
		return <Alert color={error ? 'red' : 'blue'}>{error || '正在读取 Typst 源码…'}</Alert>
	const current = () =>
		target &&
		target.revision === project.revision &&
		target.identity === workspace.draftRevision(entry)
	return (
		<div className="body-editor-scroll">
			<Group className="body-editor-header" justify="space-between" mb="md">
				<Select
					label="正文文件"
					size="xs"
					value={selected}
					onChange={(value) => value && setSelected(value)}
					data={description.sources.map((source) => ({
						value: source.path,
						label: source.label ?? source.path,
					}))}
				/>
			</Group>
			{description.sources.map((source) => (
				<Source
					key={source.path}
					entry={entry}
					path={source.path}
					project={project}
					active={selected === source.path}
					onEditor={onEditor}
				/>
			))}
			<details className="studio-candidate">
				<summary>Typst 源码与候选内容</summary>
				<Text size="xs" c="dimmed">
					固定目标后编辑普通 Typst 原文。选区映射为完整源码节点；正文、数据或模板改变会使候选过期。
				</Text>
				<NativeSelect
					label="候选范围"
					size="xs"
					value={scope}
					data={[
						{ value: 'file', label: '整个文件' },
						{ value: 'selection', label: '当前选中完整块' },
					]}
					onChange={(event) => {
						setScope(event.currentTarget.value)
						setTarget(undefined)
						setPrepared(undefined)
					}}
				/>
				<Button
					size="xs"
					variant="subtle"
					onClick={() => {
						try {
							const projection = project.open(selected),
								editor = editors.current.get(selected),
								bytes = new TextEncoder().encode(projection.source)
							let from = 0,
								to = bytes.length
							if (scope === 'selection') {
								if (!editor || editor.state.selection.empty) throw new Error('请先选择正文内容。')
								const { from: start, to: end } = editor.state.selection
								const nodes = projection.mapping.filter(
									(map) =>
										map.nodePath.length === 1 && map.position < end && map.endPosition > start,
								)
								if (nodes.length === 0) throw new Error('选区没有可确认的源码范围。')
								from = Math.min(...nodes.map((map) => map.from))
								to = Math.max(...nodes.map((map) => map.to))
							}
							const original = new TextDecoder('utf-8', { fatal: true }).decode(
								bytes.slice(from, to),
							)
							setTarget({
								revision: project.revision,
								identity: workspace.draftRevision(entry),
								path: selected,
								from,
								to,
								original,
							})
							if (!candidate || candidate === target?.original) setCandidate(original)
							setPrepared(undefined)
							setError('')
						} catch (cause) {
							setError(String(cause))
						}
					}}
				>
					固定候选目标
				</Button>
				{target && candidate !== target.original && (
					<Button
						size="xs"
						variant="subtle"
						onClick={() => {
							setCandidate(target.original)
							setPrepared(undefined)
							setError('')
						}}
					>
						用原文替换候选
					</Button>
				)}
				<Textarea
					aria-label="Typst 候选"
					value={candidate}
					onChange={(event) => {
						setCandidate(event.currentTarget.value)
						setPrepared(undefined)
					}}
					minRows={4}
				/>
				{target && (
					<div className="studio-candidate-review">
						<Text size="xs">
							目标：{target.path} · UTF-8 [{target.from}, {target.to})
						</Text>
						{!current() && (
							<Text size="xs" c="orange">
								目标已过期；请重新固定目标。
							</Text>
						)}
						<div className="studio-candidate-comparison">
							<section>
								<Text size="xs" fw={600}>
									原内容
								</Text>
								<pre>{target.original}</pre>
							</section>
							<section>
								<Text size="xs" fw={600}>
									待替换内容
								</Text>
								<pre>{candidate}</pre>
							</section>
						</div>
					</div>
				)}
				<Group mt="xs">
					<Button
						size="xs"
						disabled={!target}
						onClick={() => {
							if (!current()) {
								setError('候选目标已过期。')
								return
							}
							setPrepared({
								path: target!.path,
								from: target!.from,
								to: target!.to,
								text: candidate,
							})
							setError('')
						}}
					>
						查看修改预览
					</Button>
					<Button
						size="xs"
						disabled={!prepared || document.bodyLocked}
						onClick={() => {
							if (!prepared || !target || !current()) {
								setError('候选目标已过期。')
								return
							}
							if ([...editors.current.values()].some((editor) => editor.view.composing)) {
								setError('请完成输入法组合后接纳。')
								return
							}
							const result = project.apply({ baseRevision: target.revision, patches: [prepared] })
							setError(result.ok ? '' : result.issues.map((issue) => issue.message).join('\n'))
							if (result.ok) {
								setPrepared(undefined)
								setTarget(undefined)
							}
						}}
					>
						接纳候选
					</Button>
				</Group>
			</details>
			{error && <Alert color="red">{error}</Alert>}
		</div>
	)
}
