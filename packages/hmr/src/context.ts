export * from './services'
export * from '@pluxel/core'

import { Config as OrigConfig } from '@pluxel/core'
import { f } from '@pluxel/components'
import * as v from 'valibot'
export { v, f }

export function Config(
	configSchema: v.ObjectSchema<any, any>,
): ReturnType<typeof OrigConfig> {
	if (!v.isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema as any)
}
