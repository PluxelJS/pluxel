import type { Context } from '@pluxel/core'

import { type PluginStatusSnapshot, pluginStatus } from './plugins'

export type PluginWaitForStageInput = {
	name: string
	stage: string
	/** Timeout in milliseconds. Defaults to 30_000. */
	timeoutMs?: number
	/** Poll interval in milliseconds. Defaults to 80. */
	pollMs?: number
	signal?: AbortSignal
}

export type PluginWaitForStageOutput =
	| { ok: true; name: string; stage: string; status: PluginStatusSnapshot }
	| {
			ok: false
			name: string
			stage: string
			code: string
			message: string
			last?: PluginStatusSnapshot
	  }

function normalizeMs(value: unknown, fallback: number, min: number, max: number) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
	return Math.min(max, Math.max(min, Math.floor(value)))
}

export async function pluginWaitForStage(
	ctx: Context,
	input: PluginWaitForStageInput,
): Promise<PluginWaitForStageOutput> {
	const name = String(input.name ?? '').trim()
	const stage = String(input.stage ?? '').trim()
	if (!name)
		return { ok: false, name: '', stage, code: 'invalid_input', message: 'name is required' }
	if (!stage)
		return { ok: false, name, stage: '', code: 'invalid_input', message: 'stage is required' }

	const timeoutMs = normalizeMs(input.timeoutMs, 30_000, 0, 600_000)
	const pollMs = normalizeMs(input.pollMs, 80, 20, 2_000)

	const started = Date.now()

	let last = pluginStatus(ctx, name)
	if (!last)
		return {
			ok: false,
			name,
			stage,
			code: 'plugin_not_found',
			message: `Plugin not found: ${name}`,
		}
	if (last.lifecycleStage === stage) return { ok: true, name, stage, status: last }

	for (;;) {
		if (input.signal?.aborted) {
			return { ok: false, name, stage, code: 'aborted', message: 'Aborted', last }
		}

		const elapsed = Date.now() - started
		if (elapsed >= timeoutMs) {
			return {
				ok: false,
				name,
				stage,
				code: 'timeout',
				message: `Timed out waiting for stage: ${stage}`,
				last,
			}
		}

		await new Promise<void>((resolve) => setTimeout(resolve, pollMs))

		const now = pluginStatus(ctx, name)
		if (!now) {
			return {
				ok: false,
				name,
				stage,
				code: 'plugin_not_found',
				message: `Plugin not found: ${name}`,
				last,
			}
		}
		last = now
		if (last.lifecycleStage === stage) return { ok: true, name, stage, status: last }
	}
}
