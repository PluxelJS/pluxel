import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

// Online: node scripts/update-model-image-input.mjs
// Reproduce: node scripts/update-model-image-input.mjs --input api.json --fetched-at <snapshot timestamp>
const source = 'https://models.dev/api.json'
const { values } = parseArgs({
	options: { input: { type: 'string' }, 'fetched-at': { type: 'string' } },
})
const fetchedAt = values['fetched-at'] ?? new Date().toISOString()
if (!Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid --fetched-at timestamp')
const output = new URL('../src/shared/model-image-input.snapshot.json', import.meta.url)
let bytes
if (values.input) bytes = await readFile(values.input)
else {
	const response = await fetch(source, { signal: AbortSignal.timeout(30000) })
	if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
	bytes = Buffer.from(await response.arrayBuffer())
}
const catalog = JSON.parse(bytes.toString('utf8'))
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value)
if (!isRecord(catalog)) throw new Error('Expected the models.dev provider catalog')
const modelIds = new Set()
const modelNames = new Set()
let records = 0
for (const [providerId, provider] of Object.entries(catalog)) {
	if (!isRecord(provider) || !isRecord(provider.models))
		throw new Error(`Invalid models.dev provider: ${providerId}`)
	for (const [modelId, model] of Object.entries(provider.models)) {
		if (
			!isRecord(model) ||
			typeof model.id !== 'string' ||
			!model.id ||
			typeof model.name !== 'string' ||
			!model.name ||
			!isRecord(model.modalities) ||
			!Array.isArray(model.modalities.input) ||
			!model.modalities.input.every((modality) => typeof modality === 'string')
		)
			throw new Error(`Invalid models.dev input modalities: ${providerId}/${modelId}`)
		if (!model.modalities.input.includes('image')) continue
		modelIds.add(model.id)
		modelNames.add(model.name)
		records++
	}
}
if (modelIds.size === 0) throw new Error('models.dev returned no image input models')
const snapshot = {
	source,
	schema: 'https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/schema.ts',
	license: 'https://github.com/anomalyco/models.dev/blob/dev/LICENSE',
	fetchedAt: new Date(fetchedAt).toISOString(),
	sourceSha256: createHash('sha256').update(bytes).digest('hex'),
	policy:
		'Exact model ID or display-name match against any image input record permits an attempt; provider support is not guaranteed.',
	modelIds: [...modelIds].sort(),
	modelNames: [...modelNames].sort(),
}
await writeFile(output, JSON.stringify(snapshot, null, '\t') + '\n')
console.log(
	`Saved ${modelIds.size} image input IDs and ${modelNames.size} names from ${records} records (${snapshot.sourceSha256}).`,
)
