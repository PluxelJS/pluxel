import files from './mitex-files.json' with { type: 'json' }

/** Pinned, self-contained MiTeX resources. No package registry or runtime fetch. */
export function createMiTeXFiles(): Record<string, string> {
	return { ...files }
}
