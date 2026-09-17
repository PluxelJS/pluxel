import { defineContextCapability, resolveContextCapability } from '@pluxel/core/host'
import type { RootContext } from '@pluxel/core'
import type { ElysiaApplicationDirectory } from './ElysiaApplicationDirectory'
export type { ElysiaApplicationDirectory } from './ElysiaApplicationDirectory'
export const HttpDirectory = defineContextCapability<ElysiaApplicationDirectory>(
	'services.http.directory',
	{ access: 'root' },
)
export function requireHttpDirectory(ctx: RootContext): ElysiaApplicationDirectory {
	return resolveContextCapability(ctx, HttpDirectory)
}
