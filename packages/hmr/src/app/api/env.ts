import type { Env as HonoEnv } from 'hono'

export type { AppEnv } from '../../services/hono/env'

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type HasVars = { Variables: Record<string, unknown> }

export type AddVars<E extends HasVars, V extends Record<string, unknown>> = Simplify<
	Omit<E, 'Variables'> & { Variables: E['Variables'] & V }
>
