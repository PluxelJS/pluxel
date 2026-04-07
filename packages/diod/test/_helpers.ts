// tests/_helpers.ts

import { expectNotNullOrUndefined, type Maybe } from 'option-t/maybe'
import type { Result } from 'option-t/plain_result'
import {
	expectErr as expectErrForResult,
	expectOk as expectOkForResult,
} from 'option-t/plain_result/result'

/** 断言 Result 是 Ok 并返回值；若不是 Ok 会抛 TypeError（来自 option-t） */
export const expectOk = <T, E>(r: Result<T, E>, msg = 'expected Ok'): T => expectOkForResult(r, msg)

/** 断言 Result 是 Err 并返回错误值；若是 Ok 会抛 TypeError（来自 option-t） */
export const expectErr = <T, E>(r: Result<T, E>, msg = 'expected Err'): E =>
	expectErrForResult(r, msg)

/** 断言 Maybe 存在并返回值；若为 null/undefined 会抛 TypeError（来自 option-t） */
export const expectExist = <T>(r: Maybe<T>, msg = 'expected not null or undefined'): T =>
	expectNotNullOrUndefined(r, msg)
