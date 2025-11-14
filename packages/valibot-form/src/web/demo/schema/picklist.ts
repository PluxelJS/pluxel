import * as v from 'valibot'
import * as f from '~/index'

/** 大清单（触发智能默认：searchable 开、limit=6） */
const MODULES = [
	'auth',
	'payments',
	'search',
	'analytics',
	'notifications',
	'shipping',
	'inventory',
	'reviews',
	'coupons',
	'recommend',
	'chat',
	'maps',
	'ads',
	'abtest',
	'i18n',
] as const

/** 中等清单（触发智能默认：searchable 开） */
const REGIONS = [
	'tokyo',
	'osaka',
	'nagoya',
	'sapporo',
	'fukuoka',
	'kyoto',
	'kobe',
	'yokohama',
	'sendai',
	'hiroshima',
	'niigata',
	'hamamatsu',
	'kawasaki',
	'saitama',
] as const

export const PicklistSmartSchema = v.object({
	// 单选（必填）：默认不可清（智能默认），这里显示覆盖为可清
	env: v.pipe(
		v.picklist(['dev', 'staging', 'prod'] as const),
		f.picklistMeta({
			labels: { dev: '开发', staging: '预发', prod: '生产' },
			disabled: ['staging'],
			clearable: true, // 覆盖：必填也允许清空
			placeholder: '选择环境',
		}),
	),

	// 单选（必填）：小清单（<=8）→ 默认不搜索
	level: v.pipe(
		v.picklist(['low', 'mid', 'high'] as const),
		f.picklistMeta({
			labels: { low: '低', mid: '中', high: '高' },
			variant: 'segmented',
			// searchable/clearable 走智能默认
		}),
	),

	// 单选（可选）：中等清单（>=8）→ 默认可搜索 & 可清
	region: v.optional(
		v.pipe(
			v.picklist(REGIONS),
			f.picklistMeta({
				labels: {
					tokyo: '东京',
					osaka: '大阪',
					nagoya: '名古屋',
					sapporo: '札幌',
					fukuoka: '福冈',
					kyoto: '京都',
					kobe: '神户',
					yokohama: '横滨',
					sendai: '仙台',
					hiroshima: '广岛',
					niigata: '新潟',
					hamamatsu: '滨松',
					kawasaki: '川崎',
					saitama: '埼玉',
				},
				placeholder: '选择地区',
			}),
		),
	),

	// 多选（数字枚举）：显式限制最多可选 2 项，显示最多 2 个标签
	ports: v.pipe(
		v.array(
			v.pipe(
				v.picklist([80, 3000, 8080] as const),
				f.picklistMeta({
					multiple: true,
					labels: { 80: 'HTTP', 3000: 'Dev', 8080: 'Proxy' },
					searchable: true,
					clearable: true,
					placeholder: '选择端口',
					maxSelections: 2,
				}),
			),
		),
	),

	// 多选（大清单）：走智能默认（searchable 开、limit=6、无限制 maxValues）
	modules: v.pipe(
		v.array(
			v.pipe(
				v.picklist(MODULES),
				f.picklistMeta({
					labels: {
						auth: '认证',
						payments: '支付',
						search: '搜索',
						analytics: '统计',
						notifications: '通知',
						shipping: '配送',
						inventory: '库存',
						reviews: '评价',
						coupons: '优惠券',
						recommend: '推荐',
						chat: '聊天',
						maps: '地图',
						ads: '广告',
						abtest: 'A/B 测试',
						i18n: '多语言',
					},
					multiple: true,
					allowCreate: true,
					// maxValues/limit 不配置 → 根据 options 数量使用智能默认
				}),
			),
		),
	),
})
