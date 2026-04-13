import {
	defineOp,
	type Infer,
	type Operation,
	type OperationConfig,
	type Schema,
} from '@pluxel/ops'
import type { RuntimeOpContext } from '../../services/ops/OpsService'

export const defineRuntimeOp = <
	SIn extends Schema,
	SOut extends Schema | undefined = undefined,
>(
	config: Omit<
		OperationConfig<Infer<SIn>, SOut extends Schema ? Infer<SOut> : unknown, RuntimeOpContext>,
		'input' | 'output'
	> & {
		input: SIn
		output?: SOut
	},
): Operation<Infer<SIn>, SOut extends Schema ? Infer<SOut> : unknown, RuntimeOpContext> =>
	defineOp<SIn, SOut, RuntimeOpContext>(config)

export function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string') return message
	}
	return String(error)
}

export async function runConfigBatch<TEntry extends { name: string }, TResult>(
	entries: readonly TEntry[],
	runner: (entry: TEntry) => Promise<TResult>,
	fallback: (entry: TEntry, error: unknown) => TResult,
): Promise<{ ok: boolean; items: Array<{ name: string; result: TResult }> }> {
	const items: Array<{ name: string; result: TResult }> = []

	for (const entry of entries) {
		try {
			items.push({ name: entry.name, result: await runner(entry) })
		} catch (error) {
			items.push({ name: entry.name, result: fallback(entry, error) })
		}
	}

	return {
		ok: items.every((item) => Boolean((item.result as { ok?: boolean }).ok)),
		items,
	}
}
