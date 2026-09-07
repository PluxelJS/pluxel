import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Required Provider' })
export class RequiredProvider extends BasePlugin {
	readonly source = 'required-provider'
}
