import { defineContextCapability, type ContextCapability } from '@pluxel/core/host'
import type { McpService } from './service'

export const Mcp: ContextCapability<McpService> = defineContextCapability<McpService>(
	'services.mcp',
	{ access: 'all', property: 'mcp' },
)

declare module '@pluxel/core' {
	interface ContextServices {
		readonly mcp: McpService
	}
}
