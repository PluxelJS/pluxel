import { getPluginMarker } from './marker'
import { hasConsumedPluginDefinitionCandidate } from '../../runtime/definition'

/** @internal Route discovery predicate. Candidate ingestion remains the only metadata read. */
export function checkPluginDecorator(ctor: Function): boolean {
	return getPluginMarker(ctor) !== undefined || hasConsumedPluginDefinitionCandidate(ctor)
}
