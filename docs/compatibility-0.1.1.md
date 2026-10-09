# 0.1.1：适配 DSH 0.1.7-rc.2

修复日期：2026-09-28。

## 原因

0.1.0 在 package.json（包声明文件）的 peerDependencies（宿主依赖版本约束）中，将五个 DSH 服务精确限定为 `0.1.6-alpha.2`。当前宿主为 `0.1.7-rc.2`，不满足这些约束。启动检查在导入插件代码之前拒绝加载该组合包，因此这条日志不是文档解析器运行时异常。

核对依据为官方 `dsh-v0.1.7-rc.2` 标签，提交 `477b4f420553e8a52c2fbccc464d7561b239c443`。官方校验源码：

https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/boot/app-boot/src/plugin-compatibility.ts

其中 `evaluatePluginCompatibility`（插件兼容性检查函数）对每个 DSH 宿主依赖执行版本范围匹配。预发布版本参与范围比较，但不同的精确版本依然不匹配。

## 改动

| 内容 | 原版本 | 新版本 |
|---|---|---|
| 插件 | 0.1.0 | 0.1.1 |
| 五个 DSH 宿主服务及开发用 DSH 服务 | 0.1.6-alpha.2 | 0.1.7-rc.2 |
| Cordis | 4.0.2 | 4.0.4 |
| Cordis include（配置包含插件） | 1.0.7 | 1.0.9 |
| Cordis loader（加载器） | 1.0.3 | 1.0.5 |
| Schemastery | 3.18.2 | 3.18.4 |

同步重新生成 `pnpm-lock.yaml`，更新 `pnpm-workspace.yaml`。新增加载回归测试：无需安装 Python，使用真实的新版宿主服务加载编译产物，确认两个工具注册成功且卸载后注销。

本次涉及的工具注册、文件访问、子进程、会话清理和审批调用通过新版类型检查。生产逻辑未作修改，Python 源码和依赖锁定保持原样。

版本约束只声明本次核验的 `0.1.7-rc.2`；不使用通配符、删除依赖声明或版本豁免来放行其他未经验证的运行时。

## 更新步骤

停止 DSH，保留原配置，将本包内容覆盖到原插件目录。在该目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add .
dsh --profile web
```

`profile`（配置档）名 `web` 仅作示例，请改成实际启动时使用的名称。重新添加本地包可刷新配置档的安装引用；不要只替换编译产物而遗漏包声明和锁文件。已正常工作的 Python 环境无需重装。

若日志仍显示 `dsh-document-reader@0.1.0`，应检查是否更新了错误的目录或配置档。无需执行 `allow-version`（授予版本豁免）。

## 验证范围

详见 `validation.md`（验证记录）中 2026-09-28 的记录。测试使用 Linux、Node 24 和真实的 0.1.7-rc.2 宿主服务；未在用户的 Windows 安装环境执行，未宣称完整桌面或浏览器端验收。
