import type { FieldNode } from '../../../core/fields'

export type FieldError =
	| string
	| {
			message: string
			dotPath?: string[]
	  }

export interface InputProps {
	name: string
	ref?: any
	onBlur?: (event?: any) => void
	onChange?: (value: any) => void
	disabled?: boolean
	readOnly?: boolean
}

export interface RendererProps {
	node: FieldNode
	value?: unknown
	errors?: FieldError[]
	inputProps: InputProps
	defaultValue?: unknown
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
	const { name, onChange, onBlur } = props
	onChange?.(value)
	if (options.blur) {
		onBlur?.({ target: { name } })
	}
}

export function triggerFormBlur(props: InputProps) {
	if (props.disabled || props.readOnly) return
	const { name, onBlur } = props
	onBlur?.({ target: { name } })
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

export function isErrorWithPath(
	error: FieldError,
): error is { message: string; dotPath?: string[] } {
	return typeof error === 'object' && error !== null && 'message' in error
}
