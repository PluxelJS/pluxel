declare module 'modern-monaco/lsp/typescript/setup' {
	export function setup(
		monaco: typeof import('modern-monaco/editor-core'),
		languageId: string,
		settings?: Record<string, unknown>,
		formatting?: Record<string, unknown>,
		workspace?: import('modern-monaco').Workspace,
	): Promise<void>
}

declare module '*?url&no-inline' {
	const url: string
	export default url
}
