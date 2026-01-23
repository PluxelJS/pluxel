import { type ConfigSchemaList, Config as OrigConfig, setPluxelRuntime } from '@pluxel/core'
import { type InferOutput, isOfType, type ObjectSchema, type ObjectSchemaAsync } from 'valibot'
// 必须为值导入，让 @Injectable 装饰器执行以注册服务到 Context
import './services'
setPluxelRuntime('hmr')

export * from '@pluxel/core'

type ConfigSchema = ObjectSchema<any, any> | ObjectSchemaAsync<any, any>
export type ConfigSchemaMap = ConfigSchemaList<ConfigSchema>
export type Config<T extends ConfigSchema> = InferOutput<T>
export function Config(configSchema: ConfigSchema): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as any)
}

// ------------------------------ Type Ergonomics ------------------------------
// HMR uses valibot schemas; we can enhance core's schema-agnostic helpers with better inference.
declare module '@pluxel/core' {
	interface ConfigHost {
		use<T extends ConfigSchema>(schema: T): InferOutput<T>
	}
}
