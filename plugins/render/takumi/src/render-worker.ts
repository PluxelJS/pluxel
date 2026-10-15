import { render, renderAnimation, renderSvg, type LocalRenderOptions } from './worker.ts'
import type { RenderWorkerRequest, WorkerImagesInput } from './types.ts'

function images(input?: WorkerImagesInput): LocalRenderOptions['images'] {
	if (!input) return undefined
	if (Array.isArray(input)) return [...input]
	const { allowRemote, sources, ...settings } = input as Exclude<
		WorkerImagesInput,
		readonly unknown[]
	>
	if (allowRemote !== undefined && typeof allowRemote !== 'boolean')
		throw new TypeError('images.allowRemote must be boolean')
	return {
		...settings,
		sources: sources ? [...sources] : undefined,
		allowUrl: allowRemote === false ? () => false : undefined,
	}
}

function options<T extends { images?: WorkerImagesInput }>(input: T) {
	return { ...input, images: images(input.images) }
}

export default function renderTask(input: RenderWorkerRequest): Promise<Uint8Array | string> {
	switch (input.operation) {
		case 'render':
			return render(input.input, options(input.options ?? {}))
		case 'svg':
			return renderSvg(input.input, options(input.options ?? {}))
		case 'animation':
			return renderAnimation(options(input.options))
	}
}
