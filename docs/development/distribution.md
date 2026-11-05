---
title: 应用发行物
description: 创建、检查并签名验证 standalone 或 modules Node 应用目录。
---

在将构建后的应用交付部署到生产服务器、容器镜像或离线环境时，可以通过发行物工具生成数字清单并校验完整性，确保文件未被损坏或篡改。

## 快速使用：创建与校验清单

当生产目录（如 `dist/`）构建完成后，执行以下指令生成并核对清单：

```sh
# 1. 为产物目录生成确定性文件清单（pluxel-distribution.json）
vp exec pluxel distribution create ./dist

# 2. 检查当前目录文件哈希与清单是否一致
vp exec pluxel distribution inspect ./dist
```

- `create`：扫描目录下的所有静态文件、服务端代码模块与静态资源，计算 SHA-256 哈希值与文件尺寸并写入清单。
- `inspect`：比对文件与清单的一致性，返回 `INTACT` 表示目录完整无误。

## 自管数据库与原生依赖打包

在生产构建中（`standalone` 模式），若使用了非托管的嵌入式数据库（如 `@libsql/client`）或包含平台原生 C++ Addons 的依赖，需在构建配置中显式声明：

```ts no-twoslash
import { defineConfig } from 'vite-plus/pack'
import { pluxel } from '@pluxel/rolldown'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [
		pluxel({
			variant: 'headless',
			managedDatabaseDrivers: [],
			residualDependencies: {
				packages: ['@libsql/client'],
			},
		}),
	],
})
```

- `managedDatabaseDrivers: []`：显式切断未使用的托管数据库驱动（如默认的 pglite 或 postgres），避免无用依赖进入最终打包产物。
- `residualDependencies.packages`：确保通过原生 binding 加载的依赖及其辅助二进制库被完整追踪并拷贝至交付目录。

## CLI 工具核心命令

| 命令 | 用途说明 |
| :--- | :--- |
| `create` | 扫描完整目录并生成确定性清单（`pluxel-distribution.json`） |
| `inspect` | 比对当前目录与清单，检测是否存在新增、删除或内容修改的文件 |
| `verify` | 结合 Ed25519 公钥验证 DSSE 签名凭据与清单的合法性 |
| `mark` | 写入专属的发布标记（用于在不同发版批次间进行追踪） |
| `correlate` | 比对产物中的标记与留存记录是否匹配 |

### 使用 Ed25519 签名验证（Verify）

在受控的 CI/CD 发布流水线中，可通过私钥对生成的清单进行 DSSE 签名，并在部署端进行公钥验证：

```sh
pluxel distribution verify ./dist \
	--key ./release-issuer.ed25519.pub.pem \
	--report ../reports/verification.json
```

- `--key`：传入受信任的发布公钥文件路径（支持多次传入多个备用公钥）。
- 校验通过后，返回 `VERIFIED` 状态并生成结构化验证报告。

### 发布标记与批次追踪（Mark / Correlate）

在为特定客户或环境制作专属交付物时，可在生成清单前植入轻量级发布标记：

```sh
# 写入发行标记
pluxel distribution mark ./dist \
	--claims ../private/release-claims.json \
	--record-out ../private/delivery-record.json

# 生成最终清单
pluxel distribution create ./dist

# 在接收端验证标记与交付记录的匹配度
pluxel distribution correlate ./dist \
	--delivery-record ../private/delivery-record.json
```

## 生产部署建议

- **持久化数据隔离**：运行时产生的数据存储、上传文件与日志流应配置在发行物根目录之外（如独立的数据卷或 `/var/lib/` 路径）。
- **运行环境适配**：包含原生二进制扩展的依赖需在与目标运行系统架构（如 Linux x86_64 或 ARM64）兼容的环境中完成构建与镜像打包。
