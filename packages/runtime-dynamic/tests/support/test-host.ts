import {
	bootPlannedLoaderHmrHost,
	planLoaderHmrHost,
	type LoaderHmrHostOptions,
} from '../../src/hmr/host'

export type CreateTestHmrHostOptions = Omit<LoaderHmrHostOptions, 'fs' | 'chdir' | 'logging'> & {
	fs: NonNullable<LoaderHmrHostOptions['fs']>
	chdir?: boolean
	logging?: LoaderHmrHostOptions['logging']
}

export async function createTestHmrHost(options: CreateTestHmrHostOptions) {
	const plan = planLoaderHmrHost({
		chdir: false,
		logging: false,
		...options,
	})
	return bootPlannedLoaderHmrHost(plan)
}
