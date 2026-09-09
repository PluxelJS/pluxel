import type { FieldNode } from '../../../core/fields'
import type { FieldPath } from '../internal/fieldPath'

export type FieldError =
	| string
	| {
			message: string
	  }

export interface InputProps {
	name: string
	id?: string
	errorId?: string
	'aria-invalid'?: boolean
	'aria-describedby'?: string | undefined
	onBlur?: () => void
	onChange?: (value: unknown) => void
	disabled?: boolean
	readOnly?: boolean
}

export interface RendererProps {
	node: FieldNode
	path: FieldPath
	/** Arrays and unions that can replace their value with an array. */
	arrayActions?: {
		push: (value: unknown) => void
		remove: (index: number) => void
		move: (from: number, to: number) => void
	}
	value?: unknown
	errors?: FieldError[]
	inputProps: InputProps
}

export interface TriggerOptions {
	blur?: boolean
}

export function toInputString(value: unknown): string {
	if (value == null) return ''
	if (
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean'
	) {
		return String(value)
	}
	try {
		return JSON.stringify(value) ?? ''
	} catch {
		return ''
	}
}

export function triggerFormEvents<T>(props: InputProps, value: T, options: TriggerOptions = {}) {
	if (props.disabled || props.readOnly) return
	const { onChange, onBlur } = props
	onChange?.(value)
	if (options.blur) {
		onBlur?.()
	}
}

export function triggerFormBlur(props: InputProps) {
	if (props.disabled || props.readOnly) return
	const { onBlur } = props
	onBlur?.()
}

export function normalizeErrorMessages(errors?: FieldError[]): string[] {
	if (!errors?.length) return []
	return errors
		.map((err) => (typeof err === 'string' ? err : err?.message))
		.map((msg) => msg?.trim())
		.filter(Boolean) as string[]
}

export function joinErrorMessages(errors?: FieldError[]): string | null {
	const list = normalizeErrorMessages(errors)
	if (list.length === 0) return null
	return list.join('\n')
}
