import { bootPlannedHmrHost, planHmrHost, type PlanHmrHostOptions } from '../../src/host'

export type CreateTestHmrHostOptions = Omit<PlanHmrHostOptions, 'fs' | 'chdir' | 'logging'> & {
	fs: NonNullable<PlanHmrHostOptions['fs']>
	chdir?: boolean
	logging?: PlanHmrHostOptions['logging']
}

export async function createTestHmrHost(options: CreateTestHmrHostOptions) {
	const plan = planHmrHost({
		chdir: false,
		logging: false,
		...options,
	})
	return bootPlannedHmrHost(plan)
}
