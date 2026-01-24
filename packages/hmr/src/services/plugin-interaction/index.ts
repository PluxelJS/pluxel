import { ExtensionService } from './ExtensionService'
import type { ExtService } from './ExtService'
import { RpcService } from './RpcService'
import { SseService } from './SseService'
export { doc } from './doc'
export type { UI } from './ui'

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			ext: ExtService
		}
	}
}

export { ExtensionService, type ExtensionServiceConfig } from './ExtensionService'
export { ExtService } from './ExtService'
export { type RpcExtensionFactory, RpcService } from './RpcService'
export {
	type SseChannel,
	type SseEventPayload,
	type SseExtensionFactory,
	type SseHandler,
	type SsePayload,
	SseService,
} from './SseService'
