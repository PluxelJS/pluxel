import type { ObjectSchema } from 'valibot'

export * from './actions'
export * from './extract'
export * from './registry'
export * from './utils'

export type ObjectLikeSchema = ObjectSchema<any, any>
