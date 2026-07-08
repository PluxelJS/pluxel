// Generated from data/apis.json. Run `pnpm --filter @repo/external-api-gateway-yiqicha-catalog generate-types` after updating the catalog.
import { type YiqichaApiKey } from './api-codes.ts'

/** 实际控制人 request parameters. */
export interface ActualControllerParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 实际控制人 response. */
export interface ActualControllerResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 股东 id */
			invPid: string
			/** 实际控制人所名称 */
			invName: string
			/** 最终受益股份 */
			benefitShare: string
			/** 受益类型 */
			benefitTypeDesc: string
			/** 任职类型 */
			positionCn: string
		}>
	}
}

/** 变更记录 request parameters. */
export interface AlterEnterpriseParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 变更类型（0其他变更，1法人变更，2股东变更，3地址/住所、经营场所变更，4增资，5减资,6经营范围变更 7 名称变更 8 章程变更 9人员/成员变更） */
	altType?: number
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 变更记录 response. */
export interface AlterEnterpriseResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 变更后内容 */
			altAfter: string
			/** 变更前内容 */
			altBefore: string
			/** 变更日期 */
			altDate: string
			/** 变更序号（数组的序号，按照时间倒序） */
			altIndex: number
			/** 变更事项 */
			altItem: string
			/** 变更类型 */
			altType: string | number
			/** 变更类型描述 */
			altTypeDesc: string | null
			/** 企业id */
			pid: string
		}>
	}
}

/** 企业年报-修改信息 request parameters. */
export interface AnnualAlterListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-修改信息 response. */
export interface AnnualAlterListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 修改后 */
			altAfter: string
			/** 修改前 */
			altBefore: string
			/** 修改日期 */
			altDate: string
			/** 修改事项 */
			altItem: string
			/** 年报ID */
			reportId?: string
		}>
	}
}

/** 企业年报-股权变更信息 request parameters. */
export interface AnnualAlterStockListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-股权变更信息 response. */
export interface AnnualAlterStockListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 变更日期 */
			altDate: string
			/** 股东名称 */
			invName: string
			/** 年报ID */
			reportId: string
			/** 变更后股权比例 */
			transAmAft: number
			/** 变更前股权比例 */
			transAmBe: number
		}>
	}
}

/** 企业年报-资产状况信息 request parameters. */
export interface AnnualAssetListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-资产状况信息 response. */
export interface AnnualAssetListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 主营业务收入(实际) */
			mainIncomeNum: number | null
			/** 净利润总额（实际） */
			netProfitNum: number | null
			/** 企业唯一标识 */
			pid: string
			/** 年报ID */
			reportId: string
			/** 资产总额（实际） */
			totalAssetNum: number | null
			/** 负债总额（实际） */
			totalDebtNum: number | null
			/** 所有权益合计(实际) */
			totalEquityNum: number | null
			/** 利润总额（实际） */
			totalProfitNum: number | null
			/** 营业总收入(实际) */
			totalSaleNum: number | null
			/** 纳税总额(实际) */
			totalTaxNum: number | null
			/** 企业经营状态 */
			busSt: string
		}>
	}
}

/** 企业年报-企业基本信息 request parameters. */
export interface AnnualBaseInfoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-企业基本信息 response. */
export interface AnnualBaseInfoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 企业联系电话 */
			tel: string
			/** 电子邮箱 */
			email: string
			/** 邮政编码 */
			postalCode: string
			/** 企业通信地址 */
			address: string | null
			/** 从业人数 */
			empNum: number
			/** 有限责任公司本年度是否发生股东股权转让 */
			stockChangeAm: string | number
			/** 企业是否有投资信息或购买其他公司股权 */
			investAm: string
			/** 年报ID */
			reportId: string
			/** 年报名称 */
			reportName: string | null
			/** 企业年报年份 */
			year: number
		}>
	}
}

/** 企业年报-对外提供担保信息 request parameters. */
export interface AnnualGuaranteeListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-对外提供担保信息 response. */
export interface AnnualGuaranteeListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 债权人 */
			creditor: number | string
			/** 主债权数额 */
			creditorAm: string
			/** 主债权种类 */
			creditorType: string
			/** 保证的期间 */
			guaranteePeriod: string
			/** 保证的方式 */
			guaranteeType: string
			/** 债务人 */
			obligor: string
			/** 履行债务的开始日期 */
			peformFrom: string
			/** 履行债务的结束日期 */
			peformTo: string
			/** 年报ID */
			reportId: string
		}>
	}
}

/** 企业年报-企业对外投资 request parameters. */
export interface AnnualInvestmentListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-企业对外投资 response. */
export interface AnnualInvestmentListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 被投资企业名称 */
			entName: string
			/** 被投资企业注册号 */
			regNo: string
			/** 年报ID */
			reportId: string
			/** 被投资企业统一社会信用代码 */
			uncid: string | null
			/** 企业id */
			pid: string
		}>
	}
}

/** 企业年报-社保信息 request parameters. */
export interface AnnualSocialInsuranceListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-社保信息 response. */
export interface AnnualSocialInsuranceListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 生育保险(人) */
			birthSo: number
			/** 单位参加生育保险缴费基数（万元） */
			birthSoBase: number | null
			/** 参加生育保险本期实际缴费基数（万元） */
			birthSoReal: number | null
			/** 单位参加生育保险累计欠缴金额（万元） */
			birthSoUnpaid: number | null
			/** 是否公示单位缴费基数 */
			hasSoBase: number
			/** 是否公示本期实际缴费金额 */
			hasSoReal: number
			/** 是否公示单位累计欠缴金额 */
			hasSoUnpaid: number
			/** 伤保险(人) */
			injurySo: number
			/** 加工伤保险本期实际缴费基数（万元） */
			injurySoReal: number | null
			/** 单位参加工伤保险累计欠缴金额（万元） */
			injurySoUnpaid: number | null
			/** 职工基本医疗保险(人) */
			medicalSo: number
			/** 单位参加职工基本医疗保险缴费基数（万元） */
			medicalSoBase: number | null
			/** 参加职工基本医疗保险本期实际缴费基数（万元） */
			medicalSoReal: number | null
			/** 单位参加职工基本医疗保险累计欠缴金额（万元） */
			medicalSoUnpaid: number | null
			/** 企业唯一标识 */
			pid: string
			/** 年报ID */
			reportId: string
			/** 年度 */
			year: string | number
			/** 城镇职工基本养老保险(人) */
			retireSo: number
			/** 单位参加城镇职工基本养老保险缴费基数（万元） */
			retireSoBase: number | null
			/** 参加城镇职工基本养老保险本期实际缴费基数（万元） */
			retireSoReal: number | null
			/** 单位参加城镇职工基本养老保险累计欠缴金额（万元) */
			retireSoUnpaid: number | null
			/** 失业保险(人) */
			unemploySo: number
			/** 单位参加失业保险缴费基数（万元） */
			unemploySoBase: number | null
			/** 参加失业保险本期实际缴费基数(万元） */
			unemploySoReal: number | null
			/** 单位参加失业保险累计欠缴金额（万元） */
			unemploySoUnpaid: number | null
		}>
	}
}

/** 企业年报-股东出资信息 request parameters. */
export interface AnnualSponsorListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报-股东出资信息 response. */
export interface AnnualSponsorListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 实缴出资额（万元） */
			acConAm: string | number
			/** 实缴出资时间 */
			acConDate: string
			/** 实缴出资方式 */
			acConForm: string
			/** 企业一级行业 */
			industryFirstCode: string
			/** 持股比例 */
			insto: number | null
			/** 发起人 */
			invName: string
			/** 股东pid,有值为企业，无值为人名 */
			invPid: string
			/** 年报ID */
			reportId: string
			/** 认缴出资额（万元） */
			subConAm: string | number
			/** 认缴出资时间 */
			subConDate: string
			/** 认缴出资方式 */
			subConForm: string
		}>
	}
}

/** 企业年报网址 request parameters. */
export interface AnnualWebsiteListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业年报网址 response. */
export interface AnnualWebsiteListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 类型 */
			webType: string | number
			/** 企业网址名称 */
			webName: string
			/** 网址 */
			webDomain: string
		}>
	}
}

/** 破产重整  request parameters. */
export interface BankruptcyReorganizationListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 破产重整  response. */
export interface BankruptcyReorganizationListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			caseNumber: string
			/** 公开日期 */
			pubDate: string
			/** 案件类型 */
			caseType: string
			/** 被申请人 */
			respondent: string
			/** 申请人 */
			proposer: string
			/** 案件唯一哈希 */
			hash: string
			/** 管理人机构 */
			custodian: string
			/** 管理人主要负责人 */
			custodianTakeCharge: string
			/** 经办法院 */
			court: string
		}>
	}
}

/** 分支机构 request parameters. */
export interface BranchEnterpriseParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 分支机构 response. */
export interface BranchEnterpriseResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 分支机构名称 */
			branchEntName: string
			/** 分支机构pid */
			branchPid: string
			/** 法定代表人 */
			legalPerson: string
			/** 成立日期 */
			esDateDesc: string
			/** 登记状态（代码） */
			entStatus: number
			/** 登记状态 */
			entStatusDesc: string
			/** 注册号 */
			regNo: string
			/** 统一社会信用代码 */
			uncid: string
			/** 注册资本 */
			regCap: string | number
			/** 注册资本单位 */
			regCapCur: string
		}>
	}
}

/** 查询进出口信用 request parameters. */
export interface CertCustomsListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 查询进出口信用 response. */
export interface CertCustomsListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 注册信息 */
			certRegisterInfoBo: {
				[key: string]: unknown
			}
			/** 海关行政处罚 */
			customsPublishBo: Array<unknown>
		}>
	}
}

/** 资质证书 request parameters. */
export interface CertInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 资质证书 response. */
export interface CertInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 证书信息 */
			certInfoBo: Array<{
				/** 证书类型 */
				certType?: string
				/** 证书名称 */
				certName?: string
				/** 证书编号 */
				certNo?: string
				/** 证书状态 */
				certStatus?: string
				/** 颁证日期 */
				issueDate?: string
				/** 证书到期日期 */
				validTo?: string
				/** 初次获证日期 */
				firstCertDate?: string
				/** 信息上报日期 */
				infoReportDate?: string
				/** 认证依据的标准和技术要求 */
				certStrandard?: string
				/** 产品类型 */
				productCategory?: string
				/** 产品名称及单元 */
				productName?: string
			}>
			/** 发证机构信息 */
			authCertInfoBo: Array<{
				/** 发证机关 */
				issueParty?: string
				/** 机构批准号 */
				authPartyNo?: string
				/** 认证机构有效截止时间 */
				authPartyValidTo?: string
				/** 机构状态 */
				authPartyStatus?: string
				/** 官网 */
				website?: string
				/** 认证机构地址 */
				authPartyAddress?: string
				/** 认证机构业务范围 */
				authPartyScope?: string
			}>
			/** 认证委托信息 */
			authEntrustInfoBo: Array<{
				/** 认证委托人组织地址 */
				certEntLoc?: string
				/** 认证委托人组织名称 */
				certEntName?: string
				/** 认证委托人PID */
				certEntPid?: string
				/** 统一信用代码 */
				uncid?: string
			}>
			/** 生产者(制造商)基本信息 */
			producerUnitInfoBo: Array<{
				/** 生产者PID */
				producerPid?: string
				/** 生产者（制造商）组织地址 */
				producerAddress?: string
				/** 生产者（制造商）组织名称 */
				producerName?: string
				/** 生产企业统一信用代码 */
				produceEntUncid?: string
			}>
		}>
	}
}

/** 清算信息核查 request parameters. */
export interface CleanRiskListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 清算信息核查 response. */
export interface CleanRiskListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业唯一标识 */
			pid: string
			/** 清算成员 */
			memName: string
			/** 清算人员负责人 */
			memLeader: string
		}>
	}
}

/** 经营商品 request parameters. */
export interface CommodityInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
	/** 品牌类型code */
	commodityClassificationCode?: string
	/** 条码状态(1 已注册 2 已注销 3 其他) */
	barcodeStatus?: string
	/** 上市年限类型 */
	marketYearLimit?: string
}

/** 经营商品 response. */
export interface CommodityInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 产品名称 */
			commodityName: string
			/** 商品条码 */
			barcode: string
			/** 品牌名称 */
			brandName: string
			/** 条码状态类型（1 已注册 2 已注销 3 其他） */
			barcodeStatusType: number
			/** 条码状态 */
			barcodeStatus: string
			/** 产品分类 */
			commodityClassification: string
			/** 上市日期 */
			marketDate: string
			/** 规格 */
			specification: string
			/** 净含量 */
			netQuantity: string | null
			/** 条形码图片 */
			barcodeOssid: string
		}>
	}
}

/** 企业联系方式 request parameters. */
export interface ContractDetailEnterpriseListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业联系方式 response. */
export interface ContractDetailEnterpriseListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 活跃度 */
			actNum: number
			/** 归属地城市 */
			attributionProvince: string
			/** 联系人 */
			contactPerson: string
			/** 职位 */
			contactPosition: string
			/** 疑似代理记账 1: 是；0: 否 */
			isAccountingAgent: number
			/** 活跃号 1: 是；0: 否 */
			isActive: number
			/** 关键人 1: 是；0: 否 */
			isKeyPerson: number
			/** 推荐号码 1: 是；0: 否 */
			isRecTag: number
			/** 风险号 1: 是；0: 否 */
			isRisk: number
			/** Int32 1: 是；0: 否 */
			isWechatSame: string | number
			/** 运营商 */
			operatorName: string
			/** 联系方式 */
			phone: string
			/** 联系方式类型 101-手机 102-固话 */
			phoneType: string
			/** 企业pid */
			pid: string
			/** 被投资企业的统一信用代码 */
			sameNameKpList: Array<unknown>
		}>
	}
}

/** 实际控制企业 request parameters. */
export interface ControlEntParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 实际控制企业 response. */
export interface ControlEntResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 控制企业名称pid */
			childEntPid: string
			/** 控制企业名称 */
			childEntName: string
			/** 投资比例 */
			benefitShare: string | number
			/** 登记状态 */
			entStatus: string
			/** 一级行业 */
			industryFirstCode: string
			/** 二级行业 */
			industrySecondCode: string
			/** 省份编码 */
			provinceCode: string
			/** 城市编码 */
			cityCode: string
			/** 区县编码 */
			districtCode: string
		}>
	}
}

/** 客户查询 request parameters. */
export interface CooperationListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
	/** 年份 */
	year?: number
}

/** 客户查询 response. */
export interface CooperationListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 客户pid */
			cooperateEntPid: string
			/** 客户名称 */
			cooperateEntName: string
			/** 销售占比 */
			percentage: string | null
			/** 销售金额 */
			tradeAmount: string | null
			/** 报告期/公开期 */
			publishDate: string
			/** 数据来源 */
			linkType: string | null
			/** 关联关系 */
			affiliated: string | null
			/** 关联事件id */
			relevantId: string | null
			/** 全部销售的数量 */
			allDataCount: string | number
		}>
	}
}

/** 软件著作权 request parameters. */
export interface CopyrightSoftwareListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 软件著作权 response. */
export interface CopyrightSoftwareListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 著作权人名称 */
			authorName: string
			/** 软件全称 */
			fullName: string
			/** 首次发表日期 */
			pubDate: string | null
			/** 登记日期 */
			regDate: string
			/** 登记号 */
			regNo: string
			/** 软件简称 */
			simpleName: string | null
			/** 软件版本号 */
			version: string
		}>
	}
}

/** 作品著作权 request parameters. */
export interface CopyrightWorksListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 作品著作权 response. */
export interface CopyrightWorksListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 创作完成日期 */
			finishDate: string
			/** 首次发表日期 */
			firstPublishDate: string | null
			/** 登记日期 */
			regDate: string
			/** 登记号 */
			regNo: string
			/** 作品名称 */
			worksName: string
			/** 作品类别名称 */
			worksType: string
		}>
	}
}

/** 备案网站查询 request parameters. */
export interface DomainRecordListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 备案网站查询 response. */
export interface DomainRecordListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 审核时间 */
			checkDate: string
			/** 首次发表日期 */
			record: string
			/** 备案编号 */
			regDate?: string
			/** 备案号是否失效 0:否 1:是 */
			recordExpired: string | number
			/** 备案号是否失效 */
			recordExpiredName: string
			/** 备案号/许可证号 */
			recordId: string
			/** 域名 */
			siteDomain: string
			/** 网站首页地址 */
			siteHome: string
			/** 网站名称 */
			siteName: string
		}>
	}
}

/** 四要素验证  request parameters. */
export interface ElementFourVerifyParams {
	/**  企业名称 */
	companyName: string
	/**  统一社会信用代码 */
	socialCreditCode: string
	/** 法定代表人名称 */
	legalPersonName: string
	/**  法定代表人身份证号码 */
	legalPersonIdCard: string
}

/** 四要素验证  response. */
export interface ElementFourVerifyResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示调用成功，其他值表示调用失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 核验结果：true-核验通过;false-核验不通过 */
		verifyResult?: number
		/** 详细验证状态 */
		matchDetails: Array<{
			/** 企业名称验证结果：true-匹配、false-不匹配 */
			companyName?: boolean
			/** 统一社会信用代码验证结果：true-匹配、false-不匹配 */
			socialCreditCode?: boolean
			/** 法定代表人姓名验证结果：true-匹配、false- 不匹配 */
			legalPersonName?: boolean
			/** 法定代表人身份证号码验证结果：true-匹配、false-不匹配 */
			legalPersonIdCard?: boolean
		}>
	}
}

/** 三要素验证 request parameters. */
export interface ElementThreeVerifyParams {
	/** 社会统一信用码 */
	uncid: string
	/** 企业名称 */
	entName: string
	/** 法定代表人姓名，如法人实际为空，则填写“-”代替 */
	legalPerson: string
}

/** 三要素验证 response. */
export interface ElementThreeVerifyResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 核验结果：0:未查到该企业信用代码,1:验证成功,2:企业名称验证失败,3:法定代表人验证失败 */
		verifyResult: number
	}
}

/** 二要素验证 request parameters. */
export interface ElementTwoVerifyParams {
	/** 社会统一信用码 */
	uncid: string
	/** 核验名称（verifyType=1时请输入企业名称，verifyType=2时请输入法定代表人名称） */
	verifyName: string
	/** 核验方式，1：企业名称+统一社会信用代码核验，2：法定代表人名称+统一社会信用代码核验 */
	verifyType: number
}

/** 二要素验证 response. */
export interface ElementTwoVerifyResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 核验结果：0:未查到该企业信用代码,1:企业名称/法定代表人验证成功,2:验证失败 */
		verifyResult: number
	}
}

/** 经营异常核查 request parameters. */
export interface EntAbnormalList1031Params {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 是否历史经营异常 0 非历史异常 1 历史异常 */
	isHistory: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 经营异常核查 response. */
export interface EntAbnormalList1031Response {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 列入日期 */
			abnormalDate: string
			/** 移除日期 */
			removeAbnormalDate: string
			/** 决定机关(列入) */
			decOrg: string
			/** 决定机关(移除) */
			removeDecOrg: string | null
			/** 列入原因 */
			speReason: string
			/** 移除原因 */
			removeSpeReason: string
			/** 公告名称 */
			annoName: string
			/** 公告号 */
			annoNo: string | null
			/** 类型 1列入 2移出 */
			annoType: number
			/** 企业名称 */
			entName: string
			/** 企业id */
			pid?: string
		}>
	}
}

/** 信用评价 request parameters. */
export interface EntAbnormalList1045Params {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 信用评价 response. */
export interface EntAbnormalList1045Response {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 评价年度 */
			year: number
			/** 纳税人识别号 */
			uncid: string | null
			/** 纳税人信用级别 */
			rating: string
			/** 评价单位 */
			authority: string
			/** 纳税人名称 */
			altItem?: string
			/** 变更类型 */
			entName: string
			/** 纳税人pid */
			pid: string
		}>
	}
}

/** 知识产权出质 request parameters. */
export interface EntCopyrightListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 知识产权出质 response. */
export interface EntCopyrightListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 质权人名称 */
			impOrg: string
			/** 种类 */
			kind: string
			/** 出质人名称 */
			pledgor: string
			/** 质权登记期限（开始时间） */
			pleRegPerFrom: string
			/** 质权登记期限（结束时间） */
			pleRegPerTo: string | null
			/** 公示日期 */
			publicDate: string
			/** 名称 */
			tmName: string
			/** 知识产权登记证号 */
			tmRegNo: string
		}>
	}
}

/** 企业信息标签 request parameters. */
export interface EnterpriseInfoTagsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业信息标签 response. */
export interface EnterpriseInfoTagsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** id */
			id: string | null
			/** tag名称 */
			name: string
			/** 父节点定位名称 */
			parentPosition: string | null
			/** 定位点 */
			position: string | null
			/** 浮动标题 */
			floatTitle: string | null
		}>
	}
}

/** 概念标签 request parameters. */
export interface EnterpriseTagsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 概念标签 response. */
export interface EnterpriseTagsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** id */
			id: string
			/** tag名称 */
			name: string
			/** 父节点定位名称 */
			parentPosition: string
			/** 定位点 */
			position: string
			/** 浮动标题 */
			floatTitle: string | null
		}>
	}
}

/** 企业坐标 request parameters. */
export interface EntGeoInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业坐标 response. */
export interface EntGeoInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 维度值 */
			lat: string
			/** 经度值 */
			lon: string
			/** 城市编码 */
			cityCode: string
			/** 区县编码 */
			districtCode: string
			/** 省份编码 */
			provinceCode: string
			/** geo地址 */
			address: string
			/** 街道名 */
			street: string
			/** 乡镇名 */
			town: string
		}>
	}
}

/** 企业图谱 request parameters. */
export interface EntGraphParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业图谱 response. */
export interface EntGraphResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage?: number
		/** 每页记录数 */
		pageSize?: number
		/** 总记录数 */
		totalCount?: number
		/** 总页数 */
		totalPage?: number
		/** 列表数据 */
		list?: Array<{
			/** 企业pid */
			id?: string
			/** 企业名称 */
			name?: string
			/** 子节点 */
			children?: Array<{
				/** 关联 id */
				id?: string
				/** 名称 */
				name?: string
				/** 节点类型(999:企业,998:人员) */
				nodeType?: string
				/** 子节点 */
				children?: Array<{
					/** 关联 id */
					id?: string
					/** 名称 */
					name?: string
					/** 节点类型(999:企业,998:人员) */
					nodeType?: string
					/** 职位 */
					job?: string
					/** 百分比 */
					percent?: string
				}>
			}>
		}>
	}
}

/** 企业历史名称 request parameters. */
export interface EntHistoryNameListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业历史名称 response. */
export interface EntHistoryNameListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 企业历史名称 */
			historyName: string
		}>
	}
}

/** 严重违法核查 request parameters. */
export interface EntIllegalListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 严重违法核查 response. */
export interface EntIllegalListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 列入移除日期 */
			abnTime: string
			/** 移除日期 */
			removeAbnormalDate: string
			/** 决定机关(列入) */
			decOrg: string
			/** 决定机关(移除) */
			removeDecOrg: string
			/** 序号 */
			idx?: string
			/** 类型   1列入   2移除 */
			illType?: string
			/** 企业id */
			pid: string
			/** 列入移除严重违法失信企业名单（黑名单）原因 */
			speReason: string
			/** 移除原因 */
			removeSpeReason: number | string
			/** 企业名称 */
			entName: string
		}>
	}
}

/** 企业行业 request parameters. */
export interface EntIndustryListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业行业 response. */
export interface EntIndustryListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 所属一级行业 */
			industryFirst: string
			/** 所属二级行业 */
			industrySecond: string
			/** 三级行业 */
			industryThird: string
		}>
	}
}

/** 企业简介 request parameters. */
export interface EntInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业简介 response. */
export interface EntInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 企业名称 */
			entName: string
			/** 企业简介 */
			companyInfo: string
		}>
	}
}

/** 企业logo request parameters. */
export interface EntLogoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业logo response. */
export interface EntLogoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 商标Logo */
			businessLogoUrl: string
			/** 网址 */
			url: string
			/** 公司名称 */
			companyName: string
		}>
	}
}

/** 动产抵押核查 request parameters. */
export interface EntMortListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 动产抵押核查 response. */
export interface EntMortListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 做出处罚机关 */
			comments: string
			/** 罚款金额（万元） */
			mortNo: number | string
			/** 状态 1有效 2无效 3其他 */
			mortStatus: number
			/** 状态说明 */
			mortStatusName: string
			/** 债务人履行债务的期限（开始时间） */
			pefPerForm: string
			/** 债务人履行债务的期限（结束时间） */
			pefPerTo: string
			/** 企业id */
			pid: string
			/** 被担保债权数额（数额） */
			priClaSecAm: string | number
			/** 被担保主债权种类 */
			priClaSecTypeCn: string
			/** 被担保债权数额（单位） */
			regCapCurCn: string | null
			/** 登记日期 */
			regDate: string
			/** 登记机关 */
			regOrgCn: string
			/** 担保的范围 */
			warCov: string
			/** 证照号码 */
			blicNo: string
			/** 抵押权人证照类型 */
			blicType: string
			/** 住所地 */
			mortLoc: string
			/** 抵押权人名称 */
			mortName: string
			/** 抵押权人pid */
			personPid: string
			/** 抵押id */
			mortId: string
			/** 抵押物信息 */
			mortGuaranteesList: Array<{
				/** 备注 */
				commtnes: string | null
				/** 抵押物描述md5 */
				guaranteeHash: string
				/** 抵押物名称 */
				guaranteeName: string
				/** 抵押id */
				mortId: string
				/** 所有权或使用权归属 */
				own: string
				/** 所有权或使用权归属pid */
				ownPid: string
			}>
		}>
	}
}

/** 企业规模 request parameters. */
export interface EntScaleListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业规模 response. */
export interface EntScaleListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 企业规模代码 */
			tagCode: string
			/** 企业规模（微型企业/小型企业/中型企业/大型企业） */
			tagName: string
		}>
	}
}

/** 企业三码 request parameters. */
export interface EntThreeCodeListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业三码 response. */
export interface EntThreeCodeListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 统一社会信用代码 */
			uncid: string
			/** 企业名称 */
			entName: string
			/** 组织机构代码 */
			orgCode: string
			/** 工商注册号 */
			regNo: string
			/** 登记状态 */
			entStatus: string
		}>
	}
}

/** 股权投资 request parameters. */
export interface EquityInvestmentParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 股权投资 response. */
export interface EquityInvestmentResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业pid */
			pid: string
			/** 企业名称 */
			entName: string
			/** 登记状态 */
			entStatus: string
			/** 详情数量 */
			detailCount: string | number
			/** 投资列表 */
			shareholderList: Array<{
				/** 股东id */
				pid: string
				/** 股东名称 */
				entName: string
				/** 登记状态 */
				entStatus: string
				/** 持股比例 */
				invInsto: string
				/** 详情数量 */
				detailCount: number
				/** 标签 */
				tags: Array<{
					/** id */
					id: string | null
					/** tag名称 */
					name: string
					/** 父节点定位名称 */
					parentPosition: string | null
					/** 定位点 */
					position: string | null
					/** 浮动标题 */
					floatTitle: string | null
				}>
			}>
		}>
	}
}

/** 工商照面 request parameters. */
export interface GetBasicInfoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
}

/** 工商照面 response. */
export interface GetBasicInfoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 地址 */
		address: string
		/** 核准日期 */
		apprDate: string
		/** 城市代码 */
		cityCode: string
		/** 区域代码 */
		districtCode: string
		/** 企业名称 */
		entName: string
		/** 企业英文名 */
		entNameEn: string
		/** 企业状态 1 存续 2 吊销 3 注销 4 迁出 8 歇业 9 其他 */
		entStatus: number | string
		/** 企业类型 */
		entType: number
		/** 企业类型名称 */
		entTypeDesc: string
		/** 成立时间 */
		esDateDesc: string
		/** 历史名称 */
		historyName: Array<string>
		/** 一级行业 */
		industryFirstCode: string
		/** 二级行业 */
		industrySecondCode: string
		/** 三级行业 */
		industryThirdCode: string
		/** 文字介绍 */
		introduction: number | string
		/** 法定代表人 */
		legalPerson: string
		/** 营业期限自 */
		opFromDesc: string
		/** 经营范围 */
		opScope: string
		/** 营业期限至 */
		opToDesc: string | null
		/** 组织机构编码 */
		orgCode: string
		/** 企业id */
		pid: string
		/** 省份代码 */
		provinceCode: number | string
		/** 注册资本 */
		regCap: number
		/** 注册资本单位 */
		regCapCur: number | string
		/** 实缴金额 */
		recCap: number | string
		/** 实缴金额单位 */
		recCapCur: number | string
		/** 工商注册号 */
		regNo: string
		/** 登记机关 */
		regOrgDesc: string
		/** 国企标签 */
		tags: Array<{
			/** id */
			id?: string
			/** tag名称 */
			name?: string
			/** 父节点定位名称 */
			parentPosition?: string
			/** 定位点 */
			position?: string
			/** 浮动标题 */
			floatTitle?: string
		}>
		/** 统一社会信用代码 */
		uncid: string
		/** 组织机构类型 */
		institution: string
	}
}

/** 上榜榜单详情 request parameters. */
export interface GetBillboardDetailsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 上榜榜单详情 response. */
export interface GetBillboardDetailsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** id */
			id: string
			/** 榜单名称 */
			listName: string
			/** 榜单类型 */
			typeCode: string | number
			/** 榜单类型 */
			typeName: string
			/** 榜单日期 */
			listDate: string | null
		}>
	}
}

/** APP详情 request parameters. */
export interface GetBuAppInfoDetailsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** APP详情 response. */
export interface GetBuAppInfoDetailsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 头像 */
			LogoOssId?: string
			/** app名称 */
			appName: string
			/** 简介 */
			description: string
			/** 分类 */
			appCategoryDesc: string
			/** 更新内容 */
			updateContent: string
			/** 版本号 */
			version: string
			/** 发布时间 */
			releaseDate: string
			/** 应用下载量 */
			downlodAm: string
			/** 排名 */
			appRank: string | null
			/** 下载量级 */
			downloadLevel: string
			/** app唯一代码 */
			appId: string
			/** 上架平台代码 */
			platformId: string
		}>
	}
}

/** 小程序查询 request parameters. */
export interface GetBuAppletInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 小程序查询 response. */
export interface GetBuAppletInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 头像 */
			LogoOssId?: string
			/** 分类 */
			category: string | number
			/** 分类名称 */
			categoryName: string
			/** 二维码 */
			qrcodeOssId: string | null
		}>
	}
}

/** 历史股权冻结 request parameters. */
export interface GetEntAssistDetailsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史股权冻结 response. */
export interface GetEntAssistDetailsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** pid */
			pid: string
			/** 执行通知书文号 */
			executeNo: string
			/** 执行裁定书文号 */
			froDocNo: string
			/** 被执行人 */
			inv: string
			/** 执行法院 */
			froAuth: string
			/** 类型/状态 */
			froStateCn: string
			/** 冻结期限自 */
			froFromDate: string
			/** 冻结期限至 */
			froToDate: string
			/** 冻结期限 */
			froDeadline: string
			/** 被执行人持有股权、其它投资权益的数额 */
			froAm: string
			/** 被执行人证照号码 */
			blicNo: string
			/** 执行事项 */
			blicTypeCn: string
			/** 公示日期 */
			publicDate: string | null
		}>
	}
}

/** 工商股东 request parameters. */
export interface GetEnterprisePartnersParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 工商股东 response. */
export interface GetEnterprisePartnersResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 实缴额（万元） */
			invAcConAm: string
			/** 实缴类型编码 */
			invAcConCode: string
			/** 实缴出资日期 */
			invAcConDate: string
			/** 实缴方式 */
			invAcConType: string
			/** 持股数量 */
			invAmount: string
			/** 列入当期股东日期 */
			invHistoryInDate: string
			/** 持股比例 */
			invInsto: string
			/** 股东id */
			invPid: string
			/** 股东名称 */
			invName: string
			/** 持股类型 */
			invStockType: string
			/** 认缴额(万元) */
			invSubConAm: string
			/** 认缴类型编码 */
			invSubConCode: string
			/** 认缴出资日期 */
			invSubConDate: string
			/** 认缴方式 */
			invSubConType: string
			/** 股东类型 */
			invType: string
			/** 企业唯一标识 */
			pid: string
		}>
	}
}

/** 历史经营异常 request parameters. */
export interface GetEpEntIndbusListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史经营异常 response. */
export interface GetEpEntIndbusListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 公告号 */
			annoNo: string
			/** 公告名称 */
			annoName: string
			/** 作出决定机关（列入） */
			decOrg: string
			/** 列入经营异常名录原因 */
			removeDecOrg: string
			/** 移除经营异常名录原因 */
			removeSpeReason: string
			/** 许可机关统一社会信用代码 */
			authPartyUncid?: string
			/** 列入日期 */
			abnormalDate: string
			/** 移除日期 */
			removeAbnormalDate: string
		}>
	}
}

/** 企业已获政策补贴明细 request parameters. */
export interface GetHaveApplyPolicyListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
	/** 年份 如：2025 */
	dataYear?: number
	/** 项目名称 */
	projectName?: string
}

/** 企业已获政策补贴明细 response. */
export interface GetHaveApplyPolicyListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 项目名称 */
			projectName: string
			/** 课题 */
			topicName: string
			/** 项目级别 */
			gradeName: string
			/** 项目类型 */
			typeName: string
			/** 受理部门 */
			departmentName: string
			/** 补贴金额 */
			subsidyMoney: string
		}>
	}
}

/** 对外投资 request parameters. */
export interface GetInvestEnterpriseParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 对外投资 response. */
export interface GetInvestEnterpriseResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 被投资企业名称 */
			childEntName: string
			/** 被投资企业pid */
			childEntPid: string
			/** 被投资企业状态 */
			entStatus: string
			/** 成立日期 */
			esDateDesc: string
			/** 持股比例 */
			invInsto: string
			/** 认缴额(万元) */
			invSubConAm: string
			/** 被投资公司的法定代表人 */
			legalPerson: string
			/** 被投资公司的注册资本 */
			regCap: string
			/** 注册资本单位 */
			regCapCur: string
			/** 被投资企业的统一信用代码 */
			uid: string
		}>
	}
}

/** 历史备案网站 request parameters. */
export interface GetInWebDomainRecordListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史备案网站 response. */
export interface GetInWebDomainRecordListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 网站名称 */
			siteName: string
			/** 网址 */
			siteHome: string
			/** 域名 */
			siteDomain: string
			/** 备案号/许可证号 */
			recordId: string
			/** 备案编号 */
			record: string
			/** 备案号是否失效状态 */
			recordExpired: string
			/** 备案号是否失效状态名称 */
			recordExpiredName: string
			/** 审核时间 */
			checkDate: string
		}>
	}
}

/** 查询新增企业信息 request parameters. */
export interface GetNewEnterpriseInfoParams {
	/** 省份编码 */
	provinceCode: string
	/** 城市编码 */
	cityCode: string
	/** 成立开始日期 格式：yyyy-MM-dd */
	startTime?: string
	/** 成立结束日期 格式：yyyy-MM-dd */
	endTime?: string
	/** 行业代码 */
	industryCode?: string
	/** 企业分类 */
	categoryNew?: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 查询新增企业信息 response. */
export interface GetNewEnterpriseInfoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 法定代表人 */
			legalPerson: string
			/** 企业名称 */
			entName: string
			/** 注册资本 */
			regCap: string
			/** 注册资本单位 */
			regCapCurShow: string
			/** 地址 */
			address: string
			/** 统一社会信用代码 */
			uncid: string
			/** 企业状态 */
			entStatus: string
			/** 成立时间 */
			esDateDesc: string
			/** 省份代码 */
			provinceCode: string
			/** 城市 */
			cityCode: string
			/** 区域 */
			districtCode: string
			/** 一级行业 */
			industryFirstCode: string
		}>
	}
}

/** 网店信息 request parameters. */
export interface GetOnlineShopListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
	/** 网店名称 */
	shopName?: string
}

/** 网店信息 response. */
export interface GetOnlineShopListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 网店名称 */
			shopName: string
			/** 开店时间 */
			establishDate: string
			/** 商户评分 */
			shopRate: number | null
			/** 商户来源 */
			sourceCn: string
			/** 产品数 */
			productNum: string | number
		}>
	}
}

/** 历史对外投资 request parameters. */
export interface GetPartnersParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史对外投资 response. */
export interface GetPartnersResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 被投资企业Pid */
			childEntPid: string
			/** 被投资企业名称 */
			childEntName: string
			/** 登记状态 */
			entStatus: string
			/** 成立日期 */
			esDateDesc: string
			/** 一级行业 */
			industryFirstCode: string
			/** 一级行业 */
			industryFirstName?: string
			/** 持股比例 */
			invInsto: string | null
			/** 认缴额（万元） */
			invSubConAm: string
			/** 省份名称 */
			provinceName: string
			/** 城市名称 */
			cityName: string
			/** 区县名称 */
			districtName: string
		}>
	}
}

/** 历史行政许可 request parameters. */
export interface GetPermissionDetailParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史行政许可 response. */
export interface GetPermissionDetailResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 决定文书/许可证名称 */
			permissionName: string
			/** 许可编号 */
			certNo: string
			/** 许可证书名称 */
			certName: string
			/** 许可决定日期 */
			certDate: string
			/** 许可类别 */
			certType: string
			/** 许可机关统一社会信用代码 */
			authPartyUncid: string
			/** 数据来源单位统一社会信用代码 */
			permissionSourceUncid: string
			/** 有效期自 */
			permissionDate: string
			/** 有效期至 */
			permissionEndDate: string
			/** 许可机关 */
			authParty: string
			/** 许可内容 */
			permissionContent: string
			/** 数据来源单位 */
			permissionSource: string
			/** 数据来源单位pid */
			permissionSourcePid: string
			/** 来源类型（1 工商 2 信用中国） */
			sourceType: string
		}>
	}
}

/** 企业业务查询 request parameters. */
export interface GetPersonIntroInfoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 企业业务查询 response. */
export interface GetPersonIntroInfoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 产品id */
			projectId: string
			/** 产品图片 */
			url: string | null
			/** 产品图片类型 0-路径 1-名称 */
			urlType: string
			/** 产品名 */
			projectName: string
			/** 融资信息 */
			currentStage: string
			/** 成立日期 */
			esDate: string
			/** 成立日期 */
			esDateTime: string
			/** 所属地 */
			area: string
			/** 关联企业 */
			entName: string
			/** 产品介绍 */
			projectDesc: string
			/** 标签信息 */
			tagName: Array<string>
			/** 省份 */
			provinceCode: string | null
			/** 竞品分页数据 */
			competingInfo: Array<Record<string, unknown>>
		}>
	}
}

/** 企业已获补贴 request parameters. */
export interface GetPolicySubsidyStatParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
}

/** 企业已获补贴 response. */
export interface GetPolicySubsidyStatResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 企业pid */
		pid: string
		/** 企业名称 */
		entName: string
		/** 已获补贴数量 */
		haveSubsidyCount: number
		/** 已补贴金额 */
		haveTotalSubsidyMoney: string
	}
}

/** 股权出质核查 request parameters. */
export interface GetStockInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 股权出质核查 response. */
export interface GetStockInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 登记编号 */
			equityNo: string
			/** 股权出质设立登记日期 */
			equPleDate: string
			/** 出质股权数额（金额） */
			impAm: string | number
			/** 质权人 */
			impOrg: string
			/** 质权人证照/证件号码 */
			impOrgBlicNo: string
			/** 质权人PID */
			impPid: string
			/** 企业id */
			pid: string
			/** 出质人 */
			pledgor: string
			/** 出质人PID */
			pledgorPid: string
			/** 出质人证照/证件号码 */
			pledBlicNo: string
			/** 出质币种（单位） */
			regCapCurCn: string
			/** 状态（编码）1有效 2无效 */
			status: string | number
			/** 状态 */
			statusCn?: string
		}>
	}
}

/** 公众号 request parameters. */
export interface GetWechatAccountInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 公众号 response. */
export interface GetWechatAccountInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 头像 */
			ossId: string
			/** 微信码 */
			wechatAccount: string
			/** 微信公众号 */
			wechatName: string
			/** 二维码 */
			wechatQrcode: string
			/** 简介 */
			wechatDesc: string
			/** 企业唯一代码 */
			pid: string
		}>
	}
}

/** 微博 request parameters. */
export interface GetWeiboInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 微博 response. */
export interface GetWeiboInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 头像 */
			ossId: string
			/** 微博用户名 */
			weiboAccount: string
			/** 微博昵称 */
			weiboName: string
			/** 粉丝数量 */
			fanCount: string
			/** 城市 */
			city: string
			/** 关注数 */
			followerCount: string
			/** 最后发博时间 */
			lastPostTime: string
			/** 简介 */
			weboDesc?: string
			/** 企业唯一代码 */
			pid: string
		}>
	}
}

/** 集团成员企业信息 request parameters. */
export interface GroupInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 集团成员企业信息 response. */
export interface GroupInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 主企业名称 */
			name?: string
			/** 集团名称 */
			groupName?: string
			/** 集团企业数 */
			memberEntCount?: string
			/** 成员企业名称 */
			entname?: string
			list?: Array<{
				/** 实际控制人持股比例 */
				controlPersonPercent?: string
				/** 法定代表人 */
				legalPerson?: string
				/** 注册资本 */
				regCap?: string
				/** 注册资本单位 */
				regCapCur?: string
				/** 企业状态 */
				entStatus?: string
				/** 成员企业统一社会信用代码 */
				uid?: string
				/** 登记状态 */
				entStatusDesc?: string
			}>
		}>
	}
}

/** 历史工商信息 request parameters. */
export interface HistoryCompanyInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史工商信息 response. */
export interface HistoryCompanyInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 变更类型描述 */
			altTypeDesc: string
			/** 变更类型 */
			altType: string | number
			/** pid */
			pid: string
			/** 有效期起 */
			children: Array<Record<string, unknown>>
		}>
	}
}

/** 历史行政处罚 request parameters. */
export interface HistoryEntPenaltyListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史行政处罚 response. */
export interface HistoryEntPenaltyListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 做出处罚机关 */
			authParty: string
			/** 罚款金额（万元） */
			forfeit: string | null
			/** 违法事实 */
			illegalAction: string
			/** 没收违法所得金额（万元） */
			illegalIncome: string | null
			/** 违法行为 */
			illegalType: string
			/** 处罚内容或者处罚结果 */
			penaltyContent: string
			/** 处罚决定日期 */
			penaltyDate: string
			/** 处罚信息来源 */
			penaltySource: string
			/** 处罚类型 */
			penaltyType: string
			/** 企业唯一id */
			pid: string
			/** 行政处罚相对人 */
			entName: string
		}>
	}
}

/** 历史法定代表人 request parameters. */
export interface HistoryLegalPersonListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史法定代表人 response. */
export interface HistoryLegalPersonListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 姓名 */
			name: string
			/** 卸任日期 */
			dischargeDateDesc: string
		}>
	}
}

/** 历史主要人员 request parameters. */
export interface HistoryPersonListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史主要人员 response. */
export interface HistoryPersonListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 姓名 */
			name: string
			/** 卸任日期 */
			dischargeDateDesc?: string
			/** positionCn */
			positionCn: string
		}>
	}
}

/** 历史严重违法 request parameters. */
export interface HistorySeverityIllegalListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史严重违法 response. */
export interface HistorySeverityIllegalListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业pid */
			pid: string
			/** 列入机关 */
			decOrg: string
			/** 列入日期 */
			abnTime: string
			/** 列入原因 */
			speReason: string
			/** 移除机关 */
			removeDecOrg: string | null
			/** 移除原因 */
			removeSpeReason: string | null
			/** 类型 1列入 2 移除 */
			illType: string | number
			/** 移除日期 */
			removeAbnTime: string | null
		}>
	}
}

/** 历史股东信息 request parameters. */
export interface HistoryShareholderListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 历史股东信息 response. */
export interface HistoryShareholderListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 姓名 */
			name: string
			/** 股东类型 */
			stockType: string
			/** 退出时持股比例 */
			exitStockPercent: string
			/** 认缴出资额 */
			shouldCapi: string | null
			/** 认缴出资日期 */
			shouldCapiDate: string | null
			/** 实缴出资额 */
			realCapi: string | null
			/** 实缴出资日期 */
			realCapiDate: string | null
		}>
	}
}

/** 间接持股企业 request parameters. */
export interface IndirectEntParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 间接持股企业 response. */
export interface IndirectEntResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 控制企业名称pid */
			childEntPid: string
			/** 控制企业名称 */
			childEntName: string
			/** 投资比例 */
			benefitShare: string | number
			/** 登记状态 */
			entStatus: string
			/** 一级行业 */
			industryFirstCode: string
			/** 二级行业 */
			industrySecondCode: string
			/** 省份编码 */
			provinceCode: string
			/** 城市编码 */
			cityCode: string
			/** 区县编码 */
			districtCode: string
			/** 法定代表人 */
			legalPerson: string
			/** 注册资本 */
			regCap: string | number
			/** 注册资本单位 */
			regCapCur: string
			/** 类型 */
			type: Array<number>
		}>
	}
}

/** 人员间接持股信息 request parameters. */
export interface IndirectHolderEntListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员间接持股信息 response. */
export interface IndirectHolderEntListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 城市code */
			cityCode: string | number
			/** 区域code */
			districtCode: string | number
			/** 图片路径 */
			imgUrl: string
			/** 企业名称 */
			entName: string
			/** 企业状态(1 存续 2 吊销 3 注销 4 迁出 5 停业歇业 6 其他) */
			entStatus: number | string
			/** 企业状态描述 */
			entStatusDesc: string
			/** 成立日期 */
			esTime: string
			/** 一级行业code */
			industryFirstCode: string
			/** 法定代表人 */
			legalPerson: string
			/** 法定代表人id */
			legalPersonId: string
			/** 企业pid */
			pid: string
			/** 省份code */
			provinceCode: string
			/** 注册资本 */
			regCapAmt: string
			/** 注册资本单位 */
			regCapCur: string
			/** 投资比例 */
			shareRatio?: string
			/** 标签列表 */
			tagList: Array<{
				/** id */
				id: string
				/** tag名称 */
				name: string
				/** 父节点定位名称 */
				parentPosition: string
				/** 定位点 */
				position: string
				/** 1.大股东 2.上市 3.风险 20.实际控制人 21.最终受益人 */
				type: number
			}>
		}>
	}
}

/** 国际专利查询 request parameters. */
export interface InternationPatentInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 国际专利查询 response. */
export interface InternationPatentInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 专利权人 */
			applicant: string
			/** 申请日期 */
			applyDate: string
			/** 申请号 */
			applyNo: string
			/** 授权公告/申请公布日期 */
			applyPubDate: string
			/** 授权公告号 */
			applyPubNo: string | null
			/** 申请年份 */
			applyYear: string | number
			/** 专利附图 */
			imageUrl: string
			/** 专利附图列表 */
			imgUrlList: string | null
			/** 专利名称 */
			patentName: string
			/** 专利类型 */
			patentType: string
			/** 优先权 */
			priority: string | null
			/** 主权项 */
			sovereignty: string | null
			/** 专利状态码 */
			statusCode: string | number
			/** 专利状态 */
			statusName: string
			/** 受理局 */
			acceptBureau: string
			/** 申请人地址 */
			address: string
			/** 申请人邮箱 */
			applyPostalCode: string | null
			/** 代理机构 */
			agency: string
			/** 代理人 */
			agencyPerson: string
			/** 发明人 */
			inventor: string | null
			/** 摘要 */
			brief: string | null
			/** pid */
			pid: string
			/** 申请(专利权)人 */
			nameInfoList: Array<string>
			/** 法律状态 */
			lawStatusList: Array<unknown>
			/** 申请进度 */
			flowList: Array<Record<string, unknown>>
		}>
	}
}

/** 投资方列表 request parameters. */
export interface InvestInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 类型：1.企业、2.自然人 */
	entType: number
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 投资方列表 response. */
export interface InvestInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 主企业名称 */
			name: string
			/** 集团名称 */
			groupName: string | null
			/** 集团企业数 */
			memberEntCount: string
			/** 成员企业名称 */
			entname?: string
			list: Array<{
				/** 投资方pid */
				pid: string
				/** 投资方公司名称 */
				investEntName?: string
				/** 被投资企业名称 */
				investedEntName?: string
				/** 投资比例 */
				invInsto: string | null
				/** 投资数额 */
				invSubConAm: string
				/** 投资日期 */
				invSubConDate: string
			}>
		}>
	}
}

/** 融资信息核查 request parameters. */
export interface InvestProjectInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 融资信息核查 response. */
export interface InvestProjectInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 投资时间 */
			fundDate: string
			/** 投资机构列表 */
			fundNames: string
			/** 融资阶段 */
			fundStage: string
			/** 融资总额 */
			investAmount: string
			/** 新闻链接 */
			newsUrl: string
			/** 企业id */
			pid: string
			/** 产品id */
			projectId: string
			/** 投后估值 */
			valuation: string
			/** 产品名称 */
			projectName: string
		}>
	}
}

/** 股权冻结 request parameters. */
export interface LawAssistListVoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 股权冻结 response. */
export interface LawAssistListVoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 被执行人证照号码 */
			blicNo: string | null
			/** 被执行人证照种类 */
			blicTypeCn: string
			/** 执行通知书文号 */
			executeNo: string
			/** 执行法院 */
			froAuth: string
			/** 冻结信息-冻结期限 */
			froDeadline: string | null
			/** 执行裁定书文号 */
			froDocNo: string
			/** froFromDate */
			'冻结信息-冻结期限自'?: string
			/** 类型/状态 */
			froStateCn: string
			/** 冻结信息-冻结期限至 */
			froToDate: string
			/** 被执行人 */
			inv: string
			/** 企业唯一代码 */
			pid: string
			/** 公示日期 */
			publicDate: string
			/** 被执行人持有股权、其它投资权益的数额 */
			froAm: number
		}>
	}
}

/** 司法拍卖 request parameters. */
export interface LawAuctionAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 司法拍卖 response. */
export interface LawAuctionAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业PID */
			pid: string
			/** 公告标题 */
			annoTitle: string
			/** 标的名称 */
			auctionName: string
			/** 处置机关单位 */
			author: string
			/** 标的类型 1不动产，2股权，3其他 */
			objectTypeCode: number
			/** 标的类型描述 */
			objectTypeName: string
			/** 公告原文html */
			ossId: string
			/** 起拍价格 */
			price: number
			/** 拍卖开始时间 */
			startDate: string
			/** 拍卖结束时间 */
			endDate: string
		}>
	}
}

/** 法院公告详情 request parameters. */
export interface LawDeliverListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 法院公告详情 response. */
export interface LawDeliverListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案由 */
			brief: string
			/** 涉诉事件ID */
			caseId: string
			/** 公告原文 */
			content: string
			/** 公告法院 */
			court: string
			/** 发表日期 */
			issueDate: string
			/** 案号 */
			referenceNo: string
			/** 公告类型 */
			title: string
			/** 当事人列表 */
			nameKeyList: Array<{
				/** 企业类型 */
				partyTypeName: Array<{
					/** 企业id */
					pid?: string
					/** 企业名称 */
					name?: string
					/** 类型 */
					type?: string
				}>
			}>
		}>
	}
}

/** 送达公告详情 request parameters. */
export interface LawDeliverNoticeListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 送达公告详情 response. */
export interface LawDeliverNoticeListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案由 */
			brief: string
			/** 涉诉事件ID */
			caseId: string
			/** 公告原文 */
			content: string
			/** 公告法院 */
			court: string
			/** 公告发布日期 */
			pubDate: string
			/** 案号 */
			referenceNo: string
			/** 当事人列表 */
			nameKeyList: Array<{
				/** 企业类型 */
				partyTypeName: Array<{
					/** 企业id */
					pid?: string
					/** 企业名称 */
					name?: string
					/** 类型 */
					type?: string
				}>
			}>
		}>
	}
}

/** 失信被执行人详情 request parameters. */
export interface LawDishonestListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 失信被执行人详情 response. */
export interface LawDishonestListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 做出执行依据的单位 */
			authParty: string
			/** 涉诉事件ID */
			caseId: string
			/** 承办法院 */
			court: string
			/** 生效法律文书确定的义务 */
			enfDuty: string
			/** 执行依据文号 */
			enfNo: string
			/** 失信行为的具体情形 */
			enfSituation: string
			/** 被执行人的履行情况 */
			enfStatus: string
			/** 立案日期 */
			filingDate: string
			/** 公告日期 */
			pubDate: string
			/** 执行案号 */
			referenceNo: string
			/** 涉案金额 */
			amount: number | null
			/** 企业id */
			pid: string
			/** 证件号/组织机构代码 */
			cardNo: string
			/** 失信被执行人 */
			enfName: string
			/** 法定代表人 */
			legalPerson: string
			/** 未履行部分 */
			unperformPartDesc: string
			/** 省份代码 */
			province: number
			/** 已履行部分 */
			performedPartDesc: string
			/** 被执行人类型 */
			partyTypeName: string
			/** 被执行人代码 */
			partyTypeCode: number
		}>
	}
}

/** 终本案件查询 request parameters. */
export interface LawEndExecutionListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 终本案件查询 response. */
export interface LawEndExecutionListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 企业id */
			pid: string
			/** 被执行人 */
			enfName: string
			/** 执行标的 */
			enfObject: number
			/** 终本日期 */
			endDate: string
			/** 法院 */
			court: string
			/** 证件号/组织机构代码 */
			cardNo: string
			/** 未履行的金额 */
			unperformPart: number
		}>
	}
}

/** 被执行人详情 request parameters. */
export interface LawEnforceInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 被执行人详情 response. */
export interface LawEnforceInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 涉诉事件ID */
			caseId: string | null
			/** 法院 */
			court: string | null
			/** 执行标的 */
			enfObject: number | null
			/** 立案时间 */
			filingDate: string
			/** 案号 */
			referenceNo: string | null
			/** 未履行金额 */
			unperformPart: number | null
			/** 被执行人 */
			enfName: string
			/** 身份证号码/组织机构代码 */
			cardNo: string
			/** 企业id */
			pid: string
		}>
	}
}

/** 立案信息详情 request parameters. */
export interface LawInitiateAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 立案信息详情 response. */
export interface LawInitiateAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 法官助理 */
			assistant: number | string
			/** 案由 */
			brief: string
			/** 涉诉事件ID */
			caseId: string
			/** 案件状态 */
			caseStatus: string
			/** 涉诉类型 */
			caseType: number
			/** 涉诉类型 */
			caseTypeName: string
			/** 承办部门 */
			contractors: string
			/** 法院 */
			court: string
			/** 开庭日期 */
			courtDate: string
			/** 结案日期 */
			endDate: string
			/** 立案日期 */
			filingDate: string
			/** 法官 */
			judge: string
			/** 案号 */
			referenceNo: string
			/** 当事人列表 */
			nameKeyList: Array<{
				/** 企业类型 */
				partyTypeName: Array<{
					/** 企业id */
					pid?: string
					/** 企业名称 */
					name?: string
					/** 类型 */
					type?: string
				}>
			}>
		}>
	}
}

/** 开庭公告详情 request parameters. */
export interface LawOpenAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 开庭公告详情 response. */
export interface LawOpenAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 案号 */
			referenceNo: string
			/** 案由 */
			brief: string
			/** 法官 */
			judge: string
			/** 涉诉事件ID */
			caseId: string
			/** 公告内容 */
			content: string
			/** 法院 */
			court: string
			/** 开庭时间 */
			courtDate: string
			/** 法庭 */
			tribunal: string
			/** 当事人列表 */
			nameKeyList: Array<{
				/** 企业类型 */
				partyTypeName: Array<{
					/** 企业id */
					pid?: string
					/** 企业名称 */
					name?: string
					/** 类型 */
					type?: string
				}>
			}>
		}>
	}
}

/** 裁判文书 request parameters. */
export interface LawRefereeDocListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 裁判文书 response. */
export interface LawRefereeDocListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 关联案号 */
			associatedNo: string | null
			/** 案由 */
			brief: string
			/** 涉诉事件ID */
			caseId: string
			/** 审理程序 */
			caseProcedure: string
			/** 法院 */
			court: string
			/** 判决结果 */
			judgeResult: string
			/** 案件类型 1:管辖案件, 2:刑事案件 3:民事案件, 4:行政案件5:执行类案件, 6:国家赔偿与司法救助案件,7区际司法协助案件 8:国际司法协助案件9:非诉保全审查案件,0:其他 */
			litigationType: number | null
			/** 案件类型描述 */
			litigationTypeName: string
			/** 省份 */
			province: string | null
			/** 发布时间 */
			pubDate: string
			/** 裁判时间 */
			refereeDate: string
			/** 原文判决内容 */
			refereeDocResult: string
			/** 文书类型 */
			refereeDocType: number
			/** 文书类型描述 */
			refereeDocTypeName: string
			/** 案号 */
			referenceNo: string
			/** 企业pid */
			pid: string
			/** 当事人列表 */
			nameKeyList: Array<{
				/** 企业类型 */
				partyTypeName: Array<{
					/** 企业id */
					pid?: string
					/** 企业名称 */
					name?: string
					/** 类型 */
					type?: string
				}>
			}>
			/** 涉案金额 */
			verdictClaim: string | null
			/** 标题 */
			title: string
		}>
	}
}

/** 限制高消费 request parameters. */
export interface LimitHighInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 限制高消费 response. */
export interface LimitHighInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 涉诉事件ID */
			caseId: string
			/** 限令正文 */
			content: string
			/** 法院 */
			court: string
			/** 立案日期 */
			filingDate: string
			/** 公告发布日期 */
			pubDate: string
			/** 案号 */
			referenceNo: string
			/** 关联对象 */
			person: string
			/** 涉案金额 */
			enfObject: number | null
			/** 原文 */
			attachUrl: string
			/** 限消令对象信息 */
			nameKeyInfo: {
				/** 企业id */
				pid: string
				/** 企业名称 */
				name: string
				/** 类型 */
				type: string
			}
			/** 申请人信息 */
			sqrInfo: {
				/** 企业id */
				pid?: string
				/** 企业名称 */
				name?: string
			} | null
		}>
	}
}

/** 模糊搜索 request parameters. */
export interface MatchSearchParams {
	/** 企业相关关键词（如企业名、电话） */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 模糊搜索 response. */
export interface MatchSearchResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业名称 */
			entName: string
			/** 企业类型 */
			entTypeDesc: string
			/** 匹配类型 */
			matchType: string
			/** 企业唯一标识 */
			pid: string
			/** 注册号 */
			regNo: string
			/** 社会统一信用代码 */
			uncid: string
			/** 地址 */
			address: string
			/** 企业法定代表人 */
			legalPerson: string
		}>
	}
}

/** 小微企业 request parameters. */
export interface MiniEntListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 小微企业 response. */
export interface MiniEntListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 企业名称 */
			entName: string
			/** 企业类型 */
			entTypeDesc: string
			/** 成立日期 */
			esDate: string
			/** 所属一级行业 */
			industryFirstDesc: string
			/** 所属二级行业 */
			industrySecondDesc: string
			/** 注册资本（金额） */
			regCap: string
			/** 注册资本（单位） */
			regCapCur: string
			/** 登记机关 */
			regOrgDesc: string
		}>
	}
}

/** 高级搜索 request parameters. */
export interface MoreDetailsSearchParams {
	/** 关键词（如企业名、统一社会信用代码、法定代表人、电话等） */
	keyword: string
	/** 参保人数起(请输入数值，例如:20) */
	canbaoFrom?: number
	/** 参保人数止(请输入数值，例如:200) */
	canbaoTo?: number
	/** 注册资本起(请输入数值，例如:100) */
	capiFrom?: number
	/** 注册资本止(请输入数值，例如:1000) */
	capiTo?: number
	/** 城市 code */
	citycode?: string
	/** 成立日期起（YYYY-mm-dd） */
	dateFrom?: string
	/** 成立日期止（YYYY-mm-dd） */
	dateTo?: string
	/** 组织类型，多个使用逗号分割，具体值参考附录 */
	entTypeDesc?: string
	/** 行业码 */
	industryCode?: string
	/** 省份 */
	provinceCode?: string
	/** 组织机构类型，多个使用逗号分割，具体值参考附录 */
	institution?: string
	/** 企业状态，多个使用逗号分隔，1.存续 2.吊销 3.注销 4.迁出 8.歇业 9其他 */
	status?: number
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 高级搜索 response. */
export interface MoreDetailsSearchResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业分类 */
			categoryNew: string
			/** 企业名称 */
			entName: string
			/** 企业状态 */
			entStatusName: string
			/** 成立日期 */
			esDate: number | string
			/** 企业法定代表人 */
			legalPerson: string
			/** 企业id */
			pid: string
			/** 注册资本 */
			regCap: string
			/** 注册资本单位 */
			regCapCurShow: string
			/** 注册号 */
			regNo: string
			/** 社会统一信用代码 */
			uncid: string
			/** 地址 */
			address: string
			/** 组织机构类型 */
			institution: string
			/** 企业类型 */
			entType: number
			/** 企业类型描述 */
			entTypeDesc?: string
		}>
	}
}

/** 新闻舆情 request parameters. */
export interface NewsInfoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 新闻舆情 response. */
export interface NewsInfoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 新闻标题 */
			title: string
			/** 发布时间 */
			newsTime: string
			/** 新闻来源 */
			source: string
			/** 新闻分类 */
			category: string
			/** 新闻分类值 */
			categoryName: string
			/** 情感类型 */
			emotion: string
			/** 情感类型值 */
			emotionValue: string
			/** 正文 */
			newsText: string
		}>
	}
}

/** 集团-对外投资 request parameters. */
export interface OutInvestInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 集团-对外投资 response. */
export interface OutInvestInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 主企业名称 */
			group_name?: string
			/** 集团名称 */
			entname?: string
			/** 列表数据 */
			list: Array<{
				/** 投资的公司pid */
				pid: string
				/** 投资方公司名称 */
				entName: string
				/** 产品图片 */
				imgUrl: string | null
				/** 注册资金 */
				regCap: string
				/** 注册资本（单位） */
				regCapCur: string
				/** 负责人名称 */
				legalPersonName: string
				/** 负责人pid */
				legalPersonPid: string | null
				/** 负责人类型(1 公司 2 自然人(如果是自然人 则负责人pid为空)) */
				legalPersonType: string
				/** 成立日期 */
				esDate: string
				/** 登记状态(1 存续,在业 2 吊销 3 注销 4 迁出 5 停业歇业 6 其他) */
				entStatus: string
				/** 投资的成员企业的数量 */
				investedCount?: string
			}>
		}>
	}
}

/** 股权架构 request parameters. */
export interface OwnershipStructureParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 股权架构 response. */
export interface OwnershipStructureResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业pid */
			pid: string
			/** 企业名称 */
			entName: string
			/** 登记状态 */
			entStatus: string
			/** 详情数量 */
			detailCount: string | number
			/** 投资列表 */
			shareholderList: Array<{
				/** 股东id */
				pid: string
				/** 股东名称 */
				entName: string
				/** 登记状态 */
				entStatus: string
				/** 持股比例 */
				invInsto: string
				/** 详情数量 */
				detailCount: number
				/** 标签 */
				tags: Array<{
					/** id */
					id: string | null
					/** tag名称 */
					name: string
					/** 父节点定位名称 */
					parentPosition: string | null
					/** 定位点 */
					position: string | null
					/** 浮动标题 */
					floatTitle: string
				}>
			}>
		}>
	}
}

/** 专利查询 request parameters. */
export interface PatentInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 是否是国际专利 是 1 否 0 */
	internation: number
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 专利查询 response. */
export interface PatentInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 专利权人 */
			applicant: string
			/** 申请日期 */
			applyDate: string
			/** 申请号 */
			applyNo: string
			/** 授权公告/申请公布日期 */
			applyPubDate: string
			/** 授权公告号 */
			applyPubNo: string
			/** 申请年份 */
			applyYear: string | number
			/** 专利附图 */
			imageUrl: string
			/** 专利附图列表 */
			imgUrlList: string | null
			/** 专利名称 */
			patentName: string
			/** 专利类型 */
			patentType: string
			/** 优先权 */
			priority: string | null
			/** 主权项 */
			sovereignty: string | null
			/** 专利状态码 */
			statusCode: string | number
			/** 专利状态 */
			statusName: string
			/** 受理局 */
			acceptBureau: string
			/** 申请人地址 */
			address: string
			/** 申请人邮箱 */
			applyPostalCode: string | null
			/** 代理机构 */
			agency: string
			/** 代理人 */
			agencyPerson: string
			/** 发明人 */
			inventor: string
			/** 摘要 */
			brief: string
			/** pid */
			pid: string
			/** 申请(专利权)人 */
			nameInfoList: Array<string>
			/** 法律状态 */
			lawStatusList: Array<Record<string, unknown>>
			/** 申请进度 */
			flowList: Array<unknown> | null
		}>
	}
}

/** 行政处罚核查 request parameters. */
export interface PenaltyListVoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 行政处罚核查 response. */
export interface PenaltyListVoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 做出处罚机关 */
			authParty: string
			/** 罚款金额（万元） */
			forfeit: number | null
			/** 违法事实 */
			illegalAction: string
			/** 没收违法所得金额（万元） */
			illegalIncome: string | null
			/** 违法行为 */
			illegalType: string
			/** 处罚内容或者处罚结果 */
			penaltyContent: string
			/** 处罚决定日期 */
			penaltyDate: string
			/** 处罚信息来源 */
			penaltySource: string
			/** 处罚类型 */
			penaltyType: string
			/** 企业id */
			pid: string
			/** 企业名称 */
			entName: string
			/** 法定代表人 */
			legalPerson: string
		}>
	}
}

/** 行政许可核查 request parameters. */
export interface PermissionListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 行政许可核查 response. */
export interface PermissionListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 决定文书/许可编号 */
			permissionNo: string
			/** 决定文书/许可证名称 */
			permissionName: string
			/** 许可编号 */
			certNo: string
			/** 许可证书名称 */
			certName: string
			/** 许可决定日期 */
			certDate: string
			/** 许可类别 */
			certType: string
			/** 许可机关统一社会信用代码 */
			authPartyUncid: string
			/** 数据来源单位统一社会信用代码 */
			permissionSourceUncid: string
			/** 有效期自 */
			permissionDate: string
			/** 有效期至 */
			permissionEndDate: string
			/** 许可机关 */
			authParty: string
			/** 许可内容 */
			permissionContent: string
			/** 数据来源单位 */
			permissionSource: string
			/** 数据来源单位pid */
			permissionSourcePid: string
			/** 来源类型（1 工商 2 信用中国） */
			sourceType: number
		}>
	}
}

/** 人员股权冻结 request parameters. */
export interface PersonAssistListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员股权冻结 response. */
export interface PersonAssistListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 被执行人证照号码 */
			blicNo?: string
			/** 执行通知书文号 */
			executeNo: string
			/** 执行法院 */
			froAuth: string
			/** 冻结期限 */
			froDeadline: string
			/** 执行裁定书文号 */
			froDocNo: string
			/** 冻结期限自 */
			froFromDate: string
			/** 类型/状态 */
			froStateCn: string
			/** 冻结期限至 */
			froToDate: string
			/** 被执行人 */
			inv: number | string
			/** 公示日期 */
			publicDate: number | string
			/** 被执行人持有股权、其它投资权益的数额 */
			froAm: number
		}>
	}
}

/** 人员控制企业信息 request parameters. */
export interface PersonControllerEntListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员控制企业信息 response. */
export interface PersonControllerEntListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 城市code */
			cityCode: string
			/** 区域code */
			districtCode: string
			/** 图片路径 */
			imgUrl?: string
			/** 企业名称 */
			entName: string
			/** 企业状态(1 存续 2 吊销 3 注销 4 迁出 5 停业歇业 6 其他) */
			entStatus: number | string
			/** 企业状态描述 */
			entStatusDesc: string
			/** 成立日期 */
			esTime: string
			/** 一级行业code */
			industryFirstCode: string
			/** 法定代表人 */
			legalPerson: string
			/** 法定代表人id */
			legalPersonId: string
			/** 企业pid */
			pid: string
			/** 省份code */
			provinceCode: string
			/** 注册资本 */
			regCapAmt: string
			/** 注册资本单位 */
			regCapCur: string
			/** 投资比例 */
			shareRatio: number
			/** 标签列表 */
			tagList: Array<{
				/** id */
				id: string
				/** tag名称 */
				name: string
				/** 父节点定位名称 */
				parentPosition: string
				/** 定位点 */
				position: string
				/** 1.大股东 2.上市 3.风险 20.实际控制人 21.最终受益人 */
				type: number
			}>
		}>
	}
}

/** 人员法院公告 request parameters. */
export interface PersonDeliverAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员法院公告 response. */
export interface PersonDeliverAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案由 */
			brief: string
			/** 公告内容 */
			content: string
			/** 法院 */
			court: string
			/** 刊登日期 */
			issueDate: string
			/** 刊登版面 */
			issueLayout?: string
			/** 案号 */
			referenceNo: string
			/** 公告类型 */
			title: string
			/** 当事人信息 */
			partyList: Array<{
				/** 案件身份类型名称 */
				partyTypeName: string
				/** 当事人信息列表 */
				nameKeyBOList: Array<{
					/** 企业名称 */
					name: string
					/** 案件身份类型Code */
					type: string | number
				}>
			}>
		}>
	}
}

/** 人员历史失信被执行人 request parameters. */
export interface PersonDishonestHistoryListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员历史失信被执行人 response. */
export interface PersonDishonestHistoryListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 涉案金额 */
			amount: number
			/** 失信行为的具体情形 */
			enfSituation: string
			/** 被执行人的履行情况 */
			enfStatus: string
			/** 执行依据文号 */
			enfNo: string
			/** 做出执行依据的单位 */
			authParty: string
			/** 生效法律文书确定的义务 */
			enfDuty: string
			/** 法院 */
			court: string
			/** 立案日期 */
			filingDate: string
			/** 发布日期 */
			pubDate: string
			/** 证件号/组织机构代码 */
			cardNo: string
			/** 失信被执行人 */
			enfName: string
		}>
	}
}

/** 人员失信被执行人 request parameters. */
export interface PersonDishonestListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员失信被执行人 response. */
export interface PersonDishonestListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 涉案金额 */
			amount: number
			/** 失信行为的具体情形 */
			enfSituation: string
			/** 被执行人的履行情况 */
			enfStatus: string
			/** 执行依据文号 */
			enfNo: string
			/** 做出执行依据的单位 */
			authParty: string
			/** 生效法律文书确定的义务 */
			enfDuty: string
			/** 法院 */
			court: string
			/** 立案日期 */
			filingDate: string
			/** 发布日期 */
			pubDate: string
			/** 证件号/组织机构代码 */
			cardNo: string
			/** 失信被执行人 */
			enfName: string
		}>
	}
}

/** 人员历史终本案件 request parameters. */
export interface PersonEndExecutionHistoryListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员历史终本案件 response. */
export interface PersonEndExecutionHistoryListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 被执行人 */
			enfName: string
			/** 执行标的 */
			enfObject: string | number
			/** 立案日期 */
			filingDate: string
			/** 终本日期 */
			endDate: string
			/** 法院 */
			court: string
			/** 证件号/组织机构代码 */
			cardNo: string
			/** 未履行的金额 */
			unperformPart: string | number
		}>
	}
}

/** 人员终本案件 request parameters. */
export interface PersonEndExecutionListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员终本案件 response. */
export interface PersonEndExecutionListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 被执行人 */
			enfName: string
			/** 执行标的 */
			enfObject: string | number
			/** 立案日期 */
			filingDate: string
			/** 终本日期 */
			endDate: string
			/** 法院 */
			court: string
			/** 证件号/组织机构代码 */
			cardNo: string
			/** 未履行的金额 */
			unperformPart: string | number
		}>
	}
}

/** 人员被执行人 request parameters. */
export interface PersonEnforceInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员被执行人 response. */
export interface PersonEnforceInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 被执行人 */
			enfName: string
			/** 执行标的（元） */
			enfObject: number
			/** 立案日期 */
			filingDate: string
			/** 法院 */
			court: string
			/** 证件号/组织机构代码 */
			cardNo: string
		}>
	}
}

/** 人员最终受益人信息 request parameters. */
export interface PersonFinalBenefitListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 类型(1作为受益所有人2作为受益自然人) */
	type: number
	/** 当前页默认第一页 */
	page?: string
	/** 每页显示条数默认10条 */
	pageSize?: string
}

/** 人员最终受益人信息 response. */
export interface PersonFinalBenefitListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 受益类型 */
			benefitType: string
			/** 任职类型 */
			officeType: string
			/** 判断理由 */
			judgeReason: string
			/** 企业名称 */
			entName: string
			/** 企业状态(1 存续 2 吊销 3 注销 4 迁出 5 停业歇业 6 其他) */
			entStatus: number | string
			/** 企业状态描述 */
			entStatusDesc: string
			/** 成立日期 */
			esTime: string
			/** 一级行业code */
			industryFirstCode: string
			/** 法定代表人 */
			legalPerson: string
			/** 法定代表人id */
			legalPersonId: string
			/** 企业pid */
			pid: string
			/** 省份code */
			provinceCode: string
			/** 注册资本 */
			regCapAmt: string
			/** 注册资本单位 */
			regCapCur: string
			/** 最终受益股份 */
			shareRatio: string
			/** 标签列表 */
			tagList: Array<{
				/** id */
				id: string
				/** tag名称 */
				name: string
				/** 父节点定位名称 */
				parentPosition: string
				/** 定位点 */
				position: string
				/** 1.大股东 2.上市 3.风险 20.实际控制人 21.最终受益人 */
				type: number
			}>
		}>
	}
}

/** 所属集团 request parameters. */
export interface PersonGroupListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 所属集团 response. */
export interface PersonGroupListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 集团id */
			groupId: string
			/** 集团名称 */
			groupName: string
			/** 主企业名称 */
			groupEntName: string
			/** 集团成员数量 */
			groupPersonCount: number
			/** 集团类别：1：企业族群，2：集团 */
			groupType: string | number
			/** 集团成员角色 */
			groupOfRole: string
			/** 角色列表 */
			roleBos: Array<{
				/** 族群id */
				groupId: string
				/** 人员id */
				personId: string
				/** 人员角色类型(1：实际控制人，2：法人，3：核心人员，4：主要人员) */
				personRole: number | string
				/** 统计数量 */
				statNum: number
				/** 角色名称 */
				roleName: string
			}>
			/** 疑似实际控制人 */
			actualControllerPerson: Array<{
				/** 实际控制人名称 */
				entName: string
				/** 实际控制人pid */
				pid: string
				/** 实际控制人类型:1 企业 2 人员 3 未知 */
				type: number
			}>
		}>
	}
}

/** 人员立案信息 request parameters. */
export interface PersonInitiateAnnoListVoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员立案信息 response. */
export interface PersonInitiateAnnoListVoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 案由 */
			brief: string | null
			/** 案件类型名称 */
			caseTypeName: string
			/** 法院 */
			court: number | string
			/** 立案日期 */
			filingDate: string
			/** 承办部门 */
			contractors: string
			/** 承办法官 */
			judge: string | null
			/** 法官助理 */
			assistant: string | null
			/** 案件状态 */
			caseStatus: string
			/** 开庭日期 */
			courtDate: string
			/** 结案日期 */
			endDate: string
			/** 当事人信息 */
			partyList: Array<{
				/** 企业类型 */
				partyTypeName: string
				/** 当事人信息 */
				nameKeyBOList: Array<{
					/** 企业名称 */
					name: string
					/** 关联对象 */
					person: string | null
					/** 类型 */
					type: number
				}>
			}>
		}>
	}
}

/** 人员历史董监高信息 request parameters. */
export interface PersonInvestInfoHistoryListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员历史董监高信息 response. */
export interface PersonInvestInfoHistoryListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 人员id */
			personId: string
			/** 人员名称 */
			personName: string
			/** 企业pid */
			pid: number | string
			/** 企业名称 */
			entName: string
			/** 图片路径 */
			imgUrl: number | string
			/** 行业一级code */
			industryFirstCode: string
			/** 注册资本 */
			regCapAmt: string | number
			/** 注册资本单位 */
			regCapCur: string
			/** 省份code */
			provinceCode: string
			/** 企业状态 */
			entStatus: string
			/** 企业状态描述 */
			entStatusDesc?: string
			/** 任职开始时间 */
			startTime?: string
			/** 任职结束时间 */
			endTime: string
			/** 职位 */
			position: string
			/** 持股比例 */
			shareRatio: number
			/** 是否是主要人员 1 是 2 否 */
			isRegPerson: number
			/** 是否是股东 1 是 2 否 */
			isRegShareholder: number
			/** 是否是法人(1 是 2 否) */
			isFr: number
			/** 成立时间 */
			esTime: number | string
			/** 标签信息集合 */
			tagList?: Array<{
				/** id */
				id?: number
				/** tag名称 */
				name?: string
				/** 父节点定位名称 */
				parentPosition?: string
				/** 定位点 */
				position?: string
				/** 1.大股东 2.上市 3.风险 20.实际控制人 21.最终受益人 */
				type?: number
			}>
		}>
	}
}

/** 人员董监高信息 request parameters. */
export interface PersonInvestInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员董监高信息 response. */
export interface PersonInvestInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 人员id */
			personId: string
			/** 人员名称 */
			personName: string
			/** 企业pid */
			pid: number | string
			/** 企业名称 */
			entName: string
			/** 图片路径 */
			imgUrl: number | string
			/** 行业一级code */
			industryFirstCode: string
			/** 注册资本 */
			regCapAmt: string | number
			/** 注册资本单位 */
			regCapCur: string
			/** 省份code */
			provinceCode: string
			/** 企业状态 */
			entStatus: string
			/** 企业状态描述 */
			entStatusDesc?: string
			/** 任职开始时间 */
			startTime?: string
			/** 任职结束时间 */
			endTime: string
			/** 职位 */
			position: string
			/** 持股比例 */
			shareRatio: number
			/** 是否是主要人员 1 是 2 否 */
			isRegPerson: number
			/** 是否是股东 1 是 2 否 */
			isRegShareholder: number
			/** 是否是法人(1 是 2 否) */
			isFr: number
			/** 成立时间 */
			esTime: number | string
			/** 标签信息集合 */
			tagList?: Array<{
				/** id */
				id?: number
				/** tag名称 */
				name?: string
				/** 父节点定位名称 */
				parentPosition?: string
				/** 定位点 */
				position?: string
				/** 1.大股东 2.上市 3.风险 20.实际控制人 21.最终受益人 */
				type?: number
			}>
		}>
	}
}

/** 人员限制高消费 request parameters. */
export interface PersonLimitHighListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员限制高消费 response. */
export interface PersonLimitHighListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 关联对象 */
			person: string
			/** 涉案金额 */
			enfObject: string | number
			/** 立案日期 */
			filingDate: string
			/** 发布时间 */
			pubDate: string
			/** 法院 */
			court: string
			/** 内容正文 */
			content: string
			/** 申请人信息 */
			sqrInfo: Array<{
				/** 企业名称 */
				name?: string
				/** 关联对象 */
				person?: string
				/** 类型 */
				type?: string
			}>
			/** 限消令对象信息 */
			nameKeyInfo: Array<{
				/** 企业名称 */
				name?: string
				/** 关联对象 */
				person?: string
				/** 类型 */
				type?: string
			}>
		}>
	}
}

/** 人员送达公告 request parameters. */
export interface PersonNoticeDeliverAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员送达公告 response. */
export interface PersonNoticeDeliverAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 案由 */
			brief: string
			/** 发表日期 */
			issueDate: string
			/** 公告人、法院 */
			court: string
			/** 原文 */
			content: string
			/** 当事人信息 */
			partyList: Array<{
				/** 企业类型 */
				partyTypeName: string
				/** 当事人信息 */
				nameKeyBOList: Array<{
					/** 企业名称 */
					name: string
					/** 关联对象 */
					person?: string
					/** 类型 */
					type: string | number
				}>
			}>
		}>
	}
}

/** 人员开庭公告 request parameters. */
export interface PersonOpenAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员开庭公告 response. */
export interface PersonOpenAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案号 */
			referenceNo: string
			/** 案由 */
			brief: string
			/** 法官、审判长/主审人 */
			judge: string
			/** 公告内容 */
			content: string
			/** 法院 */
			court: string
			/** 开庭日期 */
			courtDate: string
			/** 排期日期 */
			scheduleDate?: string
			/** 法庭 */
			tribunal: string
			/** 承办部门 */
			undertakeDepartment?: string
			/** 当事人信息 */
			partyList: Array<{
				/** 案件身份类型名称 */
				partyTypeName: string
				/** 当事人信息列表 */
				nameKeyBOList: Array<{
					/** 企业pid */
					pid?: string
					/** 企业名称 */
					name: string
					/** 案件身份类型Code */
					type: string | number
					/** 公司是否存在 0其他 1企业 2人员 */
					isCompany?: string
				}>
			}>
		}>
	}
}

/** 人员裁判文书 request parameters. */
export interface PersonRefereeDocListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员裁判文书 response. */
export interface PersonRefereeDocListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 案件名称 */
			caseName: string
			/** 案号 */
			referenceNo: string
			/** 法院 */
			court: string
			/** 判决结果 */
			judgeResult: string
			/** 文书类型名称 */
			refereeDocTypeName: string
			/** 法律事实 */
			refereeDocResult: string
			/** 裁判日期 */
			refereeDate: string
			/** 发布日期 */
			pubDate: string
			/** 当事人信息 */
			partyList: Array<{
				/** 企业类型 */
				partyTypeName: string
				/** 当事人信息 */
				nameKeyBOList: Array<{
					/** 企业名称 */
					name: string
					/** 关联对象 */
					person?: string
					/** 类型 */
					type: string | number
				}>
			}>
		}>
	}
}

/** 人员股权出质核查 request parameters. */
export interface PersonStockRiskInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 人员全称 */
	personName: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 人员股权出质核查 response. */
export interface PersonStockRiskInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 登记编号 */
			equityNo: string
			/** 登记日期 */
			equPleDate: string
			/** 出质股权数额（金额） */
			impAm: string | number
			/** 质权人 */
			impOrg: string
			/** 质权人证件号码 */
			impOrgBlicNo: string
			/** 出质人 */
			pledgor: string
			/** 状态名称 */
			statusName: string
			/** 出质人证照/证件号码 */
			pledBlicNo: string
		}>
	}
}

/** 双随机抽查 request parameters. */
export interface RandomCheckInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 双随机抽查 response. */
export interface RandomCheckInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 主键id */
			id: string
			/** 任务编号 */
			raninsTaskId: string
			/** 任务名称 */
			raninsTaskName: string
			/** 抽查机关 */
			insAuth: string
			/** 计划编号 */
			raninsPlanId: string
			/** 计划名称 */
			raninsPlaneName: string
			/** 抽查类型 */
			raninsTypeName: string
			/** 完成日期 */
			insDate: string
		}>
	}
}

/** 招聘信息 request parameters. */
export interface RecruitInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
}

/** 招聘信息 response. */
export interface RecruitInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 发布日期 */
			releaseDate: number | string
			/** 岗位名称 */
			jobName: string
			/** 月薪 */
			salary: string
			/** 学历 */
			education: string
			/** 经验 */
			experience: string
			/** 招聘城市 */
			jobCity: string
			/** 企业名称 */
			entName: string
			/** 岗位职责 */
			jobDescList: Array<unknown>
		}>
	}
}

/** 风险排查 request parameters. */
export interface RiskCheckingParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
}

/** 风险排查 response. */
export interface RiskCheckingResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 企业唯一标识 */
		pid: number | string
		/** 企业名称 */
		entName: number | string
		/** 排查风险总数 */
		riskAllNum: number | string
		/** 失信被执行人 */
		breakEnforcement: number | string
		/** 限高消费 */
		consumption: number | string
		/** 被执行人 */
		enforcement: number | string
		/** 终本案件 */
		finalAase: number | string
		/** 股权冻结 */
		shareBlocking: number | string
		/** 开庭公告 */
		holdCourt: number | string
		/** 立案信息 */
		filingInformation: number | string
		/** 司法案件 */
		judicialcase: number | string
		/** 严重违法 */
		seriousViolation: number | string
		/** 欠税公告 */
		notice: number | string
		/** 经营异常 */
		operatingAnomaly: number | string
		/** 税收违法 */
		taxViolation: number | string
		/** 行政处罚 */
		administrative: number | string
		/** 简易注销 */
		simpleCancellation: number | string
		/** 动产抵押 */
		chattelMortgage: number | string
		/** 股权出质 */
		equityPledge: number | string
		/** 知识产权出质 */
		intellectualProperty: number | string
	}
}

/** 合同违约指数 request parameters. */
export interface RiskNoPromiseStatisticsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 合同违约指数 response. */
export interface RiskNoPromiseStatisticsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 违约次数 */
			promiseCount: string
			/** 合同违约的关联方 */
			promiseReleCount: string
			/** 涉案金额(万元) */
			involvedAmount: string
		}>
	}
}

/** 招投标详情 request parameters. */
export interface SelectBiddingDetailParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 招投标详情 response. */
export interface SelectBiddingDetailResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 详情 */
			detailBos?: Array<{
				/** 主键id */
				id?: string
				/** 项目名称 */
				projectId?: string
				/** 项目编号 */
				projectNo?: string
			}>
			/** 招投标类型 */
			biddingType: Array<{
				/** 招标一级类型 */
				parentType: string
				/** 一级类型名称 */
				parentName: string | null
				/** 招标二级类型 */
				subType: string
				/** 二级类型名称 */
				subTypeName: string | null
				/** 省份区域 */
				provinceName: string | null
				/** 省份code */
				provinceCode: string
				/** 所属行业 */
				industry: string
			}>
			/** 主要人员担任职务 */
			industry?: {
				[key: string]: unknown
			}
			/** 招采单位集合 */
			recruitUnitList: Array<{
				/** pid */
				pid: string
				/** 企业名称 */
				entName: string
				/** 持股比例 */
				insto: string | null
			}>
			/** 代理单位 */
			proxyUnit: Array<{
				/** pid */
				pid: string
				/** 企业名称 */
				entName: string
				/** 持股比例 */
				insto: string | null
			}>
			/** 中标单位 */
			biddingWinningUnit: Array<{
				/** pid */
				pid?: string
				/** 企业名称 */
				entName?: string
				/** 持股比例 */
				insto?: string
				/** 中标金额 */
				biddingAmount?: string
				/** 发布时间 */
				pubDate?: string
				/** 公告原文 */
				content?: string
				/** 来源路径 */
				url?: string
				/** 项目编号 */
				projectNo?: string
				/** 招采单位 */
				recruitUnit?: string
				/** 招采单位pid */
				recruitUnitPid?: string
			}>
		}>
	}
}

/** 主要人员信息 request parameters. */
export interface SelectKeyPersonEnterpriseParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 主要人员信息 response. */
export interface SelectKeyPersonEnterpriseResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 标识 id */
			id: string
			/** 主要人员姓名 */
			name: string
			/** 主要人员担任职务 */
			positionCn: string
		}>
	}
}

/** 股东关联企业 request parameters. */
export interface SelectRelatedEnterpriseParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 股东名称 */
	invName: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 股东关联企业 response. */
export interface SelectRelatedEnterpriseResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 企业名称 */
			entName: string
			/** 企业状态：1-存续 2-吊销 3-注销 4-迁出 8-歇业 9-其他 */
			entStatus: number | string
			/** 法定代表人 */
			legalPerson: string
			/** 注册资本 */
			regCapAmt: string
			/** 注册资本单位（如：万人民币） */
			regCapCur: string
			/** 省份代码 */
			provinceCode: string
			/** 持股比例（如：60.00%） */
			shareRatio: string
			/** 职位（如：执行董事、总经理等） */
			position: string
		}>
	}
}

/** 股东信息 request parameters. */
export interface ShareholderInfoParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 股东信息 response. */
export interface ShareholderInfoResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 股东 id */
			invPid: string
			/** 疑似实际控制人 */
			invName: string
			/** 持股比例 */
			benefitShare: string
			/** 一级行业 */
			industryFirstCode: string
			/** logo图片url */
			imgUrl: string | null
			/** 股东 */
			shareholder: Array<{
				/** id */
				id?: string
				/** 名称 */
				name?: string
				/** 节点类型(999:企业,998:人员) */
				nodeType?: string
				/** 详情数量 */
				detailCount?: number
				/** 标签 */
				tags?: Array<{
					/** id */
					id?: string
					/** tag名称 */
					name?: string
					/** 父节点定位名称 */
					parentPosition?: string
					/** 定位点 */
					position?: string
					/** 浮动标题 */
					floatTitle?: string
				}>
				/** 下级股东 */
				children?: Array<{
					/** pid */
					pid?: string
					/** 名称 */
					name?: string
					/** 百分比 */
					percent?: string
					/** 持股数量 */
					amount?: string
					/** 节点类型(999:企业,998:人员) */
					nodeType?: string
					/** 详情数量 */
					detailCount?: number
					/** 标签 */
					tags?: Array<{
						/** id */
						id?: string
						/** tag名称 */
						name?: string
						/** 父节点定位名称 */
						parentPosition?: string
						/** 定位点 */
						position?: string
						/** 浮动标题 */
						floatTitle?: string
					}>
				}>
			}>
		}>
	}
}

/** 简易注销核查 request parameters. */
export interface SimpleCancelListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 简易注销核查 response. */
export interface SimpleCancelListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业名称 */
			entName: string
			/** 公告期（起始时间） */
			noticeFromDate: string
			/** 公告期（结束时间） */
			noticeToDate: string
			/** 企业唯一标识 */
			pid: string
			/** 登记机关 */
			regOrgDesc: string
			/** 统一社会信用代码 */
			uncid: string
		}>
	}
}

/** 抽查检查 request parameters. */
export interface SpotCheckListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
	/** 结果是否正常（1 正常 0 不正常 -1 为空或者没有判断出来） */
	result: string
}

/** 抽查检查 response. */
export interface SpotCheckListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 检查实施机关 */
			insAuthCn: number | string
			/** 类型 */
			insTypeCn: string
			/** 日期 */
			insDate: string
			/** 结果 */
			insResCn: string
			/** 结果是否正常（1 正常 0 不正常 -1 为空或者没有判断出来） */
			result: string | number
		}>
	}
}

/** 标准信息查询 request parameters. */
export interface StdInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 标准信息查询 response. */
export interface StdInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 废止日期 */
			disuseDate: string
			/** 起草人 */
			draftPeople: string
			/** 实施日期 */
			enforceDate: string
			/** 团体名称 */
			groupName: string
			/** 是否包含专利信息 */
			patent: string | number
			/** 发布日期 */
			publishDate: string
			/** 标准id */
			standardId: string
			/** 中国标准分类号 */
			stdClassChn: string
			/** 国民经济分类 */
			stdClassEco: string
			/** 国际标准分类号 */
			stdClassInt: string
			/** 标准简介 */
			stdDesc: string
			/** 标准类型 1:国家标准 2:行业标准 3:地方标准 4:团体标准 5:企业标准 */
			stdLevel: string | number
			/** 标准中文名称 */
			stdNameChn: string
			/** 标准号 */
			stdNo: string
			/** 适用范围 */
			stdScope: string | null
			/** 标准状态 */
			stdState: string
			/** 标准状态 */
			flowList: Array<Record<string, unknown>>
			/** 标准状态 */
			nameKeyBOList: Array<Record<string, unknown>>
		}>
	}
}

/** 知识产权 request parameters. */
export interface SummariesParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 查询类型，可选：trademark(商标), patent(专利), intlPatent(国际专利), software(软著), works(作品著作权), icp(备案网站), pledge(知产出质) */
	type: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 知识产权 response. */
export interface SummariesResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** trademark-商标列表数据 / patent-专利列表数据 / intlPatent-国际专利列表数据 / software-软件著作权列表数据 / works-作品著作权列表数据 / icp-备案网站列表数据 / pledge-知识产权出质列表列表数据 */
			list?:
				| Array<{
						/** 代理人名称 */
						agentName?: string
						/** 申请人地址 */
						applicantAddr?: string
						/** 申请人地址-英文 */
						applicantAddrEn?: string
						/** 申请人名称-英文 */
						applicantEn?: string
						/** 申请人名称 */
						applicantName?: string
						/** 申请日期 */
						applyDate?: string
						/** 申请/注册号 */
						applyNo?: string
						/** 初审公告期号 */
						examPubNo?: string
						/** 国际注册日期 */
						intlRegDate?: string
						/** 商品/服务列表 */
						inventory?: string
						/** 是否公用商标1:是0:否 */
						isCoowner?: string
						/** 是否公用商标1:是0:否 */
						isCoownerName?: string
						/** 商标类别 */
						markClassNo?: string
						/** 商标类别 */
						markClassNoName?: string
						/** 商标形式 */
						markForm?: string
						/** 商标形式 */
						markFormName?: string
						/** 商标图片ossId */
						markImgOss?: string
						/** 商标图片 */
						markImgUrl?: string
						/** 商标名称 */
						markName?: string
						/** 商标类型 */
						markTypeNo?: string
						/** 商标类型 */
						markTypeNoName?: string
						/** 企业唯一代码 */
						pid?: string
						/** 优先权日期 */
						priorityDate?: string
						/** 注册公告期号 */
						registerNo?: string
						/** 后期指定日期 */
						specifyDate?: string
						/** 商标申请状态 */
						status?: string
						/** 商标状态详情 */
						statusDesc?: string
						/** 专用权期限结束日期 */
						useRightEndDate?: string
						/** 专用权期限开始日期 */
						useRightStartDate?: string
						/** 商品/服务项目 */
						goodsList?: Array<unknown>
						/** 商标流程状态 */
						inTmFlowList?: Array<unknown>
						/** 商标公告 */
						annoList?: Array<unknown>
						/** 申请进度 */
						flowList?: Array<unknown>
						/** 商标转让 */
						transferList?: Array<unknown>
						/** 该申请人申请的同名商标 */
						alikeNameList?: Array<unknown>
				  }>
				| Array<{
						/** 专利权人 */
						applicant?: string
						/** 申请日期 */
						applyDate?: string
						/** 申请号 */
						applyNo?: string
						/** 授权公告/申请公布日期 */
						applyPubDate?: string
						/** 授权公告号 */
						applyPubNo?: string
						/** 申请年份 */
						applyYear?: string
						/** 专利附图 */
						imageUrl?: string
						/** 专利附图列表 */
						imgUrlList?: string
						/** 专利名称 */
						patentName?: string
						/** 专利类型 */
						patentType?: string
						/** 优先权 */
						priority?: string
						/** 主权项 */
						sovereignty?: string
						/** 专利状态码 */
						statusCode?: string
						/** 专利状态 */
						statusName?: string
						/** 受理局 */
						acceptBureau?: string
						/** 申请人地址 */
						address?: string
						/** 申请人邮箱 */
						applyPostalCode?: string
						/** 代理机构 */
						agency?: string
						/** 代理人 */
						agencyPerson?: string
						/** 发明人 */
						inventor?: string
						/** 摘要 */
						brief?: string
						/** pid */
						pid?: string
						/** 申请(专利权)人 */
						nameInfoList?: Array<unknown>
						/** 法律状态 */
						lawStatusList?: Array<unknown>
						/** 申请进度 */
						flowList?: Array<unknown>
				  }>
				| Array<{
						/** 著作权人名称 */
						authorName?: string
						/** 软件全称 */
						fullName?: string
						/** 首次发表日期 */
						pubDate?: string
						/** 登记日期 */
						regDate?: string
						/** 登记号 */
						regNo?: string
						/** 软件简称 */
						simpleName?: string
						/** 软件版本号 */
						version?: string
				  }>
				| Array<{
						/** 创作完成日期 */
						finishDate?: string
						/** 首次发表日期 */
						firstPublishDate?: string
						/** 登记日期 */
						regDate?: string
						/** 登记号 */
						regNo?: string
						/** 作品名称 */
						worksName?: string
						/** 作品类别名称 */
						worksType?: string
				  }>
				| Array<{
						/** 审核时间 */
						checkDate?: string
						/** 首次发表日期 */
						record?: string
						/** 备案编号 */
						regDate?: string
						/** 备案号是否失效0:否1:是 */
						recordExpired?: string
						/** 备案号是否失效 */
						recordExpiredName?: string
						/** 备案号/许可证号 */
						recordId?: string
						/** 域名 */
						siteDomain?: string
						/** 网站首页地址 */
						siteHome?: string
						/** 网站名称 */
						siteName?: string
				  }>
				| Array<{
						/** 质权人名称 */
						impOrg?: string
						/** 种类 */
						kind?: string
						/** 出质人名称 */
						pledgor?: string
						/** 质权登记期限（开始时间） */
						pleRegPerFrom?: string
						/** 质权登记期限（结束时间） */
						pleRegPerTo?: string
						/** 公示日期 */
						publicDate?: string
						/** 名称 */
						tmName?: string
						/** 知识产权登记证号 */
						tmRegNo?: string
				  }>
		}>
	}
}

/** 供应商查询 request parameters. */
export interface SupplychainListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
	/** 年份 */
	year?: number
}

/** 供应商查询 response. */
export interface SupplychainListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 供应商 */
			cooperateEntPid: string
			/** 供应商 */
			cooperateEntName: string
			/** 采购占比 */
			percentage: string | null
			/** 采购金额 */
			tradeAmount: string
			/** 报告期/公开期 */
			publishDate: string
			/** 数据来源 */
			linkType: string
			/** 关联关系 */
			affiliated: string | null
			/** 关联事件id */
			relevantId: string
			/** 全部采购数据的数量 */
			allDataCount: string | number
		}>
	}
}

/** 疑似同电话企业 request parameters. */
export interface SuspectRelListParams {
	/** 电话号码 */
	phone: string
	/** 当前页默认第一页 */
	page?: number
	/** 每页显示条数默认10条 */
	pageSize?: number
}

/** 疑似同电话企业 response. */
export interface SuspectRelListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业ID */
			pid: string
			/** 企业名称 */
			entName: string
			/** 法定代表人 */
			legalPerson: string
			/** 成立日期 */
			esDateDesc: string
			/** 注册资本 */
			regCap: string
			/** 注册资本单位 */
			regCapCur: string
			/** 登记状态 */
			entStatus: string
		}>
	}
}

/** 欠税公告核查 request parameters. */
export interface TaxArrearAnnoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 欠税公告核查 response. */
export interface TaxArrearAnnoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业唯一标识 */
			pid: string
			/** 经营地址 */
			address: string
			/** 税务管理机关 */
			authOrg: string
			/** 企业名称 */
			entName: string
			/** 当期新欠金额 */
			currentAmout: number
			/** 法人名称 */
			legalPerson: string
			/** 欠税公告日期 */
			pubDate: string
			/** 欠税税种 */
			taxType: string
			/** 欠税金额 */
			totalAmount: number
			/** 社会统一信用代码 */
			unicd: string
			/** 纳税人类型 */
			qualification: number | string
		}>
	}
}

/** 税收违法核查 request parameters. */
export interface TaxIllegalListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 税收违法核查 response. */
export interface TaxIllegalListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 违法类型 */
			caseKind: string
			/** 公司名 */
			entName: string
			/** 违法事实 */
			mainCase: string
			/** 企业唯一标识 */
			pid: string
			/** 惩罚内容 */
			punishment: string
			/** 所属税务机关 */
			authority: string | null
			/** 社会统一信用代码 */
			uncid: string
			/** 组织机构代码 */
			orgCode: string
			/** 注册地址 */
			dom: string
		}>
	}
}

/** 纳税人资质 request parameters. */
export interface TaxPayerTypeListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 纳税人资质 response. */
export interface TaxPayerTypeListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 纳税人识别号 */
			unicd: string
			/** 纳税人资格类型 */
			qualification: string
			/** 主管税务机关 */
			authority: string | null
			/** 有效期起 */
			validFrom: string
			/** 有效期止 */
			validTo: string
		}>
	}
}

/** 科技型企业标签 request parameters. */
export interface TechnologyEnterpriseTagsParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 科技型企业标签 response. */
export interface TechnologyEnterpriseTagsResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** id */
			id: string | null
			/** tag名称 */
			name: string
			/** 父节点定位名称 */
			parentPosition: string | null
			/** 定位点 */
			position: string | null
			/** 浮动标题 */
			floatTitle: string
		}>
	}
}

/** 电信许可 request parameters. */
export interface TelecomCertInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: string
	/** 每页显示条数 默认10条 */
	pageSize?: string
	/** 许可证号 */
	certNo: string
}

/** 电信许可 response. */
export interface TelecomCertInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 基本信息 */
			baseInfoBo: Array<{
				/** pid */
				pid?: string
				/** 公司名称 */
				entName?: string
				/** 许可证号 */
				certNo?: string
				/** 业务种类 / 覆盖范围 */
				opCategory?: string
				/** 有效状态 */
				validStatus?: string
				/** 有效状态(0 无效 1 有效) */
				validStatusType?: number
				/** 业务覆盖范围 */
				certScopeBos?: Array<{
					/** 业务种类 / 覆盖范围 */
					opCategory?: string
					/** 有效状态 */
					validStatus?: string
					/** 有效状态(0 无效 1 有效) */
					validStatusType?: string
				}>
			}>
			/** 最新年报公示 */
			latestReportBo: Array<{
				/** 公司名称 */
				endName?: string
				/** pid */
				pid?: string
				/** 统一社会信用代码 */
				uncid?: string
				/** 法定代表人 */
				legalPerson?: string
				/** 许可证编号 */
				permitLicenseNo?: string
				/** 注册属地 */
				registerArea?: string
				/** 注册地址 */
				dom?: string
				/** 注册资本 */
				regCap?: string
				/** 许可证业务种类 */
				opCategory?: string
				/** 企业性质 */
				entTypeDesc?: string
				/** 贷券代码 */
				bondCode?: string
				/** 联系电话 */
				contactPhone?: string
				/** 上市状态 */
				inMarketStatus?: string
			}>
		}>
	}
}

/** 商标信息详情 request parameters. */
export interface TmInfoListParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 商标信息详情 response. */
export interface TmInfoListResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码200表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 代理人名称 */
			agentName: string
			/** 申请人地址 */
			applicantAddr: string
			/** 申请人地址-英文 */
			applicantAddrEn: string
			/** 申请人名称-英文 */
			applicantEn: string
			/** 申请人名称 */
			applicantName: string
			/** 申请日期 */
			applyDate: string
			/** 申请/注册号 */
			applyNo: string
			/** 初审公告期号 */
			examPubNo: string
			/** 国际注册日期 */
			intlRegDate: string
			/** 商品/服务列表 */
			inventory: string
			/** 是否公用商标1:是0:否 */
			isCoowner: string | number
			/** 是否公用商标1:是0:否 */
			isCoownerName: string
			/** 商标类别 */
			markClassNo: string | number
			/** 商标类别 */
			markClassNoName: string
			/** 商标形式 */
			markForm: string | number
			/** 商标形式 */
			markFormName: string
			/** 商标图片ossId */
			markImgOss: string
			/** 商标图片 */
			markImgUrl: string
			/** 商标名称 */
			markName: string
			/** 商标类型 */
			markTypeNo: string | number
			/** 商标类型 */
			markTypeNoName: string
			/** 企业唯一代码 */
			pid: string
			/** 优先权日期 */
			priorityDate: string
			/** 注册公告期号 */
			registerNo: string
			/** 后期指定日期 */
			specifyDate: string
			/** 商标申请状态 */
			status: string | number
			/** 商标状态详情 */
			statusDesc: string
			/** 专用权期限结束日期 */
			useRightEndDate: string
			/** 专用权期限开始日期 */
			useRightStartDate: string
			/** 商品/服务项目 */
			goodsList: Array<Record<string, unknown>>
			/** 商标流程状态 */
			inTmFlowList: Array<Record<string, unknown>>
			/** 商标公告 */
			annoList: Array<Record<string, unknown>>
			/** 申请进度 */
			flowList: Array<Record<string, unknown>>
			/** 商标转让 */
			transferList: Array<unknown>
			/** 该申请人申请的同名商标 */
			alikeNameList: Array<Record<string, unknown>>
		}>
	}
}

/** 最终受益人 request parameters. */
export interface UltimateBeneficiaryParams {
	/** 企业全称/企业注册号/企业信用代码 */
	keyword: string
	/** 当前页 默认第一页 */
	page?: number
	/** 每页显示条数 默认10条 */
	pageSize?: number
}

/** 最终受益人 response. */
export interface UltimateBeneficiaryResponse {
	/** 消息内容 */
	message: string
	/** 验证加密值 */
	sign: string
	/** 返回结果编码 200 表示成功，其他值表示失败 */
	status: number
	/** 响应数据 */
	data: {
		/** 当前页数 */
		curPage: number
		/** 每页记录数 */
		pageSize: number
		/** 总记录数 */
		totalCount: number
		/** 总页数 */
		totalPage: number
		/** 列表数据 */
		list: Array<{
			/** 企业id */
			pid: string
			/** 股东 id */
			invPid: string
			/** 受益所有人名称 */
			invName: string
			/** 最终受益股份 */
			benefitShare: string
			/** 受益类型 */
			benefitTypeDesc: string
			/** 任职类型 */
			positionCn: string
			/** 判定理由 */
			reason: string
		}>
	}
}

export interface YiqichaApiTypeMap {
	actualController: {
		params: ActualControllerParams
		response: ActualControllerResponse
	}
	alterEnterprise: {
		params: AlterEnterpriseParams
		response: AlterEnterpriseResponse
	}
	annualAlterList: {
		params: AnnualAlterListParams
		response: AnnualAlterListResponse
	}
	annualAlterStockList: {
		params: AnnualAlterStockListParams
		response: AnnualAlterStockListResponse
	}
	annualAssetList: {
		params: AnnualAssetListParams
		response: AnnualAssetListResponse
	}
	annualBaseInfo: {
		params: AnnualBaseInfoParams
		response: AnnualBaseInfoResponse
	}
	annualGuaranteeList: {
		params: AnnualGuaranteeListParams
		response: AnnualGuaranteeListResponse
	}
	annualInvestmentList: {
		params: AnnualInvestmentListParams
		response: AnnualInvestmentListResponse
	}
	annualSocialInsuranceList: {
		params: AnnualSocialInsuranceListParams
		response: AnnualSocialInsuranceListResponse
	}
	annualSponsorList: {
		params: AnnualSponsorListParams
		response: AnnualSponsorListResponse
	}
	annualWebsiteList: {
		params: AnnualWebsiteListParams
		response: AnnualWebsiteListResponse
	}
	bankruptcyReorganizationList: {
		params: BankruptcyReorganizationListParams
		response: BankruptcyReorganizationListResponse
	}
	branchEnterprise: {
		params: BranchEnterpriseParams
		response: BranchEnterpriseResponse
	}
	certCustomsList: {
		params: CertCustomsListParams
		response: CertCustomsListResponse
	}
	certInfoList: {
		params: CertInfoListParams
		response: CertInfoListResponse
	}
	cleanRiskList: {
		params: CleanRiskListParams
		response: CleanRiskListResponse
	}
	commodityInfoList: {
		params: CommodityInfoListParams
		response: CommodityInfoListResponse
	}
	contractDetailEnterpriseList: {
		params: ContractDetailEnterpriseListParams
		response: ContractDetailEnterpriseListResponse
	}
	controlEnt: {
		params: ControlEntParams
		response: ControlEntResponse
	}
	cooperationList: {
		params: CooperationListParams
		response: CooperationListResponse
	}
	copyrightSoftwareList: {
		params: CopyrightSoftwareListParams
		response: CopyrightSoftwareListResponse
	}
	copyrightWorksList: {
		params: CopyrightWorksListParams
		response: CopyrightWorksListResponse
	}
	domainRecordList: {
		params: DomainRecordListParams
		response: DomainRecordListResponse
	}
	elementFourVerify: {
		params: ElementFourVerifyParams
		response: ElementFourVerifyResponse
	}
	elementThreeVerify: {
		params: ElementThreeVerifyParams
		response: ElementThreeVerifyResponse
	}
	elementTwoVerify: {
		params: ElementTwoVerifyParams
		response: ElementTwoVerifyResponse
	}
	entAbnormalList1031: {
		params: EntAbnormalList1031Params
		response: EntAbnormalList1031Response
	}
	entAbnormalList1045: {
		params: EntAbnormalList1045Params
		response: EntAbnormalList1045Response
	}
	entCopyrightList: {
		params: EntCopyrightListParams
		response: EntCopyrightListResponse
	}
	enterpriseInfoTags: {
		params: EnterpriseInfoTagsParams
		response: EnterpriseInfoTagsResponse
	}
	enterpriseTags: {
		params: EnterpriseTagsParams
		response: EnterpriseTagsResponse
	}
	entGeoInfoList: {
		params: EntGeoInfoListParams
		response: EntGeoInfoListResponse
	}
	entGraph: {
		params: EntGraphParams
		response: EntGraphResponse
	}
	entHistoryNameList: {
		params: EntHistoryNameListParams
		response: EntHistoryNameListResponse
	}
	entIllegalList: {
		params: EntIllegalListParams
		response: EntIllegalListResponse
	}
	entIndustryList: {
		params: EntIndustryListParams
		response: EntIndustryListResponse
	}
	entInfoList: {
		params: EntInfoListParams
		response: EntInfoListResponse
	}
	entLogoList: {
		params: EntLogoListParams
		response: EntLogoListResponse
	}
	entMortList: {
		params: EntMortListParams
		response: EntMortListResponse
	}
	entScaleList: {
		params: EntScaleListParams
		response: EntScaleListResponse
	}
	entThreeCodeList: {
		params: EntThreeCodeListParams
		response: EntThreeCodeListResponse
	}
	equityInvestment: {
		params: EquityInvestmentParams
		response: EquityInvestmentResponse
	}
	getBasicInfo: {
		params: GetBasicInfoParams
		response: GetBasicInfoResponse
	}
	getBillboardDetails: {
		params: GetBillboardDetailsParams
		response: GetBillboardDetailsResponse
	}
	getBuAppInfoDetails: {
		params: GetBuAppInfoDetailsParams
		response: GetBuAppInfoDetailsResponse
	}
	getBuAppletInfoList: {
		params: GetBuAppletInfoListParams
		response: GetBuAppletInfoListResponse
	}
	getEntAssistDetails: {
		params: GetEntAssistDetailsParams
		response: GetEntAssistDetailsResponse
	}
	getEnterprisePartners: {
		params: GetEnterprisePartnersParams
		response: GetEnterprisePartnersResponse
	}
	getEpEntIndbusList: {
		params: GetEpEntIndbusListParams
		response: GetEpEntIndbusListResponse
	}
	getHaveApplyPolicyList: {
		params: GetHaveApplyPolicyListParams
		response: GetHaveApplyPolicyListResponse
	}
	getInvestEnterprise: {
		params: GetInvestEnterpriseParams
		response: GetInvestEnterpriseResponse
	}
	getInWebDomainRecordList: {
		params: GetInWebDomainRecordListParams
		response: GetInWebDomainRecordListResponse
	}
	getNewEnterpriseInfo: {
		params: GetNewEnterpriseInfoParams
		response: GetNewEnterpriseInfoResponse
	}
	getOnlineShopList: {
		params: GetOnlineShopListParams
		response: GetOnlineShopListResponse
	}
	getPartners: {
		params: GetPartnersParams
		response: GetPartnersResponse
	}
	getPermissionDetail: {
		params: GetPermissionDetailParams
		response: GetPermissionDetailResponse
	}
	getPersonIntroInfo: {
		params: GetPersonIntroInfoParams
		response: GetPersonIntroInfoResponse
	}
	getPolicySubsidyStat: {
		params: GetPolicySubsidyStatParams
		response: GetPolicySubsidyStatResponse
	}
	getStockInfoList: {
		params: GetStockInfoListParams
		response: GetStockInfoListResponse
	}
	getWechatAccountInfoList: {
		params: GetWechatAccountInfoListParams
		response: GetWechatAccountInfoListResponse
	}
	getWeiboInfoList: {
		params: GetWeiboInfoListParams
		response: GetWeiboInfoListResponse
	}
	groupInfoList: {
		params: GroupInfoListParams
		response: GroupInfoListResponse
	}
	historyCompanyInfoList: {
		params: HistoryCompanyInfoListParams
		response: HistoryCompanyInfoListResponse
	}
	historyEntPenaltyList: {
		params: HistoryEntPenaltyListParams
		response: HistoryEntPenaltyListResponse
	}
	historyLegalPersonList: {
		params: HistoryLegalPersonListParams
		response: HistoryLegalPersonListResponse
	}
	historyPersonList: {
		params: HistoryPersonListParams
		response: HistoryPersonListResponse
	}
	historySeverityIllegalList: {
		params: HistorySeverityIllegalListParams
		response: HistorySeverityIllegalListResponse
	}
	historyShareholderList: {
		params: HistoryShareholderListParams
		response: HistoryShareholderListResponse
	}
	indirectEnt: {
		params: IndirectEntParams
		response: IndirectEntResponse
	}
	indirectHolderEntList: {
		params: IndirectHolderEntListParams
		response: IndirectHolderEntListResponse
	}
	internationPatentInfoList: {
		params: InternationPatentInfoListParams
		response: InternationPatentInfoListResponse
	}
	investInfoList: {
		params: InvestInfoListParams
		response: InvestInfoListResponse
	}
	investProjectInfoList: {
		params: InvestProjectInfoListParams
		response: InvestProjectInfoListResponse
	}
	lawAssistListVo: {
		params: LawAssistListVoParams
		response: LawAssistListVoResponse
	}
	lawAuctionAnnoList: {
		params: LawAuctionAnnoListParams
		response: LawAuctionAnnoListResponse
	}
	lawDeliverList: {
		params: LawDeliverListParams
		response: LawDeliverListResponse
	}
	lawDeliverNoticeList: {
		params: LawDeliverNoticeListParams
		response: LawDeliverNoticeListResponse
	}
	lawDishonestList: {
		params: LawDishonestListParams
		response: LawDishonestListResponse
	}
	lawEndExecutionList: {
		params: LawEndExecutionListParams
		response: LawEndExecutionListResponse
	}
	lawEnforceInfoList: {
		params: LawEnforceInfoListParams
		response: LawEnforceInfoListResponse
	}
	lawInitiateAnnoList: {
		params: LawInitiateAnnoListParams
		response: LawInitiateAnnoListResponse
	}
	lawOpenAnnoList: {
		params: LawOpenAnnoListParams
		response: LawOpenAnnoListResponse
	}
	lawRefereeDocList: {
		params: LawRefereeDocListParams
		response: LawRefereeDocListResponse
	}
	limitHighInfoList: {
		params: LimitHighInfoListParams
		response: LimitHighInfoListResponse
	}
	matchSearch: {
		params: MatchSearchParams
		response: MatchSearchResponse
	}
	miniEntList: {
		params: MiniEntListParams
		response: MiniEntListResponse
	}
	moreDetailsSearch: {
		params: MoreDetailsSearchParams
		response: MoreDetailsSearchResponse
	}
	newsInfo: {
		params: NewsInfoParams
		response: NewsInfoResponse
	}
	outInvestInfoList: {
		params: OutInvestInfoListParams
		response: OutInvestInfoListResponse
	}
	ownershipStructure: {
		params: OwnershipStructureParams
		response: OwnershipStructureResponse
	}
	patentInfoList: {
		params: PatentInfoListParams
		response: PatentInfoListResponse
	}
	penaltyListVo: {
		params: PenaltyListVoParams
		response: PenaltyListVoResponse
	}
	permissionList: {
		params: PermissionListParams
		response: PermissionListResponse
	}
	personAssistList: {
		params: PersonAssistListParams
		response: PersonAssistListResponse
	}
	personControllerEntList: {
		params: PersonControllerEntListParams
		response: PersonControllerEntListResponse
	}
	personDeliverAnnoList: {
		params: PersonDeliverAnnoListParams
		response: PersonDeliverAnnoListResponse
	}
	personDishonestHistoryList: {
		params: PersonDishonestHistoryListParams
		response: PersonDishonestHistoryListResponse
	}
	personDishonestList: {
		params: PersonDishonestListParams
		response: PersonDishonestListResponse
	}
	personEndExecutionHistoryList: {
		params: PersonEndExecutionHistoryListParams
		response: PersonEndExecutionHistoryListResponse
	}
	personEndExecutionList: {
		params: PersonEndExecutionListParams
		response: PersonEndExecutionListResponse
	}
	personEnforceInfoList: {
		params: PersonEnforceInfoListParams
		response: PersonEnforceInfoListResponse
	}
	personFinalBenefitList: {
		params: PersonFinalBenefitListParams
		response: PersonFinalBenefitListResponse
	}
	personGroupList: {
		params: PersonGroupListParams
		response: PersonGroupListResponse
	}
	personInitiateAnnoListVo: {
		params: PersonInitiateAnnoListVoParams
		response: PersonInitiateAnnoListVoResponse
	}
	personInvestInfoHistoryList: {
		params: PersonInvestInfoHistoryListParams
		response: PersonInvestInfoHistoryListResponse
	}
	personInvestInfoList: {
		params: PersonInvestInfoListParams
		response: PersonInvestInfoListResponse
	}
	personLimitHighList: {
		params: PersonLimitHighListParams
		response: PersonLimitHighListResponse
	}
	personNoticeDeliverAnnoList: {
		params: PersonNoticeDeliverAnnoListParams
		response: PersonNoticeDeliverAnnoListResponse
	}
	personOpenAnnoList: {
		params: PersonOpenAnnoListParams
		response: PersonOpenAnnoListResponse
	}
	personRefereeDocList: {
		params: PersonRefereeDocListParams
		response: PersonRefereeDocListResponse
	}
	personStockRiskInfoList: {
		params: PersonStockRiskInfoListParams
		response: PersonStockRiskInfoListResponse
	}
	randomCheckInfoList: {
		params: RandomCheckInfoListParams
		response: RandomCheckInfoListResponse
	}
	recruitInfoList: {
		params: RecruitInfoListParams
		response: RecruitInfoListResponse
	}
	riskChecking: {
		params: RiskCheckingParams
		response: RiskCheckingResponse
	}
	riskNoPromiseStatistics: {
		params: RiskNoPromiseStatisticsParams
		response: RiskNoPromiseStatisticsResponse
	}
	selectBiddingDetail: {
		params: SelectBiddingDetailParams
		response: SelectBiddingDetailResponse
	}
	selectKeyPersonEnterprise: {
		params: SelectKeyPersonEnterpriseParams
		response: SelectKeyPersonEnterpriseResponse
	}
	selectRelatedEnterprise: {
		params: SelectRelatedEnterpriseParams
		response: SelectRelatedEnterpriseResponse
	}
	shareholderInfo: {
		params: ShareholderInfoParams
		response: ShareholderInfoResponse
	}
	simpleCancelList: {
		params: SimpleCancelListParams
		response: SimpleCancelListResponse
	}
	spotCheckList: {
		params: SpotCheckListParams
		response: SpotCheckListResponse
	}
	stdInfoList: {
		params: StdInfoListParams
		response: StdInfoListResponse
	}
	summaries: {
		params: SummariesParams
		response: SummariesResponse
	}
	supplychainList: {
		params: SupplychainListParams
		response: SupplychainListResponse
	}
	suspectRelList: {
		params: SuspectRelListParams
		response: SuspectRelListResponse
	}
	taxArrearAnnoList: {
		params: TaxArrearAnnoListParams
		response: TaxArrearAnnoListResponse
	}
	taxIllegalList: {
		params: TaxIllegalListParams
		response: TaxIllegalListResponse
	}
	taxPayerTypeList: {
		params: TaxPayerTypeListParams
		response: TaxPayerTypeListResponse
	}
	technologyEnterpriseTags: {
		params: TechnologyEnterpriseTagsParams
		response: TechnologyEnterpriseTagsResponse
	}
	telecomCertInfoList: {
		params: TelecomCertInfoListParams
		response: TelecomCertInfoListResponse
	}
	tmInfoList: {
		params: TmInfoListParams
		response: TmInfoListResponse
	}
	ultimateBeneficiary: {
		params: UltimateBeneficiaryParams
		response: UltimateBeneficiaryResponse
	}
}

export type YiqichaApiParamsByKey<Key extends YiqichaApiKey> = YiqichaApiTypeMap[Key]['params']
export type YiqichaApiResponseByKey<Key extends YiqichaApiKey> = YiqichaApiTypeMap[Key]['response']
