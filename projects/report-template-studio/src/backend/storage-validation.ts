import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { WorkspaceConfig } from '../shared/contracts.js'
export const MAX_FILE = 64 * 1024 * 1024
export const MAX_ARCHIVE = 128 * 1024 * 1024
export const MAX_TOTAL = 256 * 1024 * 1024
export const MAX_ENTRIES = 5000
export function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function pathName(name: string) {
	if (
		!name ||
		name.length > 1024 ||
		isAbsolute(name) ||
		// oxlint-disable-next-line eslint/no-control-regex
		/[\\\x00-\x1f:]/.test(name) ||
		name.split('/').some((part) => !part || part === '.' || part === '..')
	)
		throw Object.assign(new Error('Invalid workspace path'), {
			code: 'INVALID_INPUT',
			issues: [
				{
					path: ['path'],
					rule: 'workspace_path',
					message: 'Expected a relative POSIX path without parent traversal',
				},
			],
		})
	return name
}
export async function safePath(path: string) {
	const absolute = resolve(path)
	let current = absolute
	while (true) {
		try {
			const stat = await lstat(current)
			if (stat.isSymbolicLink())
				throw Object.assign(new Error('Symbolic links are not allowed in workspaces'), {
					code: 'INVALID_INPUT',
				})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		const parent = dirname(current)
		if (parent === current) return absolute
		current = parent
	}
}
export function workspaceConfig(value: unknown, fallbackName: string): WorkspaceConfig {
	if (value === undefined) return { name: fallbackName, fonts: [] }
	if (
		!record(value) ||
		typeof value.name !== 'string' ||
		!value.name.trim() ||
		value.name.length > 160 ||
		Object.hasOwn(value, 'documents') ||
		!Array.isArray(value.fonts)
	)
		throw Object.assign(
			new Error(
				'Invalid studio.json: expected name and fonts; reports are discovered from folder/folder.ts',
			),
			{ code: 'INVALID_INPUT' },
		)
	const fonts = value.fonts.map((item) => {
		if (typeof item !== 'string')
			throw Object.assign(new Error('Invalid studio.json font'), { code: 'INVALID_INPUT' })
		return pathName(item)
	})
	return { name: value.name, fonts }
}
export function conflict() {
	return Object.assign(new Error('File changed; reload before editing'), {
		code: 'REVISION_CONFLICT',
	})
}
export function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return undefined
	}
}

/** Discovery is structural and never executes workspace code. */
export function reportEntry(path: string): boolean {
	const parts = path.split('/')
	return parts.length >= 2 && parts.at(-1) === `${parts.at(-2)}.ts`
}
