import * as v from 'valibot'
import { formMeta } from '~/core/actions/formMeta'
import { objectMeta } from '~/core/actions/objectMeta'
import { numberMeta } from '~/core/actions/number'
import { stringMeta } from '~/core/actions/string'

const AddressSchema = v.pipe(
	v.object({
		street: v.pipe(
			v.string(),
			formMeta({ label: '街道', helperText: '请输入街道信息' }),
			stringMeta({ placeholder: '南京东路' }),
		),
		city: v.pipe(v.string(), formMeta({ label: '城市' })),
		zip: v.pipe(
			v.number(),
			numberMeta({ variant: 'input', step: 1 }),
			formMeta({ label: '邮编' }),
		),
	}),
	formMeta({ label: '地址信息', description: '用于配送和发票的地址' }),
	objectMeta({ columns: 2, collapse: true }),
)

const LegalSchema = v.pipe(
	v.intersect([
		v.object({
			idNumber: v.pipe(
				v.string(),
				formMeta({ label: '证件号' }),
				stringMeta({ placeholder: '4401*************' }),
			),
		}),
		v.object({
			expireAt: v.pipe(
				v.string(),
				formMeta({ label: '有效期' }),
				stringMeta({ placeholder: '2028-01-01' }),
			),
		}),
	]),
	formMeta({ label: '证件信息' }),
	objectMeta({ columns: 2 }),
)

export const ObjectShowcaseSchema = v.object({
	profile: v.pipe(
		v.object({
			name: v.pipe(v.string(), formMeta({ label: '姓名' })),
			address: AddressSchema,
		}),
		formMeta({ label: '个人资料', description: '基本信息与联系方式' }),
		objectMeta({ columns: 1 }),
	),
	legal: LegalSchema,
})
