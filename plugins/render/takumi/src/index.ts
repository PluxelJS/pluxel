import { BasePlugin, Plugin } from '@pluxel/core'
import { Workers, defineWorkerTask } from '@pluxel/services/workers'
import { render, renderAnimation, renderSvg } from 'takumi-js'
import type {
	RenderWorkerRequest,
	WorkerAnimationOptions,
	WorkerRenderInput,
	WorkerRenderOptions,
	WorkerSvgRenderOptions,
} from './types.ts'

const renderTask = defineWorkerTask<RenderWorkerRequest, Uint8Array | string>(
	import.meta.url,
	'./render-worker.ts',
)

/** Takumi's native API, available through the Pluxel dependency graph. */
@Plugin()
export class TakumiPlugin extends BasePlugin {
	render(...args: Parameters<typeof render>): ReturnType<typeof render> {
		return render(...args)
	}

	renderSvg(...args: Parameters<typeof renderSvg>): ReturnType<typeof renderSvg> {
		return renderSvg(...args)
	}

	renderAnimation(...args: Parameters<typeof renderAnimation>): ReturnType<typeof renderAnimation> {
		return renderAnimation(...args)
	}

	/** Snapshot cloneable HTML/node data and render entirely in the shared host Worker pool. */
	async renderInWorker(
		input: WorkerRenderInput,
		options: WorkerRenderOptions = {},
	): Promise<Uint8Array> {
		const { signal, ...data } = options
		return (await this.runWorker(
			{ operation: 'render', input, options: data },
			signal,
		)) as Uint8Array
	}

	async renderSvgInWorker(
		input: WorkerRenderInput,
		options: WorkerSvgRenderOptions = {},
	): Promise<string> {
		const { signal, ...data } = options
		return (await this.runWorker({ operation: 'svg', input, options: data }, signal)) as string
	}

	async renderAnimationInWorker(options: WorkerAnimationOptions): Promise<Uint8Array> {
		const { signal, ...data } = options
		return (await this.runWorker({ operation: 'animation', options: data }, signal)) as Uint8Array
	}

	private runWorker(
		input: RenderWorkerRequest,
		signal?: AbortSignal,
	): Promise<Uint8Array | string> {
		for (const key of ['renderer', 'module', 'jsx', 'stylesheets']) {
			if (input.options && key in input.options)
				return Promise.reject(
					new TypeError(`${key} belongs in a worker-local template, not worker transport options`),
				)
		}
		const images = input.options?.images
		if (images && !Array.isArray(images)) {
			for (const key of ['fetch', 'fetchCache', 'allowUrl']) {
				if (key in images)
					return Promise.reject(
						new TypeError(
							`images.${key} belongs in a worker-local template; use allowRemote for worker transport`,
						),
					)
			}
		}
		return this.ctx.require(Workers).run(renderTask, input, { signal, settlement: 'execution' })
	}
}

export type {
	WorkerRenderInput,
	WorkerImagesInput,
	WorkerRenderOptions,
	WorkerSvgRenderOptions,
	WorkerAnimationOptions,
} from './types.ts'

export type {
	AnimationScene,
	CssInput,
	Font,
	ImagesInput,
	Node,
	RenderAnimationOptions,
	RenderInput,
	RenderOptions,
	RenderSvgOptions,
} from 'takumi-js'
