---
title: 票据图像识别与查验（Invoice）
description: 结合视觉大模型（VLM）与浏览器自动化，对发票和财政票据执行结构化要素提取与查验。
---

`@pluxel/plugin-invoice` 提供了票据图像识别与查验的综合解决方案。它将多模态大模型的票据识别能力与 Playwright 浏览器自动化结合，实现了从票据图片提取关键要素，到前往官方税务或财政查验平台验证真伪的端到端编排。

## 核心方法

在业务插件中注入 `InvoicePlugin`：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { InvoicePlugin } from '@pluxel/plugin-invoice'

@Plugin()
export class ReimbursementPlugin extends BasePlugin {
	constructor(private readonly invoice: InvoicePlugin) {
		super()
	}

	async processBill(imageBytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png') {
		// 1. 仅通过视觉大模型提取票面结构化信息
		const extracted = await this.invoice.extract({ bytes: imageBytes, mimeType })

		// 2. 或者一步完成“提取 + 官网自动化查验”
		const verified = await this.invoice.verifyImage({ bytes: imageBytes, mimeType })
		return verified
	}
}
```

## 数据结构划分

- **`input`（查验要素）**：发票代码、发票号码、开票日期、校验码后六位或价税合计；
- **`details`（业务明细）**：购买方名称、税号、商品明细清单；
- **`evidence`（查验证据）**：官方查验平台的网页快照与原始结构化回执，供财务归档和后续审计。
