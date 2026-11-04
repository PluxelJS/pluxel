import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { TypstSourceProject } from '../source/state-types.js'
import type { TypstSlashCommand } from './insert-commands.js'
import { useSourceFormComposition } from './source-controls.js'
import { completeSourcePaths, resolveSourcePath, sourceLiteral } from './source-paths.js'

export function SourcePathInput({
	files,
	path,
	value,
	onChange,
	onAccept,
	label,
	readOnly = false,
	autoFocus = false,
}: {
	files: readonly string[]
	path: string
	value: string
	onChange(value: string): void
	/** Enter or a file click confirms the current action; Tab only completes the path. */
	onAccept?(value: string): void
	label: string
	readOnly?: boolean
	autoFocus?: boolean
}) {
	const id = useId(),
		input = useRef<HTMLInputElement>(null),
		list = useRef<HTMLDivElement>(null)
	const [open, setOpen] = useState(false),
		[choice, setChoice] = useState(0)
	const options = completeSourcePaths(files, path, value)
	const active = Math.min(choice, options.length - 1)
	const visible = open && !readOnly && options.length > 0
	useLayoutEffect(() => {
		const menu = list.current
		const item = menu?.children[active] as HTMLElement | undefined
		if (!menu || !item) return
		const top = item.offsetTop - menu.offsetTop
		if (top < menu.scrollTop) menu.scrollTop = top
		else if (top + item.offsetHeight > menu.scrollTop + menu.clientHeight)
			menu.scrollTop = top + item.offsetHeight - menu.clientHeight
	}, [active, value, visible])
	function choose(index: number, accept: boolean) {
		const option = options[index]
		if (!option) return
		onChange(option.value)
		setChoice(0)
		input.current?.focus()
		setOpen(option.directory)
		if (!option.directory && accept) onAccept?.(option.value)
	}
	return (
		<div
			className="typst-source-path"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
			}}
		>
			<label className="typst-node-control-label" htmlFor={id}>
				{label}
			</label>
			<input
				ref={input}
				id={id}
				role="combobox"
				aria-label={label}
				aria-autocomplete="list"
				aria-expanded={visible}
				aria-controls={visible ? `${id}-paths` : undefined}
				aria-activedescendant={visible && active >= 0 ? `${id}-path-${active}` : undefined}
				autoComplete="off"
				autoFocus={autoFocus}
				spellCheck={false}
				placeholder="输入相对路径，如 ../components/"
				value={value}
				readOnly={readOnly}
				onFocus={() => {
					setChoice(0)
					setOpen(true)
				}}
				onChange={(event) => {
					onChange(event.currentTarget.value)
					setChoice(0)
					setOpen(true)
				}}
				onKeyDown={(event) => {
					if (
						readOnly ||
						event.nativeEvent.isComposing ||
						event.ctrlKey ||
						event.metaKey ||
						event.altKey
					)
						return
					if (event.key === 'Escape' && visible) {
						event.preventDefault()
						event.stopPropagation()
						setOpen(false)
					} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault()
						setChoice(
							open && options.length > 0
								? (active + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
								: event.key === 'ArrowUp'
									? options.length - 1
									: 0,
						)
						setOpen(true)
					} else if (
						visible &&
						active >= 0 &&
						(event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))
					) {
						event.preventDefault()
						choose(active, event.key === 'Enter')
					}
				}}
			/>
			{visible && (
				<div
					ref={list}
					id={`${id}-paths`}
					role="listbox"
					aria-label="路径补全"
					className="typst-path-completions"
				>
					{options.map((option, index) => (
						<button
							type="button"
							role="option"
							key={option.value}
							id={`${id}-path-${index}`}
							aria-label={option.label}
							aria-selected={index === active}
							tabIndex={-1}
							onMouseDown={(event) => event.preventDefault()}
							onPointerMove={() => setChoice(index)}
							onClick={() => choose(index, true)}
						>
							<span aria-hidden="true" className="typst-path-kind">
								{option.directory ? '▸' : 'T'}
							</span>
							<span>{option.label}</span>
							{index === active && (
								<kbd>{option.directory ? '↵ 打开' : onAccept ? '↵ 确认' : 'Tab ↵'}</kbd>
							)}
						</button>
					))}
				</div>
			)}
			<p className="typst-source-path-help">
				相对于 {path.split('/').slice(0, -1).join('/') || '项目根目录'}
				{open && !readOnly && options.length === 0 ? ' · 没有匹配的 .typ 文件' : ''}
			</p>
		</div>
	)
}

export function SourceFileForm({
	project,
	path,
	kind,
	onInsert,
	onCancel,
}: {
	project: TypstSourceProject
	path: string
	kind: 'import' | 'include'
	onInsert(entry: TypstSlashCommand): boolean
	onCancel(): void
}) {
	const [revision] = useState(project.revision)
	const [module, setModule] = useState(''),
		[alias, setAlias] = useState('')
	const [mode, setMode] = useState<'namespace' | 'items'>('namespace'),
		[items, setItems] = useState('')
	const [error, setError] = useState('')
	const form = useRef<HTMLFormElement>(null)
	const isComposing = useSourceFormComposition(form)
	const title = kind === 'include' ? '插入章节' : '导入模块'
	const snapshot = project.snapshot()
	const files = Object.keys(snapshot.files)
	function validPath(value: string) {
		const target = resolveSourcePath(path, value)
		return (
			target !== undefined &&
			target !== path &&
			target.endsWith('.typ') &&
			Object.hasOwn(snapshot.files, target)
		)
	}
	function insert(value: string) {
		if (isComposing()) return
		if (project.revision !== revision) {
			setError('源码已改变，请重新打开文件引入。')
			return
		}
		if (!validPath(value)) {
			setError('请选择项目中的其他 .typ 文件。')
			return
		}
		if (kind === 'import' && mode === 'items' && !items.trim()) {
			setError('请填写需要导入的成员，或选择模块命名空间。')
			return
		}
		const source =
			kind === 'include'
				? `#include ${sourceLiteral(value)}`
				: `#import ${sourceLiteral(value)}${mode === 'items' ? `: ${items.trim()}` : alias.trim() ? ` as ${alias.trim()}` : ''}`
		const node =
			kind === 'include'
				? { type: 'typstInclude', attrs: { module: value, source } }
				: {
						type: 'typstImport',
						attrs: {
							module: value,
							alias: mode === 'namespace' ? alias.trim() || null : null,
							items: mode === 'items' ? items.trim() : null,
							source,
						},
					}
		const accepted = onInsert({
			id: `source-${kind}`,
			title,
			command: (chain) => {
				chain.command(() => project.revision === revision)
				return kind === 'import' ? chain.insertContentAt(0, node) : chain.insertContent(node)
			},
		})
		if (!accepted) setError('引入未接纳，请检查路径、别名或成员，并查看源码诊断。')
	}
	return (
		<section role="dialog" aria-label={title} className="typst-source-file-form">
			<div className="typst-node-panel-heading">
				<strong>{title}</strong>
				<button type="button" aria-label={`关闭${title}`} onClick={onCancel}>
					×
				</button>
			</div>
			<p className="typst-node-panel-description">
				{kind === 'include'
					? '将独立 .typ 文件的正文放在此处，适合拆分章节。'
					: '使用 .typ 文件里的函数、样式和其他定义。'}
			</p>
			<form
				ref={form}
				data-typst-unapplied={module || alias || items ? true : undefined}
				onSubmit={(event) => {
					event.preventDefault()
					insert(module)
				}}
			>
				<SourcePathInput
					files={files}
					path={path}
					value={module}
					onChange={(value) => {
						setModule(value)
						setError('')
					}}
					onAccept={insert}
					label={kind === 'include' ? '章节路径' : '模块路径'}
					autoFocus
				/>
				{kind === 'import' && (
					<details className="typst-source-import-options">
						<summary>别名或指定成员</summary>
						<label className="typst-node-control-label">
							导入方式
							<select
								aria-label="导入方式"
								value={mode}
								onChange={(event) => {
									setMode(event.currentTarget.value as 'namespace' | 'items')
									setError('')
								}}
							>
								<option value="namespace">模块命名空间</option>
								<option value="items">指定成员</option>
							</select>
						</label>
						{mode === 'namespace' ? (
							<label className="typst-node-control-label">
								模块别名
								<input
									aria-label="模块别名"
									placeholder="留空时使用文件名"
									value={alias}
									onChange={(event) => {
										setAlias(event.currentTarget.value)
										setError('')
									}}
								/>
							</label>
						) : (
							<label className="typst-node-control-label">
								导入成员
								<input
									aria-label="导入成员"
									placeholder="metrics, chart as plot 或 *"
									value={items}
									onChange={(event) => {
										setItems(event.currentTarget.value)
										setError('')
									}}
								/>
							</label>
						)}
					</details>
				)}
				{error && <p role="alert">{error}</p>}
				<div className="typst-node-panel-actions">
					<button
						type="submit"
						aria-label={title}
						disabled={
							!validPath(module) || (kind === 'import' && mode === 'items' && !items.trim())
						}
					>
						{title}
					</button>
					<button type="button" onClick={onCancel}>
						取消
					</button>
				</div>
			</form>
		</section>
	)
}
