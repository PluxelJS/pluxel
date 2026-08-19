declare module '*.css'

declare module 'modern-monaco/lsp/typescript/setup' {
	export function setup(...args: unknown[]): Promise<void>
}
