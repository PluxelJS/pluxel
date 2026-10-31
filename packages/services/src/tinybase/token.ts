import { defineContextCapability } from '@pluxel/core/host'
import type { TinyBaseHostService, TinyBaseService } from './types'

export const TinyBase = defineContextCapability<TinyBaseService>('services.tinybase', {
	access: 'owner',
	property: 'tinybase',
})

export const TinyBaseHost = defineContextCapability<TinyBaseHostService>('services.tinybase.host', {
	access: 'root',
})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly tinybase?: TinyBaseService
	}
}
