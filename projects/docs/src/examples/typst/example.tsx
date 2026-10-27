'use client'

import { useCallback, useRef, useState } from 'react'
import { TypstRegionEditor, type TypstRegionEditorProps } from '@pluxel/plugin-typst/tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import {
	ArrowUpRight,
	FileText,
	Workflow,
	RotateCcw,
	Square,
	Play,
	Terminal,
	CircleHelp,
} from 'lucide-react'
import {
	documentData,
	editorConfig,
	fontFamilies,
	initialDocument,
	initialSource,
} from './document'
import type { ExampleBlock, ExampleDraft, ThemeVersion } from './protocol'
import { useTypstRuntime } from './use-runtime'
import { ExamplePreview } from './preview'
import '@pluxel/plugin-typst/tiptap/style.css'
import './style.css'

export function TypstExample() {
	const [draft, setDraft] = useState<ExampleDraft>({
		source: initialSource,
		document: initialDocument,
		revision: 0,
	})
	const [epoch, setEpoch] = useState(0)
	const [example, setExample] = useState<'typst' | 'hmr'>('typst')
	const [pane, setPane] = useState<'editor' | 'source'>('editor')
	const { state, compilation, error, plugins, events, theme, update, restart, stop, replaceTheme } =
		useTypstRuntime(draft)
	const [selectedBlock, setSelectedBlock] = useState<string>()
	const [navigation, setNavigation] = useState('')
	const [validationError, setValidationError] = useState('')
	const editor = useRef<Parameters<NonNullable<TypstRegionEditorProps['onEditor']>>[0]>(null)
	const onEditor = useCallback<NonNullable<TypstRegionEditorProps['onEditor']>>((value) => {
		editor.current = value
	}, [])
	const revision = useRef(draft.revision)
	revision.current = draft.revision
	const pointer = useRef<{ x: number; y: number } | undefined>(undefined)
	const previewCurrent =
		compilation?.revision === draft.revision && compilation.theme === theme && state !== 'updating'

	function changed(change: Partial<Pick<ExampleDraft, 'source' | 'document'>>) {
		revision.current += 1
		const nextRevision = revision.current
		setDraft((previous) => ({ ...previous, ...change, revision: nextRevision }))
		setSelectedBlock(undefined)
		setNavigation('')
		setValidationError('')
	}

	function revealRegion(position: number) {
		if (!previewCurrent || !compilation || compilation.revision !== revision.current) return
		const block = compilation.blocks.find((item) => position >= item.from && position <= item.to)
		if (!block) return
		setSelectedBlock(block.id)
		setNavigation(`正文 → 预览：${block.label}`)
	}

	function navigateToEditor(block: ExampleBlock) {
		if (!previewCurrent || !compilation || compilation.revision !== revision.current) return
		const current = editor.current
		if (!current) return
		setExample('typst')
		setPane('editor')
		setSelectedBlock(block.id)
		setNavigation(`预览 → 正文：${block.label}`)
		const snapshotRevision = compilation.revision
		requestAnimationFrame(() => {
			if (snapshotRevision !== revision.current || current.isDestroyed) return
			current.view.dispatch(
				current.state.tr
					.setSelection(TextSelection.near(current.state.doc.resolve(block.from)))
					.setMeta('typst-navigation', true)
					.scrollIntoView(),
			)
			current.view.focus()
		})
	}

	const stateLabel = {
		stopped: '已停止',
		starting: '正在加载编译器和字体…',
		compiling: '正在编译…',
		updating: '正在热替换插件…',
		ready: error
			? '编译失败，请修改后重试'
			: previewCurrent
				? '运行中 · 自动编译'
				: '等待自动编译…',
		stopping: '正在释放资源…',
	}[state]
	const previewLabel =
		compilation && (error || validationError || state === 'stopped' || state === 'stopping')
			? '上次成功结果'
			: compilation && !previewCurrent
				? '正在更新 · 保留上次结果'
				: '点击定位正文块'

	return (
		<div className="typst-example" data-example={example}>
			<aside className="typst-example-sidebar">
				<h1>
					Examples <span>02</span>
				</h1>
				<nav aria-label="示例列表">
					<button
						type="button"
						aria-current={example === 'typst' ? 'page' : undefined}
						onClick={() => setExample('typst')}
					>
						<FileText aria-hidden="true" />
						<span>Typst 实时排版</span>
					</button>
					<button
						type="button"
						aria-current={example === 'hmr' ? 'page' : undefined}
						onClick={() => setExample('hmr')}
					>
						<Workflow aria-hidden="true" />
						<span>插件热替换</span>
					</button>
				</nav>
				<div className="typst-example-sidebar-footer">
					<span>浏览器内运行</span>
					<a href="/docs/plugins/rendering/typst#浏览器编译">
						接入文档 <ArrowUpRight aria-hidden="true" />
					</a>
				</div>
			</aside>
			<div className="typst-example-content">
				<header className="typst-example-toolbar">
					<div className="typst-example-title">
						<h2>{example === 'typst' ? 'Typst' : '插件热替换'}</h2>
						<span role="status" aria-live="polite" data-state={error ? 'error' : state}>
							{stateLabel}
							{previewCurrent && state === 'ready' ? ` · ${compilation.durationMs} ms` : ''}
						</span>
					</div>
					<div className="typst-example-actions">
						{state === 'stopped' ? (
							<button
								type="button"
								className="typst-example-run"
								onClick={restart}
								title="重新启动"
								aria-label="重新启动"
							>
								<Play aria-hidden="true" />
								<span>重新启动</span>
							</button>
						) : (
							<button
								type="button"
								disabled={state === 'stopping'}
								onClick={stop}
								title="停止"
								aria-label="停止"
							>
								<Square aria-hidden="true" />
								<span>停止</span>
							</button>
						)}
						<button
							type="button"
							title="恢复示例"
							aria-label="恢复示例"
							onClick={() => {
								changed({ source: initialSource, document: initialDocument })
								setEpoch((value) => value + 1)
								setPane('editor')
							}}
						>
							<RotateCcw aria-hidden="true" />
							<span>恢复示例</span>
						</button>
						<details className="typst-example-help">
							<summary title="使用说明" aria-label="使用说明">
								<CircleHelp aria-hidden="true" />
							</summary>
							<div>
								正文和模板修改后自动排版，点击两边可按正文块对照定位。首次加载 WASM
								和字体，之后可以离线使用。
								<a href="/docs/plugins/rendering/typst#浏览器编译">
									查看完整说明 <ArrowUpRight aria-hidden="true" />
								</a>
							</div>
						</details>
					</div>
				</header>
				<div className="typst-example-workspace">
					<section
						className="typst-example-editor"
						aria-label="Typst 编辑器"
						hidden={example !== 'typst'}
					>
						<div className="typst-example-pane-title">
							<div className="typst-example-tabs" role="tablist" aria-label="编辑方式">
								<button
									type="button"
									role="tab"
									id="example-editor-tab"
									aria-controls="example-editor-panel"
									aria-selected={pane === 'editor'}
									onClick={() => setPane('editor')}
								>
									正文编辑器
								</button>
								<button
									type="button"
									role="tab"
									id="example-source-tab"
									aria-controls="example-source-panel"
									aria-selected={pane === 'source'}
									onClick={() => setPane('source')}
								>
									Typst 模板
								</button>
							</div>
						</div>
						<div
							role="tabpanel"
							id="example-editor-panel"
							aria-labelledby="example-editor-tab"
							hidden={pane !== 'editor'}
						>
							<div
								className="typst-example-rich-editor"
								onPointerDown={(event) => {
									pointer.current = { x: event.clientX, y: event.clientY }
								}}
								onPointerUp={(event) => {
									const start = pointer.current
									pointer.current = undefined
									const current = editor.current
									const selection = current?.view.dom.ownerDocument.getSelection()
									if (
										!start ||
										!current ||
										event.button !== 0 ||
										event.ctrlKey ||
										event.metaKey ||
										event.altKey ||
										event.shiftKey ||
										Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
										!(event.target as HTMLElement).closest('.tiptap') ||
										!selection?.isCollapsed ||
										!selection.anchorNode ||
										!current.view.dom.contains(selection.anchorNode)
									)
										return
									revealRegion(current.view.posAtDOM(selection.anchorNode, selection.anchorOffset))
								}}
							>
								<TypstRegionEditor
									key={epoch}
									regionId="body"
									content={draft.document}
									config={editorConfig}
									data={documentData}
									fontFamilies={fontFamilies}
									editable
									onEditor={onEditor}
									onSelection={(position) => {
										if (editor.current?.isFocused && editor.current.state.selection.empty)
											revealRegion(position)
									}}
									onReveal={revealRegion}
									onChange={(content) => {
										changed({ document: content })
									}}
									onValidationError={(issues) =>
										setValidationError(issues.map((issue) => issue.message).join('\n'))
									}
								/>
							</div>
						</div>
						<div
							role="tabpanel"
							id="example-source-panel"
							aria-labelledby="example-source-tab"
							hidden={pane !== 'source'}
						>
							<textarea
								id="typst-source"
								aria-label="main.typ"
								spellCheck={false}
								maxLength={8_000}
								value={draft.source}
								onChange={(event) => {
									changed({ source: event.target.value })
								}}
							/>
						</div>
					</section>
					<section
						className="typst-example-replacement"
						aria-label="插件热替换演示"
						hidden={example !== 'hmr'}
					>
						<div className="typst-example-pane-title">
							<span>ThemePlugin</span>
							<span>代码版本</span>
						</div>
						<div className="typst-example-replacement-body">
							<label className="typst-example-theme">
								热替换排版插件
								<select
									aria-label="热替换排版插件"
									value={theme}
									disabled={state === 'starting' || state === 'stopped' || state === 'stopping'}
									onChange={(event) => {
										setNavigation('')
										replaceTheme(event.target.value as ThemeVersion)
									}}
								>
									<option value="classic">简洁版</option>
									<option value="color">彩色版</option>
								</select>
							</label>
							<p className="typst-example-hint">切换插件实现，观察右侧排版与下方生命周期变化。</p>
							<div className="typst-example-dependencies" aria-label="插件依赖">
								<div>
									<code>ThemePlugin</code>
									<span>排版规则</span>
								</div>
								<div>
									<code>TypstPlugin</code>
									<span>WASM 编译器</span>
								</div>
								<div>
									<code>ReportPlugin</code>
									<span>依赖两者生成文档</span>
								</div>
							</div>
							{update ? (
								<div className="typst-example-update" aria-label="热替换结果">
									<div>目录 #{update.catalogRevision}</div>
									<p>
										<span>替换：</span>
										<code>{update.replaced.join('、')}</code>
									</p>
									<p>
										<span>重启：</span>
										<code>{update.restarted.join('、')}</code>
									</p>
									<p>
										<span>保留：</span>
										<code>{update.retained.join('、')}</code>
									</p>
								</div>
							) : (
								<p className="typst-example-hint">
									当前插件：{plugins.length > 0 ? plugins.join('、') : '正在加载…'}
								</p>
							)}
							<p className="typst-example-hint">
								两版代码预先打包，由 Host 执行真实替换。编辑内容、撤销记录与编译器实例保留。
							</p>
						</div>
					</section>
					<section className="typst-example-preview" aria-label="文档预览">
						<div className="typst-example-pane-title">
							排版预览
							<span>{previewLabel}</span>
						</div>
						{compilation ? (
							<ExamplePreview
								compilation={compilation}
								navigationEnabled={previewCurrent}
								selectedBlock={selectedBlock}
								onNavigate={navigateToEditor}
							/>
						) : (
							<div className="typst-example-empty">
								<span aria-hidden="true">Aa</span>
								<p>{state === 'stopped' ? '运行已停止，可重新启动。' : stateLabel}</p>
							</div>
						)}
					</section>
				</div>
				<p className="typst-example-navigation" aria-live="polite">
					{compilation && !previewCurrent
						? '预览为上次结果，更新完成后恢复对照跳转。'
						: navigation ||
							(compilation?.blocks.length === 0
								? '模板未输出正文区域；引入 _editor/regions/body.typ 后可使用对照跳转。'
								: '点击正文或预览，双向定位到对应的段落、列表或表格。')}
				</p>
				{validationError || error ? (
					<pre role="alert" className="typst-example-error">
						{validationError || error}
					</pre>
				) : null}
				<details className="typst-example-runtime" open={example === 'hmr' ? true : undefined}>
					<summary>
						<Terminal aria-hidden="true" />
						<span>运行记录</span>
						<span className="typst-example-log-count">{events.length}</span>
					</summary>
					<ol aria-label="运行记录">
						{events.map((message, index) => (
							<li key={`${index}-${message}`}>{message}</li>
						))}
					</ol>
				</details>
			</div>
		</div>
	)
}
