import {
	bootPlannedLoaderHmrHost,
	planLoaderHmrHost,
	type LoaderHmrHostOptions,
} from '../../src/hmr/host'

export type CreateTestHmrHostOptions = Omit<LoaderHmrHostOptions, 'fs' | 'logging'> & {
	fs: NonNullable<LoaderHmrHostOptions['fs']>
	logging?: LoaderHmrHostOptions['logging']
}

export async function createTestHmrHost(options: CreateTestHmrHostOptions) {
	const plan = planLoaderHmrHost({
		logging: false,
		...options,
	})
	return bootPlannedLoaderHmrHost(plan)
}
