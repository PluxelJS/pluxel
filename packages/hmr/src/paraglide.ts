import { existsSync } from 'node:fs'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import { resolve } from 'pathe'
import type { PluginOption } from 'vite'

export const PLUXEL_PARAGLIDE_PROJECT_FILE = 'project.inlang' as const
export const PLUXEL_PARAGLIDE_MESSAGES_DIR = 'messages' as const
export const PLUXEL_PARAGLIDE_OUTDIR = 'src/paraglide' as const

export interface ResolvedParaglideIntegration {
	project: string
	projectFile: string
	outdir: string
	outdirFile: string
	sourceRoots: string[]
	plugins: PluginOption[]
}

export function resolveParaglideIntegration(root: string): ResolvedParaglideIntegration | null {
	const project = `./${PLUXEL_PARAGLIDE_PROJECT_FILE}`
	const outdir = `./${PLUXEL_PARAGLIDE_OUTDIR}`
	const projectFile = resolve(root, PLUXEL_PARAGLIDE_PROJECT_FILE)
	if (!existsSync(projectFile)) return null

	const sourceRoots = [projectFile]
	const messagesDir = resolve(root, PLUXEL_PARAGLIDE_MESSAGES_DIR)
	if (existsSync(messagesDir)) sourceRoots.push(messagesDir)

	return {
		project,
		projectFile,
		outdir,
		outdirFile: resolve(root, PLUXEL_PARAGLIDE_OUTDIR),
		sourceRoots,
		plugins: toPluginArray(
			paraglideVitePlugin({
				project,
				outdir,
			}),
		),
	}
}

export function isParaglideGeneratedFile(
	integration: ResolvedParaglideIntegration | null | undefined,
	filePath: string,
): boolean {
	if (!integration) return false
	const generatedDir = integration.outdirFile
	return (
		filePath === generatedDir ||
		filePath.startsWith(`${generatedDir}/`) ||
		filePath.startsWith(`${generatedDir}\\`)
	)
}

function toPluginArray(input: PluginOption | PluginOption[]): PluginOption[] {
	return Array.isArray(input) ? input.flatMap((item) => toPluginArray(item)) : [input]
}
