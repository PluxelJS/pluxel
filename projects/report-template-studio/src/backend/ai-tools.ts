import { isAbsolute, relative, resolve, matchesGlob } from 'node:path'
import {
	createReadToolDefinition,
	createWriteToolDefinition,
	createEditToolDefinition,
	createLsToolDefinition,
	createFindToolDefinition,
	defineTool,
} from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import type { TypstPageImage, TypstRegion, TypstNavigation } from '@pluxel/typst'
import { runWorkspaceBash, type WorkspaceBashStore } from './workspace-bash.js'
import type { CompileResult, ProjectSummary } from '../shared/contracts.js'

export interface PreviewPagesRequest {
	entry: string
	revision: string
	pages: number[]
	region?: TypstRegion
	maxDimensionPx?: number
}
export interface PreviewPage extends TypstPageImage {
	headings: TypstNavigation['outline']
	sources: { path: string; fromLine: number; toLine: number }[]
}
export interface WorkspaceAIOptions extends WorkspaceBashStore {
	root: string
	getProject(id: string): Promise<ProjectSummary>
	compile(id: string, entry: string): Promise<CompileResult>
	readPreviewPages(
		id: string,
		input: PreviewPagesRequest,
		signal?: AbortSignal,
	): Promise<readonly PreviewPage[]>
}

/** Pi's ordinary file tools use the same file/conflict boundary as Studio's editor. */
export function createWorkspaceTools(
	options: WorkspaceAIOptions,
	project: ProjectSummary,
	check: () => void,
	imageInput = false,
) {
	const versions = new Map<string, string>()
	function path(absolute: string) {
		check()
		const name = relative(project.root, resolve(project.root, absolute)).replaceAll('\\', '/')
		if (name === '..' || name.startsWith('../') || isAbsolute(name))
			throw new Error('Path is outside this workspace')
		return name
	}
	async function read(absolute: string) {
		const name = path(absolute)
		const file = await options.readFile(project.id, name)
		versions.set(name, file.version)
		return Buffer.from(file.content)
	}
	async function write(absolute: string, content: string) {
		const name = path(absolute)
		const saved = await options.writeFile(project.id, {
			path: name,
			content,
			expectedVersion: versions.get(name) ?? null,
		})
		versions.set(name, saved.version)
	}
	async function entry(absolute: string) {
		const name = path(absolute)
		if (!name) return { path: '', kind: 'directory' as const }
		const tree = await options.tree(project.id)
		const item = tree.entries.find((candidate) => candidate.path === name)
		if (!item) throw new Error(`Path does not exist: ${name}`)
		return item
	}
	async function exists(absolute: string) {
		const name = path(absolute)
		const tree = await options.tree(project.id)
		return !name || tree.entries.some((item) => item.path === name)
	}
	const access = async (absolute: string) => {
		await entry(absolute)
	}
	const content = (value: unknown) => ({
		content: [
			{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
		],
		details: {},
	})
	return [
		defineTool({
			name: 'bash',
			label: 'Workspace bash',
			description:
				'Run simulated bash in /workspace. POSIX paths only; no host shell, network, Node, Python, JS, or package managers. Read/write UTF-8 source, pipes, grep/rg/sed/awk/jq, mkdir/cp/mv/rm. Binary contents, links, permissions, timestamps, and overwriting mv targets are unsupported. Writes persist immediately with revision checks; earlier successful writes remain after a command fails or is canceled. Limits: 10 seconds, 1000 commands/loops, 1 MiB per write, 4 MiB total writes, 64 KiB output. Use compile_preview for Typst.',
			parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 32768 }) }),
			execute: async (_id, input, signal) =>
				content(await runWorkspaceBash(options, project.id, input.command, check, signal)),
		}),
		defineTool(
			createReadToolDefinition(project.root, {
				operations: { readFile: read, access, detectImageMimeType: async () => undefined },
			}),
		),
		defineTool(
			createWriteToolDefinition(project.root, {
				operations: {
					writeFile: write,
					mkdir: async (absolute) => {
						// WorkspaceStore.writeFile creates parents after its conflict check.
						path(absolute)
					},
				},
			}),
		),
		defineTool(
			createEditToolDefinition(project.root, {
				operations: { readFile: read, writeFile: write, access },
			}),
		),
		defineTool(
			createLsToolDefinition(project.root, {
				operations: {
					exists,
					stat: async (absolute) => {
						const item = await entry(absolute)
						return { isDirectory: () => item.kind === 'directory' }
					},
					readdir: async (absolute) => {
						const prefix = path(absolute)
						const tree = await options.tree(project.id)
						return tree.entries
							.filter((item) => {
								const parent = item.path.includes('/')
									? item.path.slice(0, item.path.lastIndexOf('/'))
									: ''
								return parent === prefix
							})
							.map((item) => item.path.slice(prefix ? prefix.length + 1 : 0))
					},
				},
			}),
		),
		defineTool(
			createFindToolDefinition(project.root, {
				operations: {
					exists,
					glob: async (pattern, cwd, config) => {
						const prefix = path(cwd)
						const tree = await options.tree(project.id)
						return tree.entries
							.filter(
								(item) => item.kind === 'file' && (!prefix || item.path.startsWith(prefix + '/')),
							)
							.map((item) => (prefix ? item.path.slice(prefix.length + 1) : item.path))
							.filter((name) => matchesGlob(name, pattern))
							.slice(0, config.limit)
					},
				},
			}),
		),
		defineTool({
			name: 'search_files',
			label: 'Search workspace text',
			description:
				'Search for literal text in workspace text files, optionally within a folder. Returns matching paths and line numbers. Use read for the surrounding source.',
			parameters: Type.Object({
				text: Type.String({ minLength: 1 }),
				path: Type.Optional(Type.String()),
			}),
			execute: async (_id, input) => {
				const prefix = path(input.path ?? '.')
				const tree = await options.tree(project.id)
				const matches: { path: string; line: number; text: string }[] = []
				for (const item of tree.entries) {
					if (
						item.kind !== 'file' ||
						item.binary ||
						(prefix && item.path !== prefix && !item.path.startsWith(prefix + '/'))
					)
						continue
					const file = await options.readFile(project.id, item.path)
					check()
					for (const [index, line] of file.content.split('\n').entries()) {
						if (line.includes(input.text))
							matches.push({ path: item.path, line: index + 1, text: line.slice(0, 500) })
						if (matches.length >= 100) return content({ matches, truncated: true })
					}
				}
				return content({ matches, truncated: false })
			},
		}),
		defineTool({
			name: 'compile_preview',
			label: 'Compile document',
			description:
				'Compile a workspace same-name TypeScript report entry (folder/folder.ts) through Studio. Returns actual schema defaults/data, diagnostics, revision, page count, point-unit page sizes, and outline. Read relevant pages with read_preview_pages to verify visual quality; a successful compile alone does not establish it.',
			parameters: Type.Object({ entry: Type.String() }),
			execute: async (_id, input) => {
				check()
				let result
				try {
					result = await options.compile(project.id, path(input.entry))
				} catch (error) {
					check()
					// Pi serializes thrown tool errors by message. Preserve actual source
					// diagnostics and schema feedback at that model-facing boundary.
					if (error instanceof Error && ('diagnostics' in error || 'fields' in error))
						throw new Error(
							JSON.stringify({
								ok: false,
								entry: input.entry,
								error: error.message,
								code: 'code' in error ? error.code : undefined,
								diagnostics: 'diagnostics' in error ? error.diagnostics : undefined,
								fields: 'fields' in error ? error.fields : undefined,
								data: 'data' in error ? error.data : undefined,
							}),
							{ cause: error },
						)
					throw error
				}
				check()
				const navigation = result.preview.navigation
				const pageSizes: { fromPage: number; toPage: number; widthPt: number; heightPt: number }[] =
					[]
				for (const page of navigation.pages) {
					const previous = pageSizes.at(-1)
					if (previous?.widthPt === page.width && previous.heightPt === page.height)
						previous.toPage = page.page
					else
						pageSizes.push({
							fromPage: page.page,
							toPage: page.page,
							widthPt: page.width,
							heightPt: page.height,
						})
				}
				return content({
					ok: true,
					entry: result.entry,
					revision: result.revision,
					fields: result.fields,
					data: result.data,
					diagnostics: result.diagnostics,
					elapsedMs: result.elapsedMs,
					pageCount: navigation.pages.length,
					pageSizes,
					outline: navigation.outline.slice(0, 128),
					outlineTotal: navigation.outline.length,
					outlineTruncated: navigation.outline.length > 128,
					imageInput,
				})
			},
		}),
		defineTool({
			name: 'read_preview_pages',
			label: 'Inspect rendered pages',
			description:
				'Read actual PNG images from the last compiled preview without recompiling. Supply the entry and revision returned by compile_preview and 1–3 one-based page numbers. Optionally crop a region in page-local points (1 pt = 1/72 inch), using outline coordinates or page dimensions. maxDimensionPx defaults to 1600 (256–2048). Returns image blocks plus headings and source line ranges. After source or input changes compile again; stale revisions are rejected. For multipage documents inspect opening, continuation and final pages, then zoom into suspect formulas, tables or images. Requires a model with image input.',
			parameters: Type.Object({
				entry: Type.String(),
				revision: Type.String(),
				pages: Type.Array(Type.Integer({ minimum: 1 }), {
					minItems: 1,
					maxItems: 3,
					uniqueItems: true,
				}),
				region: Type.Optional(
					Type.Object({
						x: Type.Number({ minimum: 0 }),
						y: Type.Number({ minimum: 0 }),
						width: Type.Number({ exclusiveMinimum: 0 }),
						height: Type.Number({ exclusiveMinimum: 0 }),
					}),
				),
				maxDimensionPx: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048 })),
			}),
			execute: async (_id, input, signal) => {
				check()
				if (!imageInput)
					throw new Error(
						'所选模型未启用图片输入。请选择视觉模型或在供应商设置中启用该模型的图片能力。',
					)
				const images = await options.readPreviewPages(
					project.id,
					{ ...input, entry: path(input.entry) },
					signal,
				)
				check()
				return {
					content: images.flatMap((image) => [
						{
							type: 'text' as const,
							text: JSON.stringify({
								entry: input.entry,
								revision: input.revision,
								page: image.page,
								widthPx: image.width,
								heightPx: image.height,
								regionPt: image.region,
								headings: image.headings,
								sources: image.sources,
							}),
						},
						{
							type: 'image' as const,
							data: Buffer.from(image.data).toString('base64'),
							mimeType: 'image/png',
						},
					]),
					details: {
						pages: images.map(({ page, width, height, region }) => ({
							page,
							width,
							height,
							region,
						})),
					},
				}
			},
		}),
	]
}
