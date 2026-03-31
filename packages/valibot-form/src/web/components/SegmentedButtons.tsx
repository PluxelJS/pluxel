import { Box, Text } from '@mantine/core'
import { type ReactNode, useMemo, useRef, useState } from 'react'

export type SegmentedButtonOption = {
	value: string
	label: ReactNode
	description?: ReactNode
	disabled?: boolean
}

export interface SegmentedButtonsProps {
	data: Array<string | SegmentedButtonOption>
	value?: string | null
	onChange?: (value: string) => void
	onBlur?: () => void
	disabled?: boolean
	fullWidth?: boolean
	size?: 'xs' | 'sm' | 'md'
}

const SIZE_STYLES = {
	xs: {
		minHeight: 28,
		padding: '5px 10px',
		labelSize: 'xs',
		descriptionSize: '10px',
	},
	sm: {
		minHeight: 32,
		padding: '6px 12px',
		labelSize: 'sm',
		descriptionSize: '11px',
	},
	md: {
		minHeight: 36,
		padding: '7px 14px',
		labelSize: 'sm',
		descriptionSize: '12px',
	},
} as const

function normalizeOption(option: string | SegmentedButtonOption): SegmentedButtonOption {
	if (typeof option === 'string') {
		return { value: option, label: option }
	}
	return option
}

export function SegmentedButtons({
	data,
	value,
	onChange,
	onBlur,
	disabled = false,
	fullWidth = false,
	size = 'sm',
}: SegmentedButtonsProps) {
	const rootRef = useRef<HTMLDivElement | null>(null)
	const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
	const options = useMemo(() => data.map(normalizeOption), [data])
	const sizeStyle = SIZE_STYLES[size]

	if (options.length === 0) return null

	const focusNext = (currentIndex: number, direction: 1 | -1) => {
		for (let step = 1; step <= options.length; step += 1) {
			const nextIndex = (currentIndex + step * direction + options.length) % options.length
			const next = options[nextIndex]
			if (!next || disabled || next.disabled) continue
			buttonRefs.current[nextIndex]?.focus()
			onChange?.(next.value)
			return
		}
	}

	return (
		<Box
			ref={rootRef}
			role="radiogroup"
			onBlur={(event) => {
				const nextFocused = event.relatedTarget as Node | null
				if (!rootRef.current?.contains(nextFocused)) onBlur?.()
			}}
			style={{
				display: 'flex',
				alignItems: 'stretch',
				gap: 4,
				width: fullWidth ? '100%' : 'auto',
				padding: 3,
				borderRadius: 999,
				border: '1px solid var(--plx-segmented-border, var(--plx-panel-border-strong, var(--mantine-color-default-border)))',
				background: 'transparent',
				boxShadow: 'none',
				minWidth: 0,
			}}
		>
			{options.map((option, index) => {
				const active = option.value === value
				const hovered = hoveredIndex === index
				const optionDisabled = disabled || Boolean(option.disabled)
				const background = active
					? 'var(--plx-segmented-active-bg, var(--plx-workbench-tab-active-bg, var(--plx-surface-strong, var(--mantine-color-default))))'
					: hovered && !optionDisabled
						? 'var(--plx-segmented-hover-bg, var(--plx-surface, var(--mantine-color-default)))'
						: 'transparent'

				return (
					<button
						key={option.value}
						ref={(node) => {
							buttonRefs.current[index] = node
						}}
						type="button"
						role="radio"
						aria-checked={active}
						aria-disabled={optionDisabled}
						disabled={optionDisabled}
						tabIndex={active || (!value && index === 0) ? 0 : -1}
						onClick={() => {
							if (!optionDisabled) onChange?.(option.value)
						}}
						onMouseEnter={() => {
							if (!optionDisabled) setHoveredIndex(index)
						}}
						onMouseLeave={() => {
							setHoveredIndex((current) => (current === index ? null : current))
						}}
						onKeyDown={(event) => {
							if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
								event.preventDefault()
								focusNext(index, 1)
							}
							if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
								event.preventDefault()
								focusNext(index, -1)
							}
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								if (!optionDisabled) onChange?.(option.value)
							}
						}}
						style={{
							appearance: 'none',
							WebkitAppearance: 'none',
							background,
							backgroundImage: 'none',
							flex: fullWidth ? '1 1 0' : '0 1 auto',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'center',
							alignItems: 'center',
							outline: 'none',
							font: 'inherit',
							gap: option.description ? 2 : 0,
							minWidth: 0,
							minHeight: sizeStyle.minHeight,
							padding: sizeStyle.padding,
							border: active
								? '1px solid var(--plx-workbench-tab-active-border)'
								: '1px solid transparent',
							borderRadius: 999,
							boxShadow: 'none',
							color: optionDisabled
								? 'var(--mantine-color-dimmed)'
								: active
									? 'var(--plx-text)'
									: 'var(--plx-text-muted)',
							cursor: optionDisabled ? 'not-allowed' : 'pointer',
							opacity: optionDisabled ? 0.6 : 1,
							transition:
								'background-color 120ms ease, color 120ms ease, border-color 120ms ease, opacity 120ms ease',
						}}
					>
						<Text size={sizeStyle.labelSize} fw={active ? 700 : 600} ta="center" truncate>
							{option.label}
						</Text>
						{option.description ? (
							<Text
								size={sizeStyle.descriptionSize}
								ta="center"
								style={{
									lineHeight: 1.2,
									color: active
										? 'var(--plx-text-muted)'
										: 'color-mix(in srgb, var(--plx-text-muted) 88%, transparent)',
								}}
								lineClamp={1}
							>
								{option.description}
							</Text>
						) : null}
					</button>
				)
			})}
		</Box>
	)
}
