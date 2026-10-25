import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { fontFamilyName, textStyleColor } from './text-style'
import { selectionTextStyle } from './selection-format'
import { FloatingMenu } from './floating-menu'

const textColors = [
	{ label: '黑色', value: '#1f2937' },
	{ label: '灰色', value: '#64748b' },
	{ label: '红色', value: '#dc2626' },
	{ label: '橙色', value: '#ea580c' },
	{ label: '黄色', value: '#a16207' },
	{ label: '绿色', value: '#16a34a' },
	{ label: '青色', value: '#0891b2' },
	{ label: '蓝色', value: '#2563eb' },
	{ label: '紫色', value: '#9333ea' },
	{ label: '粉色', value: '#db2777' },
	{ label: '白色', value: '#ffffff' },
]
// Background presets remain light enough to read ordinary text over them.
const backgroundColors = [
	{ label: '灰色', value: '#e2e8f0' },
	{ label: '红色', value: '#fecaca' },
	{ label: '橙色', value: '#fed7aa' },
	{ label: '黄色', value: '#fef08a' },
	{ label: '绿色', value: '#bbf7d0' },
	{ label: '青色', value: '#a5f3fc' },
	{ label: '蓝色', value: '#bfdbfe' },
	{ label: '紫色', value: '#e9d5ff' },
	{ label: '粉色', value: '#fbcfe8' },
	{ label: '白色', value: '#ffffff' },
]
const fontSizes = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(
	(size) => `${size}pt`,
)
const hexColor = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i

function ColorPicker({
	editor,
	compact = false,
	background,
	value,
	disabled,
	apply,
}: {
	editor: Editor
	compact?: boolean
	background?: boolean
	value: string | null
	disabled: boolean
	apply(color: string | null): void
}) {
	const label = background ? '背景颜色' : '文字颜色'
	const colors = background ? backgroundColors : textColors
	const [open, setOpen] = useState(false)
	const [custom, setCustom] = useState('')
	const [composing, setComposing] = useState(false)
	const composingRef = useRef(composing)
	composingRef.current = composing
	const container = useRef<HTMLDivElement>(null)
	const popup = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const reference = useCallback(() => trigger.current!.getBoundingClientRect(), [])
	const id = useId()
	const rgba = textStyleColor(value)
	const currentHex = rgba
		? '#' +
			[rgba.red, rgba.green, rgba.blue, ...(rgba.alpha === 1 ? [] : [Math.round(rgba.alpha * 255)])]
				.map((channel) => channel.toString(16).padStart(2, '0'))
				.join('')
		: ''
	const focusSwatch = () => {
		const root = compact ? popup.current : container.current
		const initial =
			root?.querySelector<HTMLButtonElement>('[data-swatch][aria-pressed="true"]') ??
			root?.querySelector<HTMLButtonElement>('[data-swatch]')
		initial?.focus({ preventScroll: true })
	}
	useEffect(() => {
		if (!open) return
		const root = (compact ? popup.current : container.current)!
		const document = root.ownerDocument
		const contains = (node: Node | null) =>
			container.current?.contains(node) || popup.current?.contains(node)
		function outside(event: PointerEvent) {
			if (!contains(event.target as Node)) setOpen(false)
		}
		function focusOutside() {
			if (!contains(document.activeElement)) setOpen(false)
		}
		function navigate(event: KeyboardEvent) {
			if (event.isComposing || composingRef.current) return
			if (event.key === 'Escape') {
				event.preventDefault()
				event.stopPropagation()
				setOpen(false)
				trigger.current?.focus()
				return
			}
			const swatches = [...root.querySelectorAll<HTMLButtonElement>('[data-swatch]')]
			const index = swatches.indexOf(event.target as HTMLButtonElement)
			if (index < 0) return
			const steps: Record<string, number> = {
				ArrowLeft: -1,
				ArrowRight: 1,
				ArrowUp: -5,
				ArrowDown: 5,
				Home: -index,
				End: swatches.length - index - 1,
			}
			const step = steps[event.key]
			if (step === undefined) return
			event.preventDefault()
			swatches[(index + step + swatches.length) % swatches.length]?.focus()
		}
		document.addEventListener('pointerdown', outside)
		document.addEventListener('focusin', focusOutside)
		root.addEventListener('keydown', navigate)
		if (!compact) focusSwatch()
		const selection = editor.state.selection
		const doc = editor.state.doc
		const changed = () => {
			if (!selection.eq(editor.state.selection) || doc !== editor.state.doc) setOpen(false)
		}
		const hidden = new ResizeObserver(() => {
			if (editor.view.dom.getClientRects().length === 0) setOpen(false)
		})
		hidden.observe(editor.view.dom)
		editor.on('transaction', changed)
		return () => {
			hidden.disconnect()
			editor.off('transaction', changed)
			document.removeEventListener('pointerdown', outside)
			document.removeEventListener('focusin', focusOutside)
			root.removeEventListener('keydown', navigate)
		}
	}, [open, compact, editor])
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	function commit(color: string | null) {
		if (disabled || composing) return
		apply(color)
		setOpen(false)
		if (compact) editor.view.focus()
		else trigger.current?.focus({ preventScroll: true })
	}
	const palette = (
		<div id={id} role="dialog" tabIndex={-1} aria-label={label} className="typst-color-dialog">
			<div className="typst-color-heading">
				{label}
				{value === null ? ' · 混合' : ''}
			</div>
			<div className="typst-color-swatches" role="group" aria-label="预设颜色">
				{colors.map((color) => (
					<button
						key={color.value}
						type="button"
						data-swatch
						aria-label={color.label}
						title={color.label}
						aria-pressed={currentHex === color.value}
						disabled={composing}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => commit(color.value)}
					>
						<span
							aria-hidden="true"
							className="typst-color-sample"
							style={
								background
									? { backgroundColor: color.value }
									: {
											color: color.value,
											backgroundColor: color.value === '#ffffff' ? '#52525b' : undefined,
										}
							}
						>
							A
						</span>
					</button>
				))}
			</div>
			<form
				className="typst-color-custom"
				onCompositionStart={() => setComposing(true)}
				onCompositionEnd={() => setComposing(false)}
				onSubmit={(event) => {
					event.preventDefault()
					if (!composing && hexColor.test(custom)) commit(custom)
				}}
			>
				<label>
					<span>自定义</span>
					<input
						aria-label="色值"
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing || composing) {
								if (event.key === 'Enter') event.preventDefault()
								event.stopPropagation()
							}
						}}

						value={custom}
						placeholder="#RRGGBB"
						aria-invalid={!hexColor.test(custom)}
						onChange={(event) => setCustom(event.currentTarget.value)}
						spellCheck={false}
					/>
				</label>
				<button type="submit" disabled={composing || !hexColor.test(custom)}>
					应用
				</button>
			</form>
			<button
				type="button"
				className="typst-color-reset"
				disabled={composing}
				onClick={() => commit(null)}
			>
				清除颜色
			</button>
		</div>
	)
	return (
		<div ref={container} className="typst-color-menu">
			<button
				ref={trigger}
				type="button"
				className="typst-tool-button typst-color-trigger"
				aria-label={label}
				title={`${background ? '背景颜色 / 高亮' : label}：${value === null ? '混合' : currentHex || '继承模板'}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				disabled={disabled}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					setComposing(false)
					setCustom(currentHex || (background ? '#fef08a' : '#2563eb'))
					setOpen(!open)
				}}
			>
				<span
					aria-hidden="true"
					className={background ? 'typst-background-icon' : 'typst-color-icon'}
				>
					{background ? (
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.7"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="m9 11 8-8 4 4-8 8M9 11l-2 6 4-2M7 17l-3 3h5l2-5" />
						</svg>
					) : (
						'A'
					)}
					<span
						className={value === null ? 'typst-mixed-color' : undefined}
						style={{ backgroundColor: value || (background ? 'transparent' : 'currentColor') }}
					/>
				</span>
				{!compact && <span>{background ? '底色' : '文字'}</span>}
				<span aria-hidden="true" className="typst-picker-chevron">
					⌄
				</span>
			</button>
			{open &&
				(compact ? (
					<FloatingMenu
						editor={editor}
						reference={reference}
						elementRef={popup}
						onReady={focusSwatch}
						className="typst-toolbar-palette"
					>
						{palette}
					</FloatingMenu>
				) : (
					palette
				))}
		</div>
	)
}

interface TypographyProps {
	editor: Editor
	disabled: boolean
	chain(): ChainedCommands
}

/** Selects retain native keyboard focus; their values describe the entire native selection. */
export function FontTools({
	editor,
	disabled,
	fontFamilies,
	chain,
}: TypographyProps & { fontFamilies: readonly string[] }) {
	const { fontFamily, fontSize } = selectionTextStyle(editor)
	const families = [
		...new Set([
			...fontFamilies.map((family) => fontFamilyName(family) ?? family),
			...(fontFamily ? [fontFamily] : []),
		]),
	]
	const sizes = fontSize && !fontSizes.includes(fontSize) ? [...fontSizes, fontSize] : fontSizes
	return (
		<>
			<label
				className="typst-type-picker typst-font-picker"
				title={fontFamily === null ? '字体：混合' : fontFamily || '继承模板字体'}
			>
				<span>字体</span>
				<select
					aria-label="字体"
					value={fontFamily ?? '__mixed__'}
					disabled={disabled || (families.length === 0 && !fontFamily && fontFamily !== null)}
					onChange={(event) => {
						if (disabled || !editor.isEditable || editor.view.composing) return
						const value = event.currentTarget.value
						if (value)
							chain()
								.setFontFamily(fontFamilyName(value) ? value : JSON.stringify(value))
								.run()
						else chain().unsetFontFamily().run()
					}}
				>
					{fontFamily === null && (
						<option value="__mixed__" disabled>
							混合字体
						</option>
					)}
					<option value="">模板字体</option>
					{families.map((family) => (
						<option
							key={family}
							value={family}
							disabled={
								!editor
									.can()
									.setFontFamily(fontFamilyName(family) ? family : JSON.stringify(family))
							}
						>
							{family}
						</option>
					))}
				</select>
			</label>
			<label
				className="typst-type-picker typst-size-picker"
				title={fontSize === null ? '字号：混合' : fontSize || '继承模板字号'}
			>
				<span>字号</span>
				<select
					aria-label="字号"
					value={fontSize ?? '__mixed__'}
					disabled={disabled || !editor.can().setFontSize('18pt')}
					onChange={(event) => {
						if (disabled || !editor.isEditable || editor.view.composing) return
						const value = event.currentTarget.value
						if (value) chain().setFontSize(value).run()
						else chain().unsetFontSize().run()
					}}
				>
					{fontSize === null && (
						<option value="__mixed__" disabled>
							混合字号
						</option>
					)}
					<option value="">模板字号</option>
					{sizes.map((size) => (
						<option key={size} value={size}>
							{size}
						</option>
					))}
				</select>
			</label>
		</>
	)
}

export function ColorTools({
	editor,
	disabled,
	chain,
	compact = false,
}: TypographyProps & { compact?: boolean }) {
	const attributes = selectionTextStyle(editor)
	const canApply = () => !disabled && editor.isEditable && !editor.view.composing
	return (
		<>
			<ColorPicker
				editor={editor}
				compact={compact}
				value={attributes.color}
				disabled={disabled || !editor.can().setColor('#2563eb')}
				apply={(value) => {
					if (canApply()) (value ? chain().setColor(value) : chain().unsetColor()).run()
				}}
			/>
			<ColorPicker
				editor={editor}
				compact={compact}
				background
				value={attributes.backgroundColor}
				disabled={disabled || !editor.can().setBackgroundColor('#fef08a')}
				apply={(value) => {
					if (canApply())
						(value ? chain().setBackgroundColor(value) : chain().unsetBackgroundColor()).run()
				}}
			/>
		</>
	)
}

/** Uses the host's native history boundary; local state only owns an open palette. */
export function TypographyTools(props: TypographyProps & { fontFamilies: readonly string[] }) {
	const { editor, disabled, chain } = props
	const attributes = selectionTextStyle(editor)
	return (
		<div role="toolbar" aria-label="排版扩展" className="typst-typography">
			<div className="typst-tool-group">
				<FontTools {...props} />
			</div>
			<div className="typst-format-colors">
				<ColorTools {...props} />
			</div>
			<button
				type="button"
				className="typst-tool-button typst-typography-reset"
				aria-label="清除排版"
				title="清除字体、字号、文字颜色与背景颜色，保留其他格式"
				disabled={disabled || !Object.values(attributes).some((value) => value !== '')}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					if (!disabled && editor.isEditable && !editor.view.composing)
						chain().unsetMark('textStyle').run()
				}}
			>
				清除排版
			</button>
		</div>
	)
}
