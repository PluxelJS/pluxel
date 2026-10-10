import type { TypstRenderer } from '@myriaddreamin/typst.ts'
import type { TypstPreview } from '../preview-contract.js'

export type { TypstPreview } from '../preview-contract.js'

/** Owns a container; the initialized upstream renderer remains caller-owned. */
export class TypstPreviewView implements AsyncDisposable {
	private readonly container: HTMLElement
	private readonly renderer: Pick<TypstRenderer, 'runWithSession' | 'manipulateData' | 'renderSvg'>
	private readonly sessionId: string
	private newestRevision = 0
	private displayedRevision = 0
	private generation = 0
	private closed = false
	private tail: Promise<unknown> = Promise.resolve()
	private closing?: Promise<void>

	constructor(options: {
		container: HTMLElement
		renderer: Pick<TypstRenderer, 'runWithSession' | 'manipulateData' | 'renderSvg'>
		sessionId: string
	}) {
		if (!options.sessionId) throw new TypeError('Preview requires a sessionId')
		this.container = options.container
		this.renderer = options.renderer
		this.sessionId = options.sessionId
	}

	/**
	 * Resolves true after displaying this revision; false for a stale or foreign packet.
	 * Renderer errors reject and preserve the previous picture. Retry is allowed.
	 * Keep packet bytes unchanged until this promise settles.
	 */
	async show(packet: TypstPreview): Promise<boolean> {
		if (this.closed) throw new Error('Typst preview is disposed')
		if (packet.sessionId !== this.sessionId) return false
		if (packet.format !== 'vector' || packet.compilerVersion !== '0.7.0') {
			throw new TypeError('Preview requires vector artifacts from typst.ts 0.7.0')
		}
		if (
			!Number.isSafeInteger(packet.revision) ||
			packet.revision < 1 ||
			!(packet.data instanceof Uint8Array)
		) {
			throw new TypeError('Invalid Typst preview revision or bytes')
		}
		if (packet.revision < this.newestRevision || packet.revision <= this.displayedRevision)
			return false
		this.newestRevision = packet.revision
		const generation = ++this.generation
		const current = () => !this.closed && generation === this.generation
		const work = this.tail.then(async () => {
			if (!current()) return false
			const svg = await this.renderer.runWithSession(async (renderSession) => {
				this.renderer.manipulateData({ renderSession, action: 'reset', data: packet.data })
				return this.renderer.renderSvg({
					renderSession,
					data_selection: { body: true, defs: true, css: true, js: false },
				})
			})
			if (!current()) return false
			this.container.innerHTML = svg
			this.displayedRevision = packet.revision
			return true
		})
		this.tail = work.catch(() => {})
		return work
	}

	/** Waits for in-flight rendering and its upstream session cleanup. */
	dispose(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		this.closing = this.tail.then(() => {
			this.container.replaceChildren()
			return undefined
		})
		return this.closing
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}
}
