import { type ConfigSchemaList, Config as OrigConfig, setPluxelRuntime } from '@pluxel/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
	type ErrorMessage,
	type InferOutput,
	isOfType,
	type ObjectEntries,
	type ObjectEntriesAsync,
	type ObjectIssue,
	type ObjectSchema,
	type ObjectSchemaAsync,
} from 'valibot'
// 必须为值导入，让 @Injectable 装饰器执行以注册服务到 Context
import './services'
setPluxelRuntime('hmr')

export * from '@pluxel/core'

type ConfigSchema =
	| ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined>
	| ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined>
export type ConfigSchemaMap = ConfigSchemaList<ConfigSchema>
export type Config<T extends ConfigSchema> = InferOutput<T>
export function Config(configSchema: ConfigSchema): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as unknown as StandardSchemaV1)
}
