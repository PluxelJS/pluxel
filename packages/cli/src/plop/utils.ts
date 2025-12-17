import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveTemplatesDir(...segments: string[]) {
	const candidates = [
		// Bundled CLI: dist/./plop-templates
		resolve(__dirname, './plop-templates', ...segments),
		// Source layout: src/plop/../../plop-templates
		resolve(__dirname, '../../plop-templates', ...segments),
	]

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}

	// Fall back to the first candidate to keep a stable path even if missing.
	return candidates[0]!
}
