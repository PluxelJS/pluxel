import { useEffect, useRef, useState } from 'react'
import { Alert, Box, LoadingOverlay } from '@mantine/core'
import { init } from 'modern-monaco'
import { registerLSPProvider } from 'modern-monaco/core'
import type { editor } from 'modern-monaco/editor-core'
import type { CompileResult } from '../shared/contracts'
import { isPaneVisible } from './source-navigation'
import typstGrammarUrl from '../../.editor-generated/typst.json?url&no-inline'
import lightThemeUrl from '../../.editor-generated/vitesse-light.json?url&no-inline'

registerLSPProvider('typescript', {
	aliases: ['javascript'],
	import: () => import('modern-monaco/lsp/typescript/setup'),
})

type Monaco = Awaited<ReturnType<typeof init>>
let initialized: Promise<Monaco> | undefined

/** All editor code, grammar, declarations and language workers are local app assets. */
export function initCodeEditor(): Promise<Monaco> {
	initialized ??= (async () => {
		const [grammar, theme] = await Promise.all(
			[typstGrammarUrl, lightThemeUrl].map(async (url) => {
				const response = await fetch(url)
				if (!response.ok) throw new Error(`编辑器资源加载失败: ${url}`)
				return response.json()
			}),
		)
		globalThis.MonacoEnvironment ??= {}
		Object.assign(globalThis.MonacoEnvironment, { useBuiltinLSP: false })
		const declaration = (name: string) =>
			new URL(`${import.meta.env.BASE_URL}types/${name}.d.ts`, document.baseURI).href
		const typstTemplate = declaration('typst-template')
		const valibot = declaration('valibot')
		const valibotForm = declaration('valibot-form')
		return init({
			defaultTheme: theme,
			langs: [grammar],
			lsp: {
				typescript: {
					importMap: {
						imports: {
							valibot,
							'valibot-form': valibotForm,
							'@pluxel/plugin-typst/template': typstTemplate,
						},
						scopes: {},
					},
					compilerOptions: { strict: true, types: [valibot, valibotForm, typstTemplate] },
				},
			},
		})
	})()
	return initialized
}

export interface CodeEditorProps {
	location?: { line: number; column: number; endLine?: number; endColumn?: number }
	workspaceId: string
	file: string
	files: Record<string, string>
	onChange(file: string, content: string): void
	/** A completed, unmodified mouse click, independent of programmatic cursor changes. */
	onClickPosition?(line: number, column: number): void
	readOnly?: boolean
	/** Pass diagnostics only for the current saved source revision. */
	diagnostics?: CompileResult['diagnostics']
}

export function CodeEditor(props: CodeEditorProps) {
	const container = useRef<HTMLDivElement>(null)
	const instance = useRef<editor.IStandaloneCodeEditor | null>(null)
	const models = useRef(new Map<string, editor.ITextModel>())
	const monacoRef = useRef<Monaco | null>(null)
	const latest = useRef(props)
	latest.current = props
	const applying = useRef(false)
	const [ready, setReady] = useState(false)
	const [error, setError] = useState<string>()

	function synchronize() {
		const monaco = monacoRef.current
		if (!monaco || !instance.current) return
		applying.current = true
		try {
			const current = latest.current
			instance.current.updateOptions({ readOnly: current.readOnly ?? false })
			for (const [file, model] of models.current) {
				if (!Object.hasOwn(current.files, file)) {
					model.dispose()
					models.current.delete(file)
				}
			}
			for (const [file, text] of Object.entries(current.files)) {
				let model = models.current.get(file)
				if (!model) {
					const language = file.endsWith('.typ')
						? 'typst'
						: /\.[cm]?tsx?$/.test(file)
							? 'typescript'
							: file.endsWith('.json')
								? 'json'
								: 'plaintext'
					const uri = monaco.Uri.parse(
						`file:///workspaces/${encodeURIComponent(current.workspaceId)}/${file.split('/').map(encodeURIComponent).join('/')}`,
					)
					model = monaco.editor.createModel(text, language, uri)
					models.current.set(file, model)
				} else if (model.getValue() !== text) {
					model.setValue(text)
				}
				const diagnostics =
					current.diagnostics?.filter(
						(diagnostic) => diagnostic.path?.replaceAll('\\', '/').replace(/^\.\//, '') === file,
					) ?? []
				monaco.editor.setModelMarkers(
					model,
					'typst-compiler',
					diagnostics.map((diagnostic) => {
						const range = model.validateRange({
							startLineNumber: (diagnostic.range?.start.line ?? 0) + 1,
							startColumn: (diagnostic.range?.start.character ?? 0) + 1,
							endLineNumber: (diagnostic.range?.end.line ?? diagnostic.range?.start.line ?? 0) + 1,
							endColumn:
								(diagnostic.range?.end.character ?? diagnostic.range?.start.character ?? 0) + 1,
						})
						return {
							startLineNumber: range.startLineNumber,
							startColumn: range.startColumn,
							endLineNumber: range.endLineNumber,
							endColumn: range.endColumn,
							message: diagnostic.message,
							source: 'Typst',
							severity:
								diagnostic.severity === 'error'
									? monaco.MarkerSeverity.Error
									: diagnostic.severity === 'warning'
										? monaco.MarkerSeverity.Warning
										: monaco.MarkerSeverity.Info,
						}
					}),
				)
			}
			const model = models.current.get(current.file)
			if (model && instance.current.getModel() !== model) instance.current.setModel(model)
		} finally {
			applying.current = false
		}
	}

	useEffect(() => {
		let disposed = false
		let overflowWidgets: HTMLDivElement | undefined
		setReady(false)
		setError(undefined)
		void initCodeEditor()
			.then((monaco) => {
				if (disposed || !container.current) return
				monacoRef.current = monaco
				// Monaco positions these widgets itself; placing its official overflow host
				// outside Worksplit prevents dock panes from clipping suggestions and hover.
				overflowWidgets = document.createElement('div')
				overflowWidgets.className = 'monaco-editor studio-editor-overflow'
				Object.assign(overflowWidgets.style, {
					position: 'fixed',
					inset: '0 auto auto 0',
					width: '0',
					height: '0',
					overflow: 'visible',
					zIndex: '2000',
				})
				document.body.append(overflowWidgets)
				instance.current = monaco.editor.create(container.current, {
					ariaLabel: '模板代码编辑器',
					// Monaco owns the ResizeObserver, including dock resize and tab visibility.
					automaticLayout: true,
					wordWrap: 'on',
					wrappingIndent: 'indent',
					theme: 'vitesse-light',
					fontSize: 13,
					editContext: false,
					minimap: { enabled: false },
					scrollBeyondLastLine: false,
					tabSize: 2,
					padding: { top: 12 },
					fixedOverflowWidgets: true,
					overflowWidgetsDomNode: overflowWidgets,
				})
				instance.current.onDidChangeModelContent(() => {
					if (applying.current) return
					const model = instance.current?.getModel()
					const file = [...models.current].find(([, candidate]) => candidate === model)?.[0]
					if (file && model) latest.current.onChange(file, model.getValue())
				})
				let mouseDown: { x: number; y: number; dragged: boolean } | undefined
				instance.current.onMouseDown(({ event, target }) => {
					mouseDown =
						event.leftButton &&
						!event.ctrlKey &&
						!event.metaKey &&
						!event.altKey &&
						!event.shiftKey &&
						(target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ||
							target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY)
							? { x: event.posx, y: event.posy, dragged: false }
							: undefined
				})
				instance.current.onMouseMove(({ event }) => {
					if (mouseDown && Math.hypot(mouseDown.x - event.posx, mouseDown.y - event.posy) > 4)
						mouseDown.dragged = true
				})
				instance.current.onMouseUp(({ event, target }) => {
					const start = mouseDown
					mouseDown = undefined
					if (
						!start ||
						start.dragged ||
						!target.position ||
						Math.hypot(start.x - event.posx, start.y - event.posy) > 4 ||
						!instance.current?.getSelection()?.isEmpty()
					)
						return
					latest.current.onClickPosition?.(target.position.lineNumber, target.position.column)
				})
				synchronize()
				setReady(true)
				return undefined
			})
			.catch((cause: unknown) => {
				if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
			})
		return () => {
			disposed = true
			instance.current?.dispose()
			instance.current = null
			overflowWidgets?.remove()
			for (const model of models.current.values()) model.dispose()
			models.current.clear()
			monacoRef.current = null
		}
	}, [props.workspaceId])

	useEffect(() => {
		synchronize()
	}, [props.file, props.files, props.diagnostics, props.readOnly, ready])
	useEffect(() => {
		if (!ready || !props.location || !instance.current || !isPaneVisible(container.current)) return
		const position = { lineNumber: props.location.line, column: props.location.column }
		if (props.location.endLine !== undefined && props.location.endColumn !== undefined)
			instance.current.setSelection({
				startLineNumber: position.lineNumber,
				startColumn: position.column,
				endLineNumber: props.location.endLine,
				endColumn: props.location.endColumn,
			})
		else instance.current.setPosition(position)
		instance.current.revealPositionInCenter(position)
		instance.current.focus()
	}, [props.location, ready])
	return (
		<Box pos="relative" h="100%" style={{ flex: '1 1 0', minWidth: 0, minHeight: 240 }}>
			{error && (
				<Alert color="red" title="代码编辑器加载失败">
					{error}
				</Alert>
			)}
			<LoadingOverlay visible={!ready && !error} />
			<div ref={container} style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 240 }} />
		</Box>
	)
}
