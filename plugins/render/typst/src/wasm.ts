import initCompiler, {
	TypstCompilerBuilder,
	type TypstCompiler,
} from '@myriaddreamin/typst-ts-web-compiler'
import initRenderer, { TypstRenderer } from '@myriaddreamin/typst-ts-renderer'
import type { DiagnosticsData } from '@myriaddreamin/typst.ts/compiler'
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'
import { TypstError } from './errors.ts'

const assetUrl = v.pipe(v.string(), v.minLength(1))

/** Explicit assets for the 0.7.0 WASM compiler and renderer; no CDN defaults. */
export const TypstConfig = v.object({
	compilerWasmUrl: assetUrl,
	rendererWasmUrl: assetUrl,
	/** Loaded at startup. Use the fonts' embedded family names in Typst source. */
	fontUrls: v.array(assetUrl),
})
export type TypstPluginConfig = v.InferOutput<typeof TypstConfig>

export interface TypstSvgOptions {
	/**
	 * Text files for this call only, snapshotted when accepted. Paths are absolute POSIX
	 * file paths without empty, . or .. segments; /main.typ belongs to source.
	 * @defaultValue No additional files.
	 */
	readonly files?: Readonly<Record<string, string>>
}

type Generation = {
	active: boolean
	compiler: TypstCompiler
	renderer: TypstRenderer
	pending?: Promise<Uint8Array>
}

async function fetchAsset(url: string): Promise<Uint8Array> {
	const response = await fetch(url)
	if (!response.ok) throw new Error(`Typst asset request failed (${response.status}): ${url}`)
	return new Uint8Array(await response.arrayBuffer())
}

/** In-memory WASM compilation. The host owns the enclosing Worker and its time budget. */
// WASM and font downloads must fit inside the plugin's startup budget, not Core's 1.5s default.
@Plugin({ startTimeoutMs: 30_000 })
export class TypstPlugin extends BasePlugin {
	private readonly config = this.configs.use(TypstConfig)
	private generation?: Generation

	override async init(): Promise<void> {
		const [compilerBytes, rendererBytes, fonts] = await Promise.all([
			fetchAsset(this.config.compilerWasmUrl),
			fetchAsset(this.config.rendererWasmUrl),
			Promise.all(this.config.fontUrls.map(fetchAsset)),
		])
		await initCompiler({ module_or_path: compilerBytes })
		await initRenderer({ module_or_path: rendererBytes })
		const builder = new TypstCompilerBuilder()
		let transferred = false
		let compiler: TypstCompiler
		try {
			// Source exists only in the shadow filesystem; imports cannot fetch site files.
			builder.set_dummy_access_model()
			await builder.set_package_registry({}, () => undefined)
			for (const font of fonts) await builder.add_raw_font(font)
			// wasm-bindgen build() consumes the builder even when its Promise rejects.
			transferred = true
			compiler = await builder.build()
		} finally {
			if (!transferred) builder.free()
		}
		let renderer: TypstRenderer
		try {
			renderer = new TypstRenderer()
		} catch (cause) {
			compiler.free()
			throw cause
		}
		const generation: Generation = { active: true, compiler, renderer }
		this.ctx.effects.defer(
			async () => {
				generation.active = false
				if (this.generation === generation) this.generation = undefined
				await generation.pending?.catch(() => {})
				try {
					renderer.free()
				} finally {
					compiler.free()
				}
			},
			{ tag: 'typst-wasm' },
		)
		this.generation = generation
	}

	/** Caller-owned UTF-8 SVG bytes. One active render; syntax errors permit another call. */
	async renderSvg(source: string, options: TypstSvgOptions = {}): Promise<Uint8Array> {
		const generation = this.generation
		if (!generation?.active) throw new TypstError('CLOSED', 'TypstPlugin is not running')
		if (typeof source !== 'string' || source.length === 0)
			throw new TypstError('INVALID_INPUT', 'renderSvg requires non-empty Typst source')
		if (generation.pending) throw new TypstError('BUSY', 'TypstPlugin is already rendering')
		if (!options || typeof options !== 'object' || Array.isArray(options))
			throw new TypstError('INVALID_INPUT', 'renderSvg options must be an object')
		const inputFiles = options.files
		if (
			inputFiles !== undefined &&
			(!inputFiles ||
				typeof inputFiles !== 'object' ||
				(Object.getPrototypeOf(inputFiles) !== Object.prototype &&
					Object.getPrototypeOf(inputFiles) !== null))
		)
			throw new TypstError('INVALID_INPUT', 'files must be a record of absolute paths to text')
		const files = Object.entries(inputFiles ?? {})
		for (const [path, content] of files) {
			if (
				!path.startsWith('/') ||
				path === '/main.typ' ||
				path.includes('\\') ||
				path.includes('\0') ||
				path
					.slice(1)
					.split('/')
					.some((part) => !part || part === '.' || part === '..') ||
				typeof content !== 'string'
			)
				throw new TypstError(
					'INVALID_INPUT',
					'files require valid absolute POSIX paths and text; /main.typ is reserved',
					{ path },
				)
		}
		const pending = Promise.resolve().then(() => {
			if (!generation.active) throw new TypstError('CLOSED', 'TypstPlugin stopped before rendering')
			const { compiler, renderer } = generation
			try {
				if (!compiler.add_source('/main.typ', source))
					throw new Error('Typst could not register /main.typ')
				for (const [path, content] of files)
					if (!compiler.add_source(path, content))
						throw new Error(`Typst could not register ${path}`)
				const world = compiler.snapshot('/', '/main.typ', [])
				try {
					// Upstream 0.7.0: vector = 0; full diagnostics = 3.
					const compiled: { result?: Uint8Array; diagnostics?: DiagnosticsData['full'][] } =
						world.get_artifact(0, 3)
					if (!compiled.result)
						throw new TypstError('COMPILE_FAILED', 'Typst compilation failed', {
							diagnostics: compiled.diagnostics?.map((diagnostic) => ({
								severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
								message: diagnostic.message,
								path: diagnostic.path,
							})),
						})
					const session = renderer.session_from_artifact(compiled.result, 'vector')
					try {
						// Body + definitions + CSS. SVG output does not include renderer JavaScript.
						return new TextEncoder().encode(renderer.svg_data(session, 0b0111))
					} finally {
						session.free()
					}
				} finally {
					world.free()
				}
			} finally {
				compiler.reset_shadow()
				compiler.reset()
			}
		})
		generation.pending = pending
		try {
			return await pending
		} finally {
			generation.pending = undefined
		}
	}
}

export { TypstError } from './errors.ts'
export type { TypstDiagnostic, TypstErrorCode } from './errors.ts'
