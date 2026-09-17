import type { Context } from '@pluxel/core'
import { formatUiLogRecordsForLlm, type LlmLogFormatOptions } from '@pluxel/logging/internal'
import type { LogFilter } from '@pluxel/logging/protocol'

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

export function logsLatestText(ctx: Context, input: LogsTextInput = {}): LogsTextOutput {
	const snap: LogsLatestOutput = logsLatest(ctx, input)
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
	ctx: Context,
	input: LogsWaitInput & { format?: LlmLogFormatOptions } = {},
): Promise<LogsTextOutput> {
	const snap = await logsWaitFor(ctx, input)
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
