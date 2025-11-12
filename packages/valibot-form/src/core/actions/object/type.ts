import type { Schema } from '~/core/utils'
import type { ObjectMetaOptions } from '../objectMeta'

export interface ObjectFieldConfig {
	name: string
	schema: Schema
}

export type ObjectMetaResult = ObjectMetaOptions & {
	fields: ObjectFieldConfig[]
}
