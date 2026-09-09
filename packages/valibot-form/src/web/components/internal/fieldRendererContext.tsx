import { createContext, useContext, type ReactNode } from 'react'
import type { BoundFieldProps } from './BoundField'
import type { RendererProps } from '../renders/types'

type FieldRendererComponent = (props: BoundFieldProps) => ReactNode

type ValueRenderer = (props: RendererProps) => ReactNode
const ValueRendererContext = createContext<ValueRenderer | null>(null)

export function useValueRenderer(): ValueRenderer {
	const render = useContext(ValueRendererContext)
	if (!render) throw new Error('ValueRenderer provider is missing')
	return render
}

const FieldRendererContext = createContext<FieldRendererComponent | null>(null)

export function FieldRendererProvider(props: {
	value: FieldRendererComponent
	renderValue: ValueRenderer
	children: ReactNode
}) {
	return (
		<FieldRendererContext.Provider value={props.value}>
			<ValueRendererContext.Provider value={props.renderValue}>
				{props.children}
			</ValueRendererContext.Provider>
		</FieldRendererContext.Provider>
	)
}

export function useFieldRenderer(): FieldRendererComponent {
	const renderField = useContext(FieldRendererContext)
	if (!renderField) {
		throw new Error('FieldRenderer provider is missing')
	}
	return renderField
}
