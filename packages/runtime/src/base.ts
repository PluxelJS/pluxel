import { type ConfigSchemaList, Config as OrigConfig } from '@pluxel/core'
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

export type { RuntimeEvents } from './events'

export {
	__registerConfigBinding__,
	__registerConfigSchema__,
	__registerUsedFeatures__,
	__setConfigLayout__,
	__setConfigSource__,
	BaseFeature,
	BasePlugin,
	clearParamToken,
	clearParamTokens,
	cfg,
	Context,
	defineOptionalFeature,
	ForkablePlugin,
	getStoredParamTokens,
	HostBoundFeature,
	Plugin,
	pluginMethodDecorator,
	setParamToken,
	setParamTokens,
} from '@pluxel/core'

type ConfigSchema =
	| ObjectSchema<ObjectEntries, ErrorMessage<ObjectIssue> | undefined>
	| ObjectSchemaAsync<ObjectEntriesAsync, ErrorMessage<ObjectIssue> | undefined>
export type ConfigSchemaMap = ConfigSchemaList<ConfigSchema>
export type Config<T extends ConfigSchema> = InferOutput<T>
export function Config(configSchema: ConfigSchema): ReturnType<typeof OrigConfig> {
	if (!isOfType('object', configSchema)) {
		throw new Error('传入 Config 装饰器的必须是 valibot ObjectSchema')
	}
	return OrigConfig(configSchema)
}
