import { createHash } from 'node:crypto'
export * from '@pluxel/core/internal/control-manifest'
/** Native compiler-side synchronous SHA-256 adapter. */
export const controlSha256 = (content: string | Uint8Array): string =>
	createHash('sha256').update(content).digest('hex')
