import { Config as OrigConfig, type ConfigSchemaList } from '@pluxel/core'
import { isOfType, type ObjectSchema } from 'valibot'
import * as v from 'valibot'
import * as f from 'valibot-form'
export { v, f }

type ConfigSchema = ObjectSchema<any, any>
export type ConfigSchemaMap = ConfigSchemaList<ConfigSchema>
export type Config<T extends ConfigSchema> = v.InferOutput<T>
export function Config(
	configSchema: ConfigSchema,
): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as any)
}
