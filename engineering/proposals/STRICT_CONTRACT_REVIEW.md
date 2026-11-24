# 严格契约：剩余设计问题

状态：主体修复已实现；本页仅保留尚未实现的维护工具和准入问题。当前行为由[工程原则](../DESIGN_PRINCIPLES.md)、[工具链](../TOOLCHAIN.md)、[工作区工具](../CLI_WORKSPACES.md)与 [HMR](../HMR.md)维护。已完成修复和旧 source-lock 迁移记录由 Git 保存。

## 显式批量修复工具

`workspace doctor` 仍是只读检查，[命令定义](../../packages/cli/src/command-manifest.ts)没有 `--fix`。普通构建只验证作者清单、更新编译器拥有的 metadata；版本维护复用现有 `workspace sync`，不能从安装树猜测 Plugin 的 peer 角色和期望范围。

待决定的是哪些错误已有足够权威输入，值得批量修复。候选方案先由 inventory/编译事实形成字段、旧值、期望值、依据和冲突报告；用户可审查后，检查文件快照再写入、重新检查并报告部分完成。缺少版本依据、角色不明或声明冲突的项目继续只诊断。

验收应覆盖只读预览、确定性修复、编辑冲突和部分写入失败，并证明不迁移 Host 或私有 RPC、不覆盖其他作者改动。先取得实际重复维护样本，再决定是否增加命令。

## 解析失败的可分类依据

OXC 当前无稳定错误种类时，缺少物理 package 证据的 alias/tsconfig 失败仍可能与普通未命中混淆。现有行为与诊断限制见[工具链](../TOOLCHAIN.md)。若取得稳定的上游错误类型或可重复的本地反例，再决定是否细化 resolver 分类；验收保留 importer、specifier、conditions 与 cause，不按错误文案正则猜测。

独立 publisher、浏览器与生产发行路径属于已有功能的剩余验收，集中在 [Workbench 验收指南](../WORKBENCH_FLEXLAYOUT_VALIDATION.md#独立发行与浏览器边界)，不另作新功能提案。
