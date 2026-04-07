import { createContext, useContext, type ReactNode } from 'react'
import type { RendererProps } from '../renders/types'

type FieldRendererComponent = (props: RendererProps) => ReactNode

const FieldRendererContext = createContext<FieldRendererComponent | null>(null)

export function FieldRendererProvider(props: {
	value: FieldRendererComponent
	children: ReactNode
}) {
	return (
		<FieldRendererContext.Provider value={props.value}>
			{props.children}
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
