/** Full vector document produced by one successful compilation. */
export interface TypstPreview {
	readonly sessionId: string
	readonly revision: number
	readonly format: 'vector'
	readonly compilerVersion: '0.7.0'
	readonly data: Uint8Array
}
