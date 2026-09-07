import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RequiredProvider } from './RequiredProvider'

@Plugin({ displayName: 'Required Consumer' })
export class RequiredConsumer extends BasePlugin {
	constructor(readonly provider: RequiredProvider) {
		super()
	}
}
