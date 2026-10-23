import { createContext } from 'react'
import type { TypstDataField } from './types'

export const emptyFields: readonly TypstDataField[] = []

/** Live host data is shared by field and block views, never copied into the document. */
export const FieldData = createContext<{ data: unknown; fields: readonly TypstDataField[] }>({
	data: undefined,
	fields: emptyFields,
})
