import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const FontsConfig = v.object({
	defaultFamily: v.pipe(
		v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
		f.formMeta({
			title: 'Default font family',
			description:
				'Host preference used when no managed preference is set. Omit to select an installed platform default automatically.',
		}),
	),
	maxRegistrationsPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_024)), 32),
		f.formMeta({
			title: 'Registrations per consumer',
			description: 'Maximum active programmatic font registrations owned by one caller plugin.',
		}),
	),
	maxNativeRegistrations: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4_096)), 512),
		f.formMeta({
			title: 'Native font registrations',
			description: 'Maximum active native registrations owned by this FontsPlugin node.',
		}),
	),
	maxTotalFontBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4_096 * MIB)), 256 * MIB),
		f.formMeta({
			title: 'Total registered font bytes',
			description: 'Maximum combined bytes represented by active native registrations.',
		}),
	),
	maxConcurrentFontTasks: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 4),
		f.formMeta({
			title: 'Concurrent font tasks',
			description: 'Maximum caller font copies, file reads and hashes admitted at once.',
		}),
	),
	maxQueuedFontTasks: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_096)), 32),
		f.formMeta({
			title: 'Queued font tasks',
			description: 'Maximum waiting font tasks across all caller Plugins.',
		}),
	),
	maxQueuedFontTasksPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)), 8),
		f.formMeta({
			title: 'Queued font tasks per consumer',
			description: 'Maximum waiting font tasks owned by one caller Plugin generation.',
		}),
	),
	maxPendingManagedTasks: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4_096)), 32),
		f.formMeta({
			title: 'Pending managed font tasks',
			description: 'Maximum accepted serialized managed-font operations, including the active one.',
		}),
	),
	maxManagedFonts: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_024)), 64),
		f.formMeta({
			title: 'Maximum managed fonts',
			description: 'Maximum fonts in the provider-owned persisted collection.',
		}),
	),
	maxFontBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 16 * MIB),
		f.formMeta({
			title: 'Maximum font bytes',
			description: 'Maximum size of one registered or uploaded font file.',
		}),
	),
})

export type FontsPluginConfig = v.InferOutput<typeof FontsConfig>
