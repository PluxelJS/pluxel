import type { Font, Node, RenderAnimationOptions, RenderOptions, RenderSvgOptions } from 'takumi-js'
import type { ImageSource } from '@takumi-rs/core'

type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Concrete data only. Construct React components inside a declared worker task instead. */
export type WorkerRenderInput = string | Node

export type WorkerImagesInput =
	| readonly ImageSource[]
	| Readonly<{
			sources?: readonly ImageSource[]
			/** Remote fetching is allowed when omitted, as in Takumi. Markdown defaults to false. */
			allowRemote?: boolean
			timeout?: number
			maxBytes?: number
			cache?: 'auto' | 'none'
	  }>

type WorkerExtras = Readonly<{
	/** Concrete font bytes; URLs, promises and lazy loaders belong inside a business worker task. */
	fonts?: readonly Font[]
	images?: WorkerImagesInput
	/** Cancels admission or terminates the executing shared Worker. */
	signal?: AbortSignal
}>

type LocalFields = 'renderer' | 'module' | 'jsx' | 'fonts' | 'images' | 'signal' | 'stylesheets'

/** Takumi's encoding/layout options with cloneable resources and explicit Worker cancellation. */
export type WorkerRenderOptions = OmitEach<RenderOptions, LocalFields> & WorkerExtras
export type WorkerSvgRenderOptions = OmitEach<RenderSvgOptions, LocalFields> & WorkerExtras
export type WorkerAnimationOptions = OmitEach<RenderAnimationOptions, LocalFields | 'scenes'> &
	WorkerExtras & {
		scenes: { node: WorkerRenderInput; durationMs: number }[]
	}

export type RenderWorkerRequest =
	| {
			operation: 'render'
			input: WorkerRenderInput
			options?: OmitEach<WorkerRenderOptions, 'signal'>
	  }
	| {
			operation: 'svg'
			input: WorkerRenderInput
			options?: OmitEach<WorkerSvgRenderOptions, 'signal'>
	  }
	| { operation: 'animation'; options: OmitEach<WorkerAnimationOptions, 'signal'> }
