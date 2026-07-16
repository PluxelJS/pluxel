export type Ok<T> = { ok: true; val: T }
export type Err<E> = { ok: false; err: E }
export type Result<T, E> = Ok<T> | Err<E>

export const ok = <T>(val: T): Ok<T> => ({ ok: true, val })
export const err = <E>(value: E): Err<E> => ({ ok: false, err: value })
