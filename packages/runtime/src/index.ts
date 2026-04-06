import { type ConfigSchemaList, Config as OrigConfig, setPluxelRuntime } from '@pluxel/core'
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
import './runtime/register'
// Type-level bridge for `Context.Events` (module augmentation).
// oxlint-disable-next-line import/no-empty-named-blocks -- Type-only bridge keeps the augmentation file in the TS graph without a runtime import.
import type {} from './events'

setPluxelRuntime('core')

export {
	BaseFeature,
	BasePlugin,
	cfg,
	Context,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	pluginMethodDecorator,
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
