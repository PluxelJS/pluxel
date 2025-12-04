export * from '@pluxel/core'
export type {
	AuthGuardCheckInput,
	AuthGuardContext,
	AuthGuardDecision,
	AuthGuardRegistration,
	AuthGuardResult,
} from './services/hono/AuthGuardService'
export type { SseEvents, ResolvedSseEvents } from './web/sse'

import { type ConfigSchemaList, Config as OrigConfig } from '@pluxel/core'
import { type InferOutput, isOfType, type ObjectSchema, type ObjectSchemaAsync } from 'valibot'
// 必须为值导入，让 @Injectable 装饰器执行以注册服务到 Context
import './services'

type ConfigSchema = ObjectSchema<any, any> | ObjectSchemaAsync<any, any>
export type ConfigSchemaMap = ConfigSchemaList<ConfigSchema>
export type Config<T extends ConfigSchema> = InferOutput<T>
export function Config(configSchema: ConfigSchema): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as any)
}
