import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Shared' })
export class SharedPlugin extends BasePlugin {
	readonly source = 'a'
}
