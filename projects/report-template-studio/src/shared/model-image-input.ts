import snapshot from './model-image-input.snapshot.json'

const ids = new Set(snapshot.modelIds)
const names = new Set(snapshot.modelNames)

/** Provider-independent metadata permits image attempts; explicit endpoint settings take priority. */
export function modelImageInput(
	model: { id: string; name?: string; input?: readonly string[] },
	override?: boolean,
) {
	return (
		override ??
		(Boolean(model.input?.includes('image')) ||
			ids.has(model.id) ||
			names.has(model.name ?? model.id))
	)
}
