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
	if (!list.length) return null
	return list.join('\n')
}

export function isErrorWithPath(error: FieldError): error is { message: string; dotPath?: string[] } {
	return typeof error === 'object' && error !== null && 'message' in error
}
