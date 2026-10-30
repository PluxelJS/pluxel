import type { DocumentInput } from './contracts.js'

/** Text drafts and read-only image bytes captured from the same saved workspace revision. */
export function sourceFiles(
	input: Pick<DocumentInput, 'editor' | 'assets'>,
): Record<string, string | Uint8Array> {
	const files: Record<string, string | Uint8Array> = { ...input.editor?.files }
	for (const asset of input.assets ?? []) files[asset.path] = asset.bytes
	return files
}
