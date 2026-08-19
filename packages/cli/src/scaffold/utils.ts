import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'pathe'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveTemplatesDir() {
	const candidates = [
		// Bundled CLI: dist/templates
		resolve(__dirname, './templates'),
		// Source layout: packages/cli/src/scaffold -> packages/cli/templates
		resolve(__dirname, '../../templates'),
	]

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate
	}

	// Fall back to the first candidate to keep a stable path even if missing.
	return candidates[0]!
}

export function resolveDocsDir(fileSystem: Pick<typeof fs, 'existsSync'> = fs) {
	const candidates = [
		// Bundled CLI: tsdown copies the repository docs into dist/docs.
		resolve(__dirname, './docs'),
		// Source layout: packages/cli/src/scaffold -> repository docs.
		resolve(__dirname, '../../../../docs'),
	]

	for (const candidate of candidates) {
		if (fileSystem.existsSync(candidate)) return candidate
	}

	return candidates[0]!
}
