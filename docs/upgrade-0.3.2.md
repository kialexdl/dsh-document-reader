# 0.3.2：适配 DSH 0.2.1-alpha.1

本次将 0.3.1 的 DSH 0.1.7-rc.2 宿主基线更新为官方发布的 DSH 0.2.1-alpha.1，对应提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。DSH 的完整版本包含预发布后缀，请以 `dsh --version` 的结果为准；本版本未声明其他 DSH 版本兼容。

## 修改范围

| 项目 | 0.3.2 使用的版本 |
|---|---|
| DSH 宿主依赖与开发依赖 | 0.2.1-alpha.1 |
| Cordis | 4.0.5-alpha.1 |
| Cordis group / include / loader | 1.0.5-alpha.1 / 1.0.10-alpha.1 / 1.0.6-alpha.1 |
| Schemastery | 3.18.5-alpha.1 |
| markitdown | 0.1.7，保持不变 |
| markitdown-ocr | 0.1.0，保持不变 |

更新 `package.json` 中全部 DSH peerDependencies（宿主依赖版本约束）和开发依赖，重新解析并生成 `pnpm-lock.yaml`；删除安装策略中已移除的 `dsh-invariants` 项。锁文件不再含旧 DSH 0.1.7-rc.2 或运行时 invariant 包。

插件没有使用 DSH 本次移除的诊断入口、旧输入区统计入口或子路径独立元数据文件。已有 `exports`（包入口声明）和前端模块加载方式继续适用，因此无需修改业务源码。新增测试直接调用实际安装的 DSH 启动兼容检查器，确认无需精确版本豁免即可通过，并确认不会误声明旧宿主兼容。

读取和搜索参数、手动选择图片模型、大型 Word 的正文优先与分批图片转录、指定图片插队、权限和取消规则均保持不变。持久缓存格式和 Python 锁文件未变，已有缓存可继续使用。

## 升级步骤

1. 停止正在运行的 DSH，保留原有配置。
2. 将本源码包完整解压到插件目录，覆盖旧源码，包含新的依赖锁文件。
3. 在插件目录执行以下命令；`web` 是示例配置档名称，请替换为实际名称。

```powershell
dsh --version
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add .
dsh --profile web
```

4. 刷新浏览器，确认插件管理页显示 `dsh-document-reader@0.3.2`。如果仍显示旧版本，请检查该配置档实际安装的插件路径。

已正常工作的 Python 专用环境无需重建，图片服务商与模型无需重新选择。首次安装仍需按 README 创建 Python 环境并填写 `python.executable`。无需执行 `dsh plugin allow-version`。

## 验证范围

验证使用实际发布的 DSH 0.2.1-alpha.1 依赖，在 Linux、Node 24.19.0、Python 3.12.14 上执行：

- `pnpm install --frozen-lockfile --offline` 成功，锁文件与声明一致。
- `pnpm build` 成功，完成 TypeScript 编译与前端打包。
- Node 测试 39 项通过，无失败或跳过；包括原生加载器的注册和卸载、真实文件读取和搜索、权限与审批、共享缓存和取消、模型目录与前端保存配置、图片模型调用、大型 Word 渐进解析、图片优先级与恢复。
- Python 测试 19 项通过；包括 Office/PDF 转换、内嵌图片位置与顺序、扫描 PDF、错误处理和大图切片。

模型网络调用使用可控的本地测试端点或测试适配器；没有调用用户的实际模型服务，也没有在用户的 Windows 环境中验证。操作系统和服务商差异仍需在实际部署环境确认。

官方版本与变更说明：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1>。
