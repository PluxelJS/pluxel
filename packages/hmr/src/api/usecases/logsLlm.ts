import type { LogFilter } from '../../logger/logStore'
import { formatUiLogRecordsForLlm, type LlmLogFormatOptions } from '../../logger/llm'

import { logsLatest, logsWaitFor, type LogsLatestOutput, type LogsWaitInput } from './logs'

export type LogsTextInput = {
	filter?: LogFilter
	afterId?: number
	limit?: number
	format?: LlmLogFormatOptions
}

export type LogsTextOutput = {
	text: string
	lastId: number
	bootId: string
	count: number
	truncated: boolean
}

export function logsLatestText(input: LogsTextInput = {}): LogsTextOutput {
	const snap: LogsLatestOutput = logsLatest(input)
	const formatted = formatUiLogRecordsForLlm(snap.records, input.format)
	return {
		text: formatted.text,
		count: formatted.count,
		truncated: formatted.truncated,
		lastId: snap.lastId,
		bootId: snap.bootId,
	}
}

export async function logsWaitForText(input: LogsWaitInput & { format?: LlmLogFormatOptions } = {}): Promise<LogsTextOutput> {
	const snap = await logsWaitFor(input)
	const formatted = formatUiLogRecordsForLlm(snap.records, input.format)
	return {
		text: formatted.text,
		count: formatted.count,
		truncated: formatted.truncated,
		lastId: snap.lastId,
		bootId: snap.bootId,
	}
}

