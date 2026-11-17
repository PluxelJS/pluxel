export type HostPersistenceRetention = 'session' | 'declared-durable' | 'unknown'

export type HostPersistenceResult =
	| Readonly<{ status: 'unchanged' }>
	| Readonly<{ status: 'confirmed'; retention: HostPersistenceRetention }>
	| Readonly<{ status: 'unknown' }>
