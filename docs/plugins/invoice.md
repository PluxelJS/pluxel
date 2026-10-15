---
title: 图片票据提取与查验
description: 使用一个插件提取票据、访问对应官网，并分别返回模型识别、结构化官网详情和查验结论。
---

`@pluxel/invoice` 的 `InvoicePlugin` 在同一包内处理财政票据与数电发票。模型负责转录图片，代码负责字段校验、官网操作和结果比对。它是实验性集成，需要处理待审核、人工验证和异常，不能保证每张票据无人值守查验成功。

## 接入与方法

应用注册 `PlaywrightPlugin`、`InvoicePlugin` 和消费插件，配置外部浏览器 CDP 服务。插件不安装或启动浏览器，无需 Workbench、数据库或任务队列。配置模型时需显式安装 Vault，见[完整应用示例](https://github.com/PluxelJS/pluxel/blob/main/plugins/browser/invoice/examples/application.ts)和[浏览器连接](./browser.md)。

| 示例环境变量           | 用途                            |
| ---------------------- | ------------------------------- |
| `BROWSER_ENDPOINT`     | 外部浏览器 CDP 地址             |
| `INVOICE_VLM_ENDPOINT` | 完整 HTTPS chat-completions URL |
| `INVOICE_VLM_MODEL`    | 支持图片输入的实际模型名        |
| `INVOICE_VLM_KEY`      | 由 Vault 绑定读取的 API key     |

通过构造函数注入 `InvoicePlugin` 后调用：

| 方法                                                | 作用                               | 正常返回                                                          |
| --------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `extract(image, { signal })`                        | 模型提取查验要素及金额，不访问官网 | `extracted` 或 `needs_review`                                     |
| `verify(input, { signal, onCaptcha, onChallenge })` | 查验已有结构化字段                 | `matched`、`action_required` 或 `unconfirmed`                     |
| `verifyImage(image, options)`                       | 提取后查验，共用一次操作预算       | `needs_review` 或携带 `extraction`、`verification` 的 `completed` |

输入图片为 `{ bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }`，1 字节至 10 MiB。插件检查格式签名并复制输入；调用方负责文件读取或 PDF 渲染，不接受任意路径/远程图片 URL。

## 数据契约与来源

三个概念各有用途，不要求业务方解析网页标签：

| 字段                        | 用途与权威来源                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `input: InvoiceInput`       | 提交官网的最小查验要素；`extract()` 从校验通过的模型字段生成                                               |
| `details: InvoiceDetails`   | 业务字段。`extraction.details` 来自模型；`verification.details` 来自官网，两者分别保留，绝不互相补值或覆盖 |
| `evidence: InvoiceEvidence` | 官网原始标签、表格和文本，供审核未知字段、追溯映射；不是日常业务读取字段的入口                             |

`verifyImage()` 的结果结构：

```ts no-twoslash
{
  status: 'completed',
  extraction: {
    status: 'extracted',
    input: { kind: 'digital-tax', number: '...', issueDate: '2026-07-17', totalIncludingTax: '113.00' },
    details: { /* 模型转录；与下面的官网详情独立 */ }
  },
  verification: {
    status: 'matched',
    checkedAt: '...',
    details: {
      kind: 'digital-tax',
      number: '...',
      issueDate: '2026-07-17',
      title: '电子发票（普通发票）',
      buyer: { name: '测试购买方', taxId: '...' },
      seller: { name: '测试销售方', taxId: '...' },
      amounts: {
        totalExcludingTax: '100.00', taxAmount: '13.00',
        totalIncludingTax: '113.00', totalIncludingTaxUppercase: '壹佰壹拾叁圆整'
      },
      items: [{
        name: '测试服务', specification: '', unit: '次', quantity: '1',
        unitPrice: '100.00', amount: '100.00', taxRate: '13%', taxAmount: '13.00'
      }],
      remarks: '', issuedBy: '测试员'
    },
    redLetterStatus: 'not_observed',
    issues: [],
    evidence: { source: 'official-portal', fields: [], tables: [], text: '...', truncated: false }
  }
}
```

上面是字段布局示意，省略了真实证据内容。模型目前只转录查验要素与金额校验所需字段，因此 `extraction.details` 的当事方、明细等为 `null`；数电发票的不含税金额和税额会保留，不会在校验后丢弃。

### 业务字段

`InvoiceDetails` 用 `kind` 区分票种。两类共享 `title`、`items`、`remarks`、`issuedBy`；没有猜测性补齐。

| 票种          | 专有字段                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- |
| `digital-tax` | `number`、`issueDate`、`buyer`、`seller`、`amounts`（不含税金额、税额、价税合计及大写金额） |
| `fiscal`      | `code`、`number`、`checkCode`、`issueDate`、`payer`、`payee`、`amount`                      |

当事方为 `InvoiceParty { name, taxId }`；财政适配仅在有明确标签时读取交款人、收款单位，不推断其税号。明细项 `InvoiceLineItem` 包括名称、规格、单位、数量、单价、金额、税率与税额。财政表格尚未识别出对应列时不会硬套税务表格。

- 标识符始终为字符串，保留前导零。
- 金额、单价、数量使用十进制字符串，不能直接转换成 JavaScript 浮点数。官网金额只移除明确的 `¥/￥` 前缀，不猜测千分位或掩码；金额最多两位小数，单价/数量最多十二位小数。
- 税率保留 `13%`、`免税` 等原始表达，不把免税或 `***` 税额变成零。
- `null` 表示该来源没有提供可用的明确值；`''` 表示观测到空白文本。`items: null` 表示没有可可靠映射的明细表，`items: []` 表示观测到只有表头的空表。
- 返回的是独立快照，修改它不会影响插件或官网会话。

### 查验结论与数据问题

`completed` 只表示工作流结束。`verification` 的含义：

- `matched`：唯一可解析的官网结果与输入身份字段一致，返回 `details`、`evidence`、`issues`、`checkedAt`、`redLetterStatus`。不等于报销审核通过。
- `action_required`：需要应用提供安全验证交互；会话在返回前关闭。
- `unconfirmed`：官网消息、身份字段不一致或未知结果布局，`reason` 分别为 `site_message`、`identity_mismatch`、`unsupported_result`。不等于假票。

官网附加字段无法可靠映射时，以 `issues: InvoiceDetailIssue[]` 报告 `{ path, code }`，`path` 相对于查验结果，如 `details.buyer.name` 或 `evidence`。`ambiguous_field` 表示重复字段/表格无法选择；`invalid_value` 表示格式不合法；`unsupported_table` 表示合并单元格、列错位等不能映射；`inconsistent_totals` 表示官网合计不自洽；`truncated_evidence` 表示证据被截断。身份匹配与这些问题分别表达，业务审核应检查两者。不会跳过不支持的行而把剩余行包装成完整明细，也不会自动修正金额。

`redLetterStatus: 'fully_reversed'` 表示检测到官网已确认的“全额红冲”图片资源；`not_observed` 仅表示没识别到该标记，**不证明正常、未作废或可报销**。目前自动检测只覆盖税务全额红冲，财政和其他状态不推断。标记读取不依赖模型。

### 原始官网证据

身份字段和证据在同一次 DOM 读取中取得。`evidence` 保留：

- `fields`：`{ section, label, value }[]`，原始分区、标签和值，包含尚未映射的标签字段。
- `tables`：各表的 `rows`，单元格为 `{ text, header, rowSpan, colSpan }`，保留原表顺序、空单元格及合并关系。
- `text`：详情容器文本，排除脚本、样式及表单控件；财政读取用于生成票面图的已填充源模板。
- `truncated`：是否触及限制。文本最多 65536 字符，字段最多 128 个，表格最多 16 张、每表 200 行、每行 32 个单元格；字段/单元格字符串最多 4096 字符，累计文本预算 131072 字符。

发生截断时，只保留独立读取并核对的身份字段；附加业务字段保持 `null`，避免将截断后的数字或名称当成完整值。未加载的附表、分页/虚拟列表行、纯图片或 Canvas 文字不会自动取得；`truncated: false` 也不是完整性证明。证据不是 HTML/截图，不自动打印到日志。

## 支持的查验输入

财政票据与税务发票属于不同凭证，分别访问[财政查验平台](https://pjcy.mof.gov.cn/html/index.html#/home)和[税务查验平台](https://inv-veri.chinatax.gov.cn/fpcygzfw/)，网站差异由内部适配器处理。

| 输入                                                            | 规则与边界                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `{ kind: 'digital-tax', number, issueDate, totalIncludingTax }` | 20 位数电发票号码，使用价税合计；官网核对号码、日期、价税合计                 |
| `{ kind: 'fiscal', ticket: FiscalTicketInput }`                 | 8 位代码、10 位号码、6 位英数印刷校验码、金额、日期；官网五要素全部一致才匹配 |

日期必须是真实 `YYYY-MM-DD`，金额为至多 16 位整数、两位小数的有符号十进制字符串。模型提取还用整数分检查不含税金额加税额等于价税合计。传统 8 位税务发票号码、其他票种、不清晰或不合法字段返回 `needs_review`，提供 `reason`、`fields` 和有界 `candidate`；不自动补零或修补金额。直接 `verify()` 输入不合法则抛 `TypeError`。

财政地方 iframe、多份结果、未知格式仍返回 `unconfirmed`。印刷校验码不是图片验证码；财政交互安全验证目前需要页面接管。财政实票及 Lightpanda 的完整链路尚未验证。

## 配置与凭据

`InvoiceConfig` 和 `InvoiceVaultSchema` 从公开入口导出。普通配置不包含 API key。

| 配置                  | 默认     | 含义                                                                            |
| --------------------- | -------- | ------------------------------------------------------------------------------- |
| `timeoutMs`           | `180000` | 单次总预算，覆盖模型、网站、人工等待；1000–600000                               |
| `maxConcurrent`       | `1`      | 两个票种、识别和查验共用额度；1–8，超出立即拒绝，不排队                         |
| `captchaAttempts`     | `1`      | 税务验证码最多自动提交次数；0–3，0 表示人工处理                                 |
| `vlm`                 | 未配置   | 未配置仍可调用结构化 `verify()`；图片识别明确失败                               |
| `vlm.endpoint`        | 必填     | 完整 HTTPS chat-completions URL，不拼接路径，不接受 URL 凭据、query 或 fragment |
| `vlm.model`           | 必填     | 反代实际模型名，例如 `glm-5.3-flash`；不探测或回退模型                          |
| `vlm.credentialKey`   | 必填     | 该插件 Vault 中 `{ apiKey: string }` 的记录 key                                 |
| `vlm.maxOutputTokens` | `4096`   | 输出预算 256–16384；需给推理和最终 JSON 留出空间，截断响应明确失败              |

协议采用兼容 chat-completions 的 `image_url` data URL。模型名不保证视觉能力，部署者应实测。提取请求包含完整票据图片；验证码请求只含裁剪图和页面提示。环境变量由 Host 处理，插件不直接读取进程环境。示例把 API key 绑定到 `primary.apiKey`；私密浏览器地址使用[浏览器 Vault 配置](./browser.md)。配置或凭据修改后重启插件生效。

## 人工验证码与消费示例

普通业务方不需要操作 Playwright。税务文字验证码的兜底接口：

```ts no-twoslash
const result = await invoices.verifyImage(image, {
	signal,
	onCaptcha: async ({ image, instruction, signal }) => {
		// 由应用显示 PNG 字节及提示，返回原样答案；取消返回 null。
		return await yourCaptchaUI.ask({ image, instruction, signal })
	},
})
if (result.status === 'completed' && result.verification.status === 'matched') {
	const { details, issues, redLetterStatus } = result.verification
	if (details.kind === 'digital-tax') {
		// 直接访问类型字段；审核时仍检查 issues 和红冲观察结果。
		console.log(details.seller?.name, details.amounts.totalIncludingTax)
	}
}
```

`yourCaptchaUI` 由应用实现。完整业务插件示例见 [consumer.ts](https://github.com/PluxelJS/pluxel/blob/main/plugins/browser/invoice/examples/consumer.ts)，它处理全部正常结果分支并保留完整结果。

`onCaptcha` 与 `onChallenge` 共用一次人工机会。文字回调在自动识别禁用、模型无法确定或自动提交额度耗尽后调用；返回 1–8 个字母/数字或 `null`，非法值抛 `TypeError`。插件负责填表、核对图片与提示是否变化、提交。外部 UI 应遵守 `signal`，等待期间仍占用本次额度。

财政滑块等交互使用高级 `onChallenge: async ({ page, signal }) => { ... }`，由应用提供交互界面。税务页面接管需完成验证码并提交；财政回调完成网站安全验证后插件继续观察结果。不能关闭或保留借用的 Page。插件不提供远程桌面 UI。没有可用回调时返回 `action_required` 并关闭会话，下一次尝试属于新查验。

只有明确“验证码错误/验证码不正确”才允许有界自动重试。网络错误、官网服务异常、超时、额度响应和未知消息不重试。验证码过期时不提交旧答案；人工答案也不无限重试。

## 异常、清理与验证边界

`InvoiceError.code` 为 `BUSY`、`TIMEOUT`、`NOT_RUNNING`、`VLM_NOT_CONFIGURED`、`VLM_HTTP`、`VLM_RESPONSE`。HTTP 错误仅携带 `httpStatus`，不暴露服务端正文。输入错误抛 `TypeError`；原生 fetch、Playwright、人工回调异常保持原契约。操作与清理同时失败时抛 `AggregateError`。不要盲目重试异常，官网查询可能已经提交。

取消、调用方停止、插件停止会终止请求并关闭独立浏览器会话，等待清理后归还额度。无法强停任意回调代码，浏览器获取/关闭也没有硬清理期限；总预算不保证浏览器在该时刻完成清理。取消不回滚已提交查询或恢复官网额度。

`vp run test` 验证字段归一化及真实隔离 Host 行为；`vp run test:browser` 用 Chromium 和合成网页验证 UI、快照、结果分支和清理。真实官网成功详情已做离线回放，验证了购销双方、税号、金额和明细映射。这不代表新一次在线核验：后续无人介入实测仍出现服务器异常、验证码拒绝及 `action_required`，尚未证明稳定的全自动成功率。

`vp run test:live` 显式访问外部模型和官网，需要模型环境变量及 `INVOICE_IMAGES`（1–3 个本地 JPEG 绝对路径的 JSON 数组）。默认每张最多自动提交一次，`INVOICE_CAPTCHA_ATTEMPTS` 可设 0–3。输出只含文件名、模型、无人回调标记和状态；命令成功不等于官网 `matched`。`INVOICE_REPORT` 可追加 JSONL，`INVOICE_CAPTURE_DIR` 可保存 HTML/截图；这些敏感材料及 key 应留在本地忽略目录。
