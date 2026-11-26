import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useContent, useContentController } from '@worksplit/react'
import { findTypstSourceOffset } from '@pluxel/plugin-typst/source/browser'
import { TypstSourceEditor } from '@pluxel/plugin-typst/tiptap/react'
import type { Editor } from '@tiptap/core'
import { ApplicationForm } from './application-form'
import { renderComponentParameters } from './component-parameters'
import { useWorkspace } from './workspace-context'
import type { ExampleId } from './examples'

const encoder = new TextEncoder()
const fontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']
const editableFields = [{ file: 'data/sales.json', path: [] }] as const

/** One routed document owns one file draft; project transactions remain shared across tabs. */
export function EditorPane({ folder, path }: { folder: ExampleId; path: string }) {
	const workspace = useWorkspace()
	const project = workspace.folders[folder].project
	const revision = useSyncExternalStore(project.subscribe, () => project.revision)
	const value = project.snapshot().files[path]
	const source = typeof value === 'string' ? value : new TextDecoder().decode(value)
	const exists = Object.hasOwn(project.snapshot().files, path)
	const form = folder === 'application-form' && path === 'data/application.json'
	const [mode, setMode] = useState<'editor' | 'source' | 'form'>(
		form ? 'form' : path.endsWith('.typ') && project.isWritable(path) ? 'editor' : 'source',
	)
	const [draft, setDraft] = useState({ text: source, base: source, revision })
	const [unapplied, setUnapplied] = useState(false)
	const editor = useRef<Editor | null>(null)
	const panel = useRef<HTMLElement>(null)
	const sourceInput = useRef<HTMLTextAreaElement>(null)
	const openedSource = useRef(source)
	const sourceDirty = draft.text !== draft.base
	const pending = sourceDirty || unapplied
	const editVersion = useRef(0)
	const appliedFocus = useRef(0)
	const [leavePauses, setLeavePauses] = useState(0)
	const content = useContent()
	useContentController({
		title: path.split('/').at(-1)!,
		leave: {
			getState: () => ({
				hasUnsavedChanges: pending || source !== openedSource.current,
				token: `${revision}:${editVersion.current}`,
			}),
			decide: (request) => {
				if (
					pending &&
					!window.confirm('放弃这个标签页中尚未应用的输入？已应用的源码仍保留在项目中。')
				)
					return { decision: 'deny' }
				setLeavePauses((count) => count + 1)
				request.defer(() => setLeavePauses((count) => count - 1))
				return { decision: 'allow', token: `${revision}:${editVersion.current}` }
			},
		},
		focus: () => {
			if (mode === 'editor') editor.current?.commands.focus()
			else if (mode === 'source') sourceInput.current?.focus({ preventScroll: true })
		},
		save: () => {
			if (!workspace.save(folder)) throw new Error('项目尚未保存，请先处理当前输入。')
		},
	})
	useEffect(() => {
		if (source !== openedSource.current || pending) void workspace.workbench.keepOpen(content.id)
		workspace.setPending(content.id, folder, pending)
	}, [source, pending])
	useEffect(() => () => workspace.setPending(content.id, folder, false), [content.id, folder])
	useEffect(() => {
		setDraft((current) =>
			current.text === current.base ? { text: source, base: source, revision } : current,
		)
	}, [revision, source])
	useEffect(() => {
		if (!exists) void workspace.workbench.close(content.id)
	}, [exists])
	useEffect(() => {
		const check = () => {
			let dirty = Boolean(panel.current?.querySelector('[data-typst-unapplied]'))
			for (const button of panel.current?.querySelectorAll('[aria-controls]') ?? []) {
				const popup = document.getElementById(button.getAttribute('aria-controls')!)
				if (popup?.querySelector('[data-typst-unapplied]')) dirty = true
			}
			setUnapplied((current) => {
				if (current !== dirty) editVersion.current++
				return dirty
			})
		}
		const observer = new MutationObserver(check)
		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['data-typst-unapplied', 'aria-controls'],
		})
		check()
		return () => observer.disconnect()
	}, [content.id])
	const focus = workspace.focus
	const focusHere = focus?.folder === folder && focus.path === path
	function revealLocation(instance = editor.current) {
		if (!focusHere || !focus.location || appliedFocus.current === focus.serial) return
		const location = focus.location
		if (pending || project.revision !== location.revision) {
			appliedFocus.current = focus.serial
			return
		}
		if (location.kind === 'editor') {
			if (mode !== 'editor') {
				setMode('editor')
				return
			}
			if (!instance || instance.isDestroyed) return
			appliedFocus.current = focus.serial
			instance.commands.focus(location.position)
			return
		}
		if (mode !== 'source') {
			setMode('source')
			return
		}
		const input = sourceInput.current
		if (!input) return
		appliedFocus.current = focus.serial
		const offset = findTypstSourceOffset({ source: input.value, position: location.point })
		if (offset === undefined) return
		input.focus({ preventScroll: true })
		input.setSelectionRange(offset, offset)
	}
	useEffect(revealLocation, [focus?.serial, mode, pending, revision])
	const mayReplace = () => {
		if (pending) {
			workspace.report('有尚未应用的源码或参数，请先应用或取消。')
			return false
		}
		return true
	}
	function applySource() {
		if (!project.isWritable(path)) return
		const result = project.apply({
			baseRevision: draft.revision,
			patches: [{ path, from: 0, to: encoder.encode(draft.base).length, text: draft.text }],
		})
		if (!result.ok) {
			workspace.report(result.issues.map((issue) => issue.message).join('\n'))
			return
		}
		setDraft({ ...draft, base: draft.text, revision: project.revision })
		workspace.report('源码已接纳；编译结果单独报告。')
	}
	const writable = project.isWritable(path)
	return (
		<section
			ref={panel}
			className="workspace-panel"
			aria-label="文件编辑器"
			data-folder={folder}
			inert={leavePauses > 0}
			onInputCapture={() => {
				editVersion.current++
			}}
			data-file={path}
		>
			<nav className="region-tabs" aria-label="文件编辑方式">
				<span className="active-file" title={`${folder}/${path}`}>
					{path}
				</span>
				{!writable && <span className="file-access">只读</span>}
				<button
					type="button"
					aria-pressed={mode === 'editor' || mode === 'form'}
					disabled={!path.endsWith('.typ') && !form}
					onClick={() => {
						if (mayReplace()) setMode(form ? 'form' : 'editor')
					}}
				>
					{form ? '填写表单' : writable ? '结构化编辑' : '结构化视图'}
				</button>
				<button
					type="button"
					aria-pressed={mode === 'source'}
					onClick={() => {
						if (mayReplace()) setMode('source')
					}}
				>
					源码
				</button>
			</nav>
			{!exists ? (
				<p>文件已移除。</p>
			) : mode === 'form' ? (
				<ApplicationForm project={project} hasPending={unapplied} onIssue={workspace.report} />
			) : mode === 'editor' && path.endsWith('.typ') ? (
				<div className="editor-panel">
					<TypstSourceEditor
						project={project}
						path={path}
						editableFields={editableFields}
						fontFamilies={fontFamilies}
						renderComponentParameters={renderComponentParameters}
						onOpenFile={(file) => {
							void workspace.openFile(folder, file, { source: content })
						}}
						onEditor={(instance) => {
							editor.current = instance
							if (instance) revealLocation(instance)
						}}
						onSelection={(position) =>
							workspace.selectCaret(folder, {
								kind: 'editor',
								path,
								position,
								explicit: false,
								revision: project.revision,
							})
						}
						onReveal={(position) =>
							workspace.selectCaret(folder, {
								kind: 'editor',
								path,
								position,
								explicit: true,
								revision: project.revision,
							})
						}
						onReference={(file, position) => {
							void workspace.openFile(folder, file, {
								source: content,
								location: {
									kind: 'editor',
									position,
									revision: project.revision,
								},
							})
						}}
					/>
				</div>
			) : (
				<div className="input-panel">
					<label htmlFor={`source-${content.id}`}>{path}</label>
					<textarea
						ref={sourceInput}
						id={`source-${content.id}`}
						aria-label="文件源码"
						data-typst-unapplied={sourceDirty || undefined}
						spellCheck={false}
						readOnly={!writable}
						value={draft.text}
						onChange={(event) => setDraft({ ...draft, text: event.currentTarget.value })}
						onSelect={({ currentTarget: input }) => {
							if (pending || draft.revision !== project.revision || !path.endsWith('.typ')) return
							const prefix = input.value.slice(0, input.selectionStart)
							const lines = prefix.split('\n')
							workspace.selectCaret(folder, {
								kind: 'source',
								path,
								point: { path, line: lines.length, column: lines.at(-1)!.length + 1 },
								revision: draft.revision,
								explicit: false,
							})
						}}
					/>
					<button type="button" disabled={!writable || !sourceDirty} onClick={applySource}>
						应用文件源码
					</button>
					<button type="button" onClick={() => setDraft({ text: source, base: source, revision })}>
						重新载入当前源码
					</button>
				</div>
			)}
		</section>
	)
}
