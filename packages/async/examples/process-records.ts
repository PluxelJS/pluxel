import { grfn } from '@pluxel/async/grfn'
import { mapConcurrent, batch } from '@pluxel/async/iter'

interface Row {
	id: string
	amount: number
}
interface Metadata {
	label: string
}
interface Enriched {
	row: Row
	metadata: Metadata
}

interface Services {
	readRow(id: string, signal: AbortSignal): Promise<Row>
	readMetadata(id: string, signal: AbortSignal): Promise<Metadata>
	writeBatch(values: readonly Enriched[]): Promise<void>
}

// Create once per service/client lifetime, not once per item.
export function createProcessor(
	services: Services,
): (ids: Iterable<string> | AsyncIterable<string>, signal: AbortSignal) => Promise<void> {
	const g = grfn<{ id: string; signal: AbortSignal }>()
	const row = g.task({ input: g.input }, ({ input }) => services.readRow(input.id, input.signal))
	const metadata = g.task({ input: g.input }, ({ input }) =>
		services.readMetadata(input.id, input.signal),
	)
	const run = g.compile({ row, metadata }, { failure: 'drain' })

	return async (ids, signal) => {
		const records = mapConcurrent(ids, (id, context) => run({ id, signal: context.signal }), {
			concurrency: 4,
			order: 'completion',
			signal,
		})
		for await (const values of batch(records, 64)) await services.writeBatch(values)
	}
}
