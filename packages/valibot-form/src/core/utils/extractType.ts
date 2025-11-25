import { extractArrayProps } from '../actions/array/arrayExtractor'
import { extractBooleanProps } from '../actions/boolean/booleanExtractor'
import { extractNumberProps } from '../actions/number/numberExtractor'
import { extractObjectProps } from '../actions/object/objectExtractor'
import { extractPicklistProps } from '../actions/picklist/picklistExtractor'
import { extractRecordProps } from '../actions/record/recordExtractor'
import { extractStringProps } from '../actions/string/stringExtractor'
import { extractUnionProps } from '../actions/union/unionExtractor'
import type { ExtractableMetaType } from './MetaType'
const extractors = {
	string: { type: 'string', extract: extractStringProps },
	number: { type: 'number', extract: extractNumberProps },
	boolean: { type: 'boolean', extract: extractBooleanProps },
	picklist: { type: 'picklist', extract: extractPicklistProps },
	array: { type: 'array', extract: extractArrayProps },
	record: { type: 'record', extract: extractRecordProps },
	object: { type: 'object', extract: extractObjectProps },
	union: { type: 'union', extract: extractUnionProps },
} as const satisfies {
	string: { type: ExtractableMetaType; extract: typeof extractStringProps }
	number: { type: ExtractableMetaType; extract: typeof extractNumberProps }
	boolean: { type: ExtractableMetaType; extract: typeof extractBooleanProps }
	picklist: { type: ExtractableMetaType; extract: typeof extractPicklistProps }
	array: { type: ExtractableMetaType; extract: typeof extractArrayProps }
	record: { type: ExtractableMetaType; extract: typeof extractRecordProps }
	object: { type: ExtractableMetaType; extract: typeof extractObjectProps }
	union: { type: ExtractableMetaType; extract: typeof extractUnionProps }
}

export const extractMap = extractors
export type ExtractMap = typeof extractMap
export type ExtractableType = keyof ExtractMap

export function isExtractableType(type: unknown): type is ExtractableType {
	return typeof type === 'string' && type in extractMap
}
