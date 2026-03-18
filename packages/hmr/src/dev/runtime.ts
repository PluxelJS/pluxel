import type { HMRConfig } from './hmr/HMRService'

export function applyHmrEnvOverrides(base: HMRConfig, env = process.env): HMRConfig {
	const out: HMRConfig = { ...base }

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

	const builtinsStrictRaw = env.PLUXEL_HMR_BUILTINS_PRELOAD_STRICT
	if (builtinsStrictRaw !== undefined) {
		out.builtinsPreloadStrict =
			builtinsStrictRaw === '1' || builtinsStrictRaw === 'true' || builtinsStrictRaw === 'yes'
	}
	const autoDisableRaw = env.PLUXEL_HMR_BUILTINS_AUTO_DISABLE_MISSING_DEPS
	if (autoDisableRaw !== undefined) {
		out.builtinsAutoDisableMissingDependencies = !(
			autoDisableRaw === '0' ||
			autoDisableRaw === 'false' ||
			autoDisableRaw === 'no'
		)
	}
	const maxPassesRaw = env.PLUXEL_HMR_BUILTINS_AUTO_DISABLE_MAX_PASSES
	if (maxPassesRaw !== undefined) {
		const n = Number(maxPassesRaw)
		if (Number.isFinite(n) && n >= 0) out.builtinsAutoDisableMaxPasses = Math.floor(n)
	}

	return out
}

