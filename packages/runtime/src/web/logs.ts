/**
 * The Runtime store protocol is also the Workbench wire protocol. Keep one type source so the
 * producer, validator, client, and UI cannot drift when a log-line field is added.
 */
export type {
	LogFilter,
	LogRangeErr,
	LogRangeOk,
	LogRangeResult,
	LogStreamMeta,
	RuntimeLogAppend,
	RuntimeLogError,
	RuntimeLogEvent,
	RuntimeLogGap,
	RuntimeLogLine,
	RuntimeLogReset,
} from '../logger/protocol'
