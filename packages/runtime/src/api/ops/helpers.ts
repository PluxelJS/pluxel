import {
	defineOp,
	type CliBinding,
	type Infer,
	type Operation,
	type OperationConfig,
	type Schema,
} from '@pluxel/ops'
import type { RuntimeOpContext } from '../../services/ops/OpsService'

export type RuntimeOpWorkbenchMetadata = {
	mutating?: boolean
	confirm?: boolean
}

export type RuntimeOpMetadata<I = Record<string, unknown>> = {
	rpc?: boolean
	mcp?: false | { name?: string }
	workbench?: RuntimeOpWorkbenchMetadata
	cli?: CliBinding<I>
}

const RUNTIME_OP_METADATA = new WeakMap<Operation<any, any, RuntimeOpContext>, RuntimeOpMetadata>()

export const defineRuntimeOp = <SIn extends Schema, SOut extends Schema>(
	config: Omit<OperationConfig<Infer<SIn>, Infer<SOut>, RuntimeOpContext>, 'input' | 'output'> & {
		input: SIn
		output: SOut
	} & RuntimeOpMetadata<Infer<SIn>>,
): Operation<Infer<SIn>, Infer<SOut>, RuntimeOpContext> => {
	const { rpc, mcp, workbench, cli, ...opConfig } = config
	const op = defineOp<SIn, SOut, RuntimeOpContext>(opConfig)
	RUNTIME_OP_METADATA.set(op, {
		rpc: rpc ?? true,
		mcp: mcp ?? {},
		...(workbench ? { workbench } : {}),
		...(cli ? { cli } : {}),
	})
	return op
}

export const getRuntimeOpMetadata = (
	op: Operation<any, any, RuntimeOpContext>,
): RuntimeOpMetadata => RUNTIME_OP_METADATA.get(op) ?? {}

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
