import type { LoaderHmrConfig } from './engine/LoaderHmrService'
import { env as pluxelEnv } from '@pluxel/runtime/environment'

export function applyLoaderHmrEnvOverrides(
	base: LoaderHmrConfig,
	env: Readonly<Record<string, string | undefined>> = pluxelEnv,
): LoaderHmrConfig {
	const out: LoaderHmrConfig = { ...base }

	const portRaw = env.PLUXEL_HMR_PORT
	if (portRaw !== undefined) {
		const n = Number(String(portRaw).trim())
		if (Number.isFinite(n) && n >= 0) out.port = Math.floor(n)
	}

	const attributionRaw = env.PLUXEL_HMR_ATTRIBUTION
	if (attributionRaw !== undefined) {
		if (attributionRaw === '0' || attributionRaw === 'false') out.attribution = false
		else if (attributionRaw === '1' || attributionRaw === 'true') out.attribution = true
		else if (
			attributionRaw === 'trace' ||
			attributionRaw === 'debug' ||
			attributionRaw === 'info' ||
			attributionRaw === 'warn' ||
			attributionRaw === 'error' ||
			attributionRaw === 'fatal'
		) {
			out.attribution = attributionRaw
		} else {
			out.attribution = true
		}
	}

	return out
}
