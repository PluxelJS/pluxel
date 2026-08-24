import type { IntersectSchema, ObjectSchema } from 'valibot'

export * from './constants'
export * from './meta'
export * from './schema'
export * from './fields'
export * from './rawInput'
export * from './utils/objectEntries'

export type ObjectLikeSchema = ObjectSchema<any, any> | IntersectSchema<any, any>
