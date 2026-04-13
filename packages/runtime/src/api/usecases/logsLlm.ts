import { formatUiLogRecordsForLlm, type LlmLogFormatOptions } from '../../logger/llm'
import type { LogFilter } from '../../logger/protocol'

import { type LogsLatestOutput, type LogsWaitInput, logsLatest, logsWaitFor } from './logs'

export type LogsTextInput = {
	streamId?: string
	filter?: LogFilter
	afterSeq?: string
	limit?: number
	format?: LlmLogFormatOptions
}

export type LogsTextOutput = {
	text: string
	streamId: string
	bootId: string
	epoch: number
	tailSeq: string
	count: number
	truncated: boolean
}

export function logsLatestText(input: LogsTextInput = {}): LogsTextOutput {
	const snap: LogsLatestOutput = logsLatest(input)
	const formatted = formatUiLogRecordsForLlm(snap.lines, input.format)
	return {
		text: formatted.text,
		count: formatted.count,
		truncated: formatted.truncated,
		streamId: snap.meta.streamId,
		bootId: snap.meta.bootId,
		epoch: snap.meta.epoch,
		tailSeq: snap.meta.tailSeq,
	}
}

export async function logsWaitForText(
	input: LogsWaitInput & { format?: LlmLogFormatOptions } = {},
): Promise<LogsTextOutput> {
	const snap = await logsWaitFor(input)
	const formatted = formatUiLogRecordsForLlm(snap.lines, input.format)
	return {
		text: formatted.text,
		count: formatted.count,
		truncated: formatted.truncated,
		streamId: snap.meta.streamId,
		bootId: snap.meta.bootId,
		epoch: snap.meta.epoch,
		tailSeq: snap.meta.tailSeq,
	}
}
