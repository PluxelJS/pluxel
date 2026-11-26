import type { IntersectSchema, ObjectSchema, StrictObjectSchema } from 'valibot'

export * from './constants'
export * from './meta'
export * from './schema'
export * from './fields'
export { matchingUnionBranches, unionBranchLiteral } from './fieldInput'
export { parseFormFields } from './fieldData'
export * from './rawInput'
export * from './utils/objectEntries'

export type ObjectLikeSchema =
	| ObjectSchema<any, any>
	| StrictObjectSchema<any, any>
	| (IntersectSchema<any, any> & { readonly options: readonly ObjectLikeSchema[] })
