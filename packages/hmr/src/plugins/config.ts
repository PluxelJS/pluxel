import { Config as OrigConfig } from '@pluxel/core'
import { isOfType, type ObjectSchema } from 'valibot'
export function Config(
	configSchema: ObjectSchema<any, any>,
): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as any)
}
import * as v from 'valibot'
import * as f from 'valibot-form'
export { v, f }