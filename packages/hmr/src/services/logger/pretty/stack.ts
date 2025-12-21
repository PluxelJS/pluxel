import { fileURLToPath } from 'node:url'

const PATH_SEP_RE = /\\/g
const COMPILED_EXTS = new Set(['.js', '.mjs', '.cjs'])

export const normalizePath = (value: string) => value.replace(PATH_SEP_RE, '/')
export const normalizeFileName = (value: string) =>
	toPathIfFileUrl(value).replace(PATH_SEP_RE, '/')

export type CompiledPathMatcher = {
	isCompiledPath: (fileName: string) => boolean
}

export const createCompiledPathMatcher = (hints: string[]): CompiledPathMatcher => {
	const tokens = hints
		.map((hint) => (hint.startsWith('/') ? hint : `/${hint}/`))
		.filter(Boolean)
	return {
		isCompiledPath: (fileName: string) => isCompiledPath(fileName, tokens),
	}
}

export const extractStackFile = (line: string): string | undefined => {
	const trimmed = line.trim()
	if (!trimmed.startsWith('at ')) return undefined
	const match = trimmed.match(/\((.*)\)$/)
	if (match?.[1]) return match[1]
	const parts = trimmed.replace(/^at\s+/, '')
	return parts.includes(':') ? parts : undefined
}

const isCompiledPath = (fileName: string, hintTokens: string[]) => {
	const normalized = normalizeFileName(fileName)
	const candidate = normalized.replace(/:\d+(?::\d+)?$/, '')
	const ext = candidate.slice(candidate.lastIndexOf('.')).toLowerCase()
	if (!COMPILED_EXTS.has(ext)) return false
	if (hintTokens.length === 0) return true
	return hintTokens.some((token) => candidate.includes(token))
}

function toPathIfFileUrl(fileName: string): string {
	if (fileName.startsWith('file://')) {
		try {
			return fileURLToPath(fileName)
		} catch {
			// fallthrough
		}
	}
	return fileName
}
