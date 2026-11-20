import { formatPluginNodeReference, type PluginNodeAddress } from '@pluxel/core'
import { OUTBOUND_HTTP_LOG_STREAM_ID } from '@pluxel/core/logging/protocol'
import { buildPluginDetailHref } from '../../workbench/paths'
import { buildLogsHref } from '../router/logsSearch'

export const OUTBOUND_HTTP_PATH = '/outbound-http'
export const OUTBOUND_HTTP_DEFAULTS_PATH = `${OUTBOUND_HTTP_PATH}/defaults`
export const PLUGIN_OUTBOUND_HTTP_PATH = '/config/outbound-http'

export function buildOutboundHttpNodeHref(owner: PluginNodeAddress): string {
	return buildPluginDetailHref(owner, PLUGIN_OUTBOUND_HTTP_PATH)
}

export function buildOutboundHttpActivityHref(owner?: PluginNodeAddress): string {
	return owner
		? `${OUTBOUND_HTTP_PATH}?plugin=${encodeURIComponent(formatPluginNodeReference(owner))}`
		: OUTBOUND_HTTP_PATH
}

export function buildOutboundHttpLogsHref(owner?: PluginNodeAddress): string {
	return buildLogsHref({
		stream: OUTBOUND_HTTP_LOG_STREAM_ID,
		...(owner ? { plugin: formatPluginNodeReference(owner) } : {}),
	})
}
