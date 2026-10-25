import { useEffect, useId, useRef, useState } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { fontFamilyName, textStyleColor } from './text-style'

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
	background,
	value,
	disabled,
	apply,
}: {
	background?: boolean
	value: string
	disabled: boolean
	apply(color: string | null): void
}) {
	const label = background ? '背景颜色' : '文字颜色'
	const colors = background ? backgroundColors : textColors
	const [open, setOpen] = useState(false)
	const [custom, setCustom] = useState('')
	const container = useRef<HTMLDivElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const id = useId()
	const rgba = textStyleColor(value)
	const currentHex = rgba
		? '#' +
			[rgba.red, rgba.green, rgba.blue, ...(rgba.alpha === 1 ? [] : [Math.round(rgba.alpha * 255)])]
				.map((channel) => channel.toString(16).padStart(2, '0'))
				.join('')
		: ''
	useEffect(() => {
		if (!open) return
		const root = container.current!
		const document = root.ownerDocument
		function outside(event: PointerEvent) {
			if (!container.current?.contains(event.target as Node)) setOpen(false)
		}
		function focusOutside() {
			if (!container.current?.contains(document.activeElement)) setOpen(false)
		}
		function navigate(event: KeyboardEvent) {
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
		const initial =
			root.querySelector<HTMLButtonElement>('[data-swatch][aria-pressed="true"]') ??
			root.querySelector<HTMLButtonElement>('[data-swatch]')
		initial?.focus()
		return () => {
			document.removeEventListener('pointerdown', outside)
			document.removeEventListener('focusin', focusOutside)
			root.removeEventListener('keydown', navigate)
		}
	}, [open])
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	function commit(color: string | null) {
		if (disabled) return
		apply(color)
		setOpen(false)
		trigger.current?.focus({ preventScroll: true })
	}
	return (
		<div ref={container} className="typst-color-menu">
			<button
				ref={trigger}
				type="button"
				className="typst-tool-button typst-color-trigger"
				aria-label={label}
				title={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				disabled={disabled}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
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
						style={{ backgroundColor: value || (background ? 'transparent' : 'currentColor') }}
					/>
				</span>
				<span>{background ? '底色' : '文字'}</span>
				<span aria-hidden="true" className="typst-picker-chevron">
					⌄
				</span>
			</button>
			{open && (
				<div id={id} role="dialog" tabIndex={-1} aria-label={label} className="typst-color-dialog">
					<div className="typst-color-heading">{label}</div>
					<div className="typst-color-swatches" role="group" aria-label="预设颜色">
						{colors.map((color) => (
							<button
								key={color.value}
								type="button"
								data-swatch
								aria-label={color.label}
								title={color.label}
								aria-pressed={currentHex === color.value}
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
						onSubmit={(event) => {
							event.preventDefault()
							if (hexColor.test(custom)) commit(custom)
						}}
					>
						<label>
							<span>自定义</span>
							<input
								aria-label="色值"
								value={custom}
								placeholder="#RRGGBB"
								aria-invalid={!hexColor.test(custom)}
								onChange={(event) => setCustom(event.currentTarget.value)}
								spellCheck={false}
							/>
						</label>
						<button type="submit" disabled={!hexColor.test(custom)}>
							应用
						</button>
					</form>
					<button type="button" className="typst-color-reset" onClick={() => commit(null)}>
						清除颜色
					</button>
				</div>
			)}
		</div>
	)
}

/** Uses the host's native history boundary; local state only owns an open palette. */
export function TypographyTools({
	editor,
	disabled,
	fontFamilies,
	chain,
}: {
	editor: Editor
	disabled: boolean
	fontFamilies: readonly string[]
	chain(): ChainedCommands
}) {
	const attributes = editor.getAttributes('textStyle')
	const fontFamily =
		typeof attributes.fontFamily === 'string'
			? attributes.fontFamily.replace(/^(['"])(.*)\1$/, '$2')
			: ''
	const fontSize = typeof attributes.fontSize === 'string' ? attributes.fontSize : ''
	const families = [...new Set([...fontFamilies, ...(fontFamily ? [fontFamily] : [])])]
	const sizes = fontSize && !fontSizes.includes(fontSize) ? [...fontSizes, fontSize] : fontSizes
	return (
		<div role="toolbar" aria-label="排版扩展" className="typst-typography">
			<div className="typst-tool-group">
				<label className="typst-type-picker typst-font-picker">
					<span>字体</span>
					<select
						aria-label="字体"
						value={fontFamily}
						disabled={
							disabled || families.length === 0 || !editor.can().setFontFamily(families[0]!)
						}
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
						<option value="">模板字体</option>
						{families.map((family) => (
							<option key={family} value={family}>
								{family}
							</option>
						))}
					</select>
				</label>
				<label className="typst-type-picker typst-size-picker">
					<span>字号</span>
					<select
						aria-label="字号"
						value={fontSize}
						disabled={disabled || !editor.can().setFontSize('18pt')}
						onChange={(event) => {
							if (disabled || !editor.isEditable || editor.view.composing) return
							const value = event.currentTarget.value
							if (value) chain().setFontSize(value).run()
							else chain().unsetFontSize().run()
						}}
					>
						<option value="">模板字号</option>
						{sizes.map((size) => (
							<option key={size} value={size}>
								{size}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="typst-format-colors">
				<ColorPicker
					value={attributes.color ?? ''}
					disabled={disabled || !editor.can().setColor('#2563eb')}
					apply={(value) => (value ? chain().setColor(value).run() : chain().unsetColor().run())}
				/>
				<ColorPicker
					background
					value={attributes.backgroundColor ?? ''}
					disabled={disabled || !editor.can().setBackgroundColor('#fef08a')}
					apply={(value) =>
						value ? chain().setBackgroundColor(value).run() : chain().unsetBackgroundColor().run()
					}
				/>
			</div>
			<button
				type="button"
				className="typst-tool-button typst-typography-reset"
				aria-label="清除排版"
				title="清除字体、字号、文字颜色与背景颜色，保留其他格式"
				disabled={
					disabled ||
					!Object.values(attributes).some((value) => value !== null && value !== undefined)
				}
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
