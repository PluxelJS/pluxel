import { type ConfigSchemaList, Config as OrigConfig } from '@pluxel/core'
import { type InferOutput, isOfType, type ObjectSchema } from 'valibot'

export * as v from 'valibot'
export * as f from 'valibot-form'

type ConfigSchema = ObjectSchema<any, any>
export type ConfigSchemaMap = ConfigSchemaList<ConfigSchema>
export type Config<T extends ConfigSchema> = InferOutput<T>
export function Config(configSchema: ConfigSchema): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as any)
}
