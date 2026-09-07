import type { LogRangeResult, RuntimeLogError, RuntimeLogLine } from '../../logger/protocol'
import { normalizePortableLogValue } from '../../logger/serialization'
import { parseLogRangeResult } from '../../web/management-validation'
import { RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES } from '../../web/session/limits'

const encoder = new TextEncoder()
const COMPACT_CATEGORY_PARTS = 8
const COMPACT_CATEGORY_CHARS = 128
const COMPACT_IDENTITY_CHARS = 512
const COMPACT_MESSAGE_CHARS = 2_000
const COMPACT_ERROR_NAME_CHARS = 128
const COMPACT_ERROR_MESSAGE_CHARS = 1_000
const COMPACT_ERROR_STACK_CHARS = 4_000

export function estimateRuntimeRpcPayloadBytes(input: unknown): number {
	try {
		const encoded = JSON.stringify(input)
		return encoded === undefined ? Number.POSITIVE_INFINITY : encoder.encode(encoded).byteLength
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

/** Materialize and byte-page one store range before Cap'n Web sees it. */
export function prepareRuntimeLogRangeForRpc(input: LogRangeResult): LogRangeResult {
	if (!input.ok || input.lines.length === 0) {
		return parseLogRangeResult(normalizePortableLogValue(input))
	}

	const lines: RuntimeLogLine[] = []
	let encodedLineBytes = 0
	for (const [index, source] of input.lines.entries()) {
		const portable = normalizePortableLogValue(source) as RuntimeLogLine
		let line = portable
		let lineBytes = estimateRuntimeRpcPayloadBytes(line)
		const nextSeq = index === input.lines.length - 1 ? input.nextSeq : incrementSequence(line.seq)
		const envelopeBytes = estimateRuntimeRpcPayloadBytes({
			ok: true,
			streamId: input.streamId,
			epoch: input.epoch,
			fromSeq: input.fromSeq,
			nextSeq,
			lines: [],
		})
		const candidateBytes = () =>
			envelopeBytes + encodedLineBytes + lineBytes + (lines.length === 0 ? 0 : 1)
		if (candidateBytes() > RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES) {
			if (lines.length > 0) break
			line = compactOversizedLogLine(portable)
			lineBytes = estimateRuntimeRpcPayloadBytes(line)
			if (candidateBytes() > RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES) {
				line = minimalOversizedLogLine(portable)
				lineBytes = estimateRuntimeRpcPayloadBytes(line)
			}
			if (candidateBytes() > RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES) {
				throw new Error('A compact Runtime log line exceeded the RPC payload budget')
			}
		}
		lines.push(line)
		encodedLineBytes += lineBytes + (lines.length === 1 ? 0 : 1)
	}

	if (lines.length === 0) {
		throw new Error('A compact Runtime log line exceeded the RPC payload budget')
	}

	const complete = lines.length === input.lines.length
	return parseLogRangeResult({
		ok: true,
		streamId: input.streamId,
		epoch: input.epoch,
		fromSeq: input.fromSeq,
		nextSeq: complete ? input.nextSeq : incrementSequence(lines.at(-1)!.seq),
		lines,
	})
}

function minimalOversizedLogLine(line: RuntimeLogLine): RuntimeLogLine {
	return {
		streamId: line.streamId,
		epoch: line.epoch,
		seq: line.seq,
		ts: line.ts,
		level: line.level,
		category: [],
		msg: 'Oversized log entry truncated for Runtime RPC transport',
		props: { rpcPayloadTruncated: true },
	}
}

function compactOversizedLogLine(line: RuntimeLogLine): RuntimeLogLine {
	const error = compactError(line.error)
	return {
		streamId: line.streamId,
		epoch: line.epoch,
		seq: line.seq,
		ts: line.ts,
		level: line.level,
		category: line.category
			.slice(0, COMPACT_CATEGORY_PARTS)
			.map((part) => truncate(part, COMPACT_CATEGORY_CHARS)),
		...(line.name === undefined ? {} : { name: truncate(line.name, COMPACT_IDENTITY_CHARS) }),
		...(line.plugin === undefined ? {} : { plugin: line.plugin }),
		...(line.pluginReference === undefined
			? {}
			: { pluginReference: truncate(line.pluginReference, COMPACT_IDENTITY_CHARS) }),
		...(line.pluginLabel === undefined
			? {}
			: { pluginLabel: truncate(line.pluginLabel, COMPACT_IDENTITY_CHARS) }),
		...(line.context === undefined
			? {}
			: { context: truncate(line.context, COMPACT_IDENTITY_CHARS) }),
		msg: truncate(line.msg, COMPACT_MESSAGE_CHARS),
		props: { rpcPayloadTruncated: true },
		...(error === undefined ? {} : { error }),
	}
}

function compactError(error: RuntimeLogError | undefined): RuntimeLogError | undefined {
	if (!error) return undefined
	const compact = {
		...(typeof error.name === 'string'
			? { name: truncate(error.name, COMPACT_ERROR_NAME_CHARS) }
			: {}),
		...(typeof error.message === 'string'
			? { message: truncate(error.message, COMPACT_ERROR_MESSAGE_CHARS) }
			: {}),
		...(typeof error.stack === 'string'
			? { stack: truncate(error.stack, COMPACT_ERROR_STACK_CHARS) }
			: {}),
	}
	return Object.keys(compact).length === 0 ? undefined : compact
}

function truncate(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input
	return `${input.slice(0, Math.max(0, maxChars - 1))}…`
}

function incrementSequence(input: string): string {
	try {
		return (BigInt(input) + 1n).toString(10)
	} catch {
		return input
	}
}
