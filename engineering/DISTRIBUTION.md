# 应用发行物完整性与来源证明

`@pluxel/rolldown/distribution` 负责已完成 finalization 的 Node 应用 artifact set、in-toto/DSSE 与惰性
delivery marker 契约。Runtime 启动不会读取这些文件、遍历发行目录、计算 hash、验证签名或发送 telemetry。

构建何时生成 manifest 读 [Finalization 所有权](#finalization-所有权)；目录/路径规则读 [Artifact set v1](#artifact-set-v1)；签名验证读[签名 Attestation](#签名-attestation)；delivery token 读[可选 Delivery marker](#可选-delivery-marker)。这些检查是发行工具职责，不进入应用启动热路径。

## Finalization 所有权

`pluxel()` 会在 server chunks、`pluxel-deployment.json`、Workbench/public、Node artifacts 和 nf3 residual
packages 全部组装完成后调用 `createDistributionManifest()`。Manifest 路径固定为 `pluxel-distribution.json`。

应用声明 config environment bootstrap 时，assembly 会在 finalization 前生成 root `.env.example`；它与 server、
public 和 artifact 文件一样进入 inventory。该文件不是 runtime input，也不授权 finalizer 读取、生成或加载真实 `.env`。

如果应用任务在 freezer 返回后继续写入 `dist/`，release pipeline 必须在最后一次写入后调用
`pluxel distribution create ./dist`。自动与显式 finalization 使用同一个函数。Finalizer 从
`pluxel-deployment.json` 派生 application name、catalog hash、Node target 与 headless/workbench variant；
`pluxel()` 不接收 claims、signer 或 trust 配置。

## Artifact set v1

公开 schema 位于 `@pluxel/rolldown/distribution/schema.json`。编码固定为 compact UTF-8 JSON + LF、固定字段顺序，entry
按规范化路径的 UTF-8 bytes 排序。Inventory 包含 root 下每个 regular file 与允许的 symlink，包括 deployment metadata、
server chunks、Workbench/public、应用 public 文件、Node artifacts、residual `node_modules`、SBOM 和可选的
`pluxel-delivery.json`。

只排除 root 下的 `pluxel-distribution.json` 与 `pluxel-distribution.dsse.json`。协议没有 exclusion glob 或 mutable
subtree，因此 persistence、logs、databases、uploads 与 caches 必须位于不可变 distribution root 外。

共享 walker 强制以下规则：

- 相对 `/` 路径必须为 NFC；拒绝 NUL、反斜杠、absolute/drive path、空 segment、`.` 与 `..`；
- 拒绝 NFC collision 与 portable case-fold collision；
- symlink target 必须是留在 real root 内的相对路径，不得通过中间 symlink 逃逸或形成 cycle；
- hard link 按每个 path 与对应 bytes 独立记录；
- 拒绝 FIFO、socket、device 和其他特殊 entry。

V1 证明 file set、regular file size/SHA-256 与 symlink target，不声明 mtime、owner、ACL、xattr、POSIX mode、空目录或
archive container metadata。Verifier 只处理已经安全解包的目录，绝不 import 应用 entry。

## 签名 Attestation

`createDistributionStatement()` 生成确定性的 in-toto Statement v1 bytes，唯一 subject 是 manifest 原始 bytes 的
SHA-256。Predicate 只接受 `version`、`revision` 与 `distributionId`，并要求至少存在一个。Claims 是 issuer assertion，
不从 package metadata、product 展示信息、VCS 或 runtime state 推导。

`createDssePreAuthenticationEncoding()` 生成标准 DSSE PAE bytes。私有流水线在外部完成签名，再使用
`createDistributionDsseEnvelope()` / `serializeDistributionDsseEnvelope()` 写入唯一的
`pluxel-distribution.dsse.json`。Build API 不接收 private key、KMS client、callback、shell command 或 trust policy。

V1 offline verification 只支持调用方显式提供的 Ed25519 public key。`keyid` 为空，或等于
`fingerprintDistributionKey()` 生成的 SHA-256 SPKI fingerprint；artifact 邻近的 key 不能建立信任。至少一个 trusted
signature 必须验证成功。Threshold、certificate chain、transparency log、revocation 与 trusted timestamp 不属于 v1。

Verification report 使用 `reportVersion: 1`、`verifierVersion: 1`、稳定 top-level code 与 difference list。失败优先级为：

1. `MANIFEST_ABSENT`
2. `ATTESTATION_ABSENT`
3. `ATTESTATION_UNSUPPORTED`
4. `ATTESTATION_INVALID`
5. `SIGNATURE_UNTRUSTED`
6. `SUBJECT_MISMATCH`
7. `MANIFEST_INVALID`
8. `ARTIFACT_MISMATCH`
9. `VERIFIED`

## 可选 Delivery marker

`markDistribution()` 创建唯一的 `pluxel-delivery.json`，只包含 schema version 与随机 256-bit base64url token。必须位于
distribution 外的私有 delivery record 保存相同 token 和 release claims 的 `distributionId`。Marker 不包含客户身份，也不修改
HTML、JavaScript、CSS、source map、native binary 或 runtime 行为。

`correlateDistribution()` 只报告 `DELIVERY_MARK_MATCH` 或 `DELIVERY_MARK_NONE`。Token 可以被删除、复制或移植，因此结果仅表示
与一份私有 record 相等，不代表 attribution、authorization、intent、chain of custody 或法律结论。需要调查价值的流水线必须在
独立系统中保存 record，并另外提供签名、可信时间戳或 append-only 约束。

## 动态来源的证明范围

standalone 是封闭 bundle，拒绝 sources；modules 编译输出保持真实 package imports 和 Node/Workbench inventory，原生启动按 runtime sharedPackages 准入共享身份，不生成 framework facade。交付边界由 [APPLICATION_BUILD](APPLICATION_BUILD.md) 维护。

modules finalization 同样记录整个已构建目录及其 inventory，不声称证明部署端外部 package 安装。外部来源目录保持可变，必须位于发行目录外，不属于该 artifact manifest/attestation；Package Manager 保留的 immutable revisions 由其发布记录维护，不自动进入宿主签名范围。

## 实现与验证

`packages/rolldown/src/distribution/` 拥有 schema、walker、manifest、attestation 与 marker；`packages/rolldown/tests/distribution.test.ts` 验证确定性 bytes、路径/链接拒绝、文件集合变化、签名信任和失败优先级。应用装配见 [APPLICATION_BUILD](APPLICATION_BUILD.md)。

回归必须覆盖最后一次写入后再 finalization、额外/缺失/篡改文件、symlink containment 与不 import 应用 entry。宿主 manifest 不证明 mutable dynamic Plugin 目录；搬离 workspace 的启动验证也不能代替签名和 inventory 检查。
