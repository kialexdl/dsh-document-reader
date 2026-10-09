# dsh-document-reader

DSH 原生文档读取与关键词查找插件。支持 PDF、DOCX、PPTX、XLSX、XLS、CSV、PNG/JPEG；在原生插件页面选择 DSH 已配置的服务商与图片模型，通过 DSH 统一调用；不继承或自动选择主会话模型。旧独立端点配置仍兼容。

## 开源依赖与许可证

本插件的文档转换能力基于 Microsoft 的 [MarkItDown](https://github.com/microsoft/markitdown)，当前固定使用 `markitdown==0.1.7`；图片文字识别相关能力使用同一上游项目的 [markitdown-ocr 0.1.0](https://pypi.org/project/markitdown-ocr/0.1.0/)。感谢上游维护者与贡献者。本项目是独立的 DSH 插件，不代表 Microsoft 官方产品，也不表示获得其背书。

MarkItDown 负责原生文档转换；本插件提供 DSH 工具接入、关键词定位、分页读取、图片模型配置、渐进解析、同步读图和缓存，并通过 Python 适配层扩展上游转换器。

- 本项目自身代码采用 [Apache License 2.0（Apache 2.0 开源许可证）](LICENSE)。第三方组件继续适用其原有许可证，不因本项目许可而被重新许可。
- MarkItDown 和 markitdown-ocr 采用 MIT（Massachusetts Institute of Technology，麻省理工学院宽松开源许可证）。仓库保留 Microsoft 版权声明与完整许可文本：[MarkItDown MIT 许可](licenses/MarkItDown-MIT.txt)。使用这些依赖不要求将本项目自身许可改为 MIT。
- 前端预构建产物包含 Zod 4.4.3，其 MIT 版权声明与完整许可文本见 [Zod 许可](licenses/Zod-MIT.txt)。
- **间接依赖许可边界：** markitdown-ocr 0.1.0 的发布包还声明了 PyMuPDF 依赖，本项目 Python 锁文件固定为 1.28.2。PyMuPDF 采用 GNU AGPL（GNU Affero General Public License，GNU Affero 通用公共许可证）第 3 版或 Artifex 商业许可；不能将整套运行环境认定为仅受 MIT / Apache 2.0 约束。涉及其组合使用、再分发或网络服务时，必须满足适用的 AGPL 义务，或取得覆盖该用途的商业许可；保留本项目 Apache 2.0 声明、公开本仓库或添加致谢本身并不能替代这些义务。

当前仓库不随包分发 MarkItDown、markitdown-ocr 或 PyMuPDF 的第三方代码和二进制；它们由安装脚本另行安装。完整说明、来源和再分发要求见 [第三方许可说明](THIRD_PARTY_NOTICES.md) 与 [版权声明](NOTICE)。如果需要适用于闭源产品的全宽松许可证依赖链，应先替换或移除 PyMuPDF 这项依赖并重新验证，不能只修改许可证文字。

## 版本与交付范围

- 插件：0.3.4。
- DSH 验证基线：0.2.1-alpha.1，commit（提交）`5badb15009ae1756c3afe0ae0cef1faafc290ccc`。宿主兼容范围为 `>=0.2.0-rc.2 <0.3.0-0`；构建依赖继续固定该验证基线。
- Python 发布包：`markitdown==0.1.7`、`markitdown-ocr==0.1.0`，从 PyPI（Python Package Index，Python 软件包索引）安装；不使用未发布源码快照。
- Node：`^22.19.0 || >=24.0.0`；推荐 Python 3.12，安装锁定依赖与本次测试均使用 3.12。
- 纯源码 ZIP 不含 `node_modules`、`lib`、Python 环境、wheels 或第三方源码；用于本地开发，需要安装依赖并构建。
- GitHub 安装目录 / `-github.zip` 另外包含预构建的 `lib`。DSH 可直接安装这些文件，不需要在安装时执行 TypeScript / esbuild 构建。

## 在 DSH 界面通过 GitHub 地址安装

安装仓库：[kialexdl/dsh-document-reader](https://github.com/kialexdl/dsh-document-reader)。仓库根目录包含 0.3.4 源码及同版本预构建产物，可通过 DSH 插件页面安装。

1. 使用 **DSH 0.2.0-rc.2 或上述兼容范围内的版本**，在实际要使用的配置档中打开侧栏 **插件 → 添加插件 → 安装第三方插件**。
2. 粘贴 `https://github.com/kialexdl/dsh-document-reader`，点击 **安装**。
3. 安装成功后点击 **立即启用**。安装默认是停用状态；安装成功不代表插件已经启用。
4. 打开 **dsh-document-reader → document-reader → 配置**，确认页面正常加载。已有 Python 环境和图片服务商设置可以继续使用。

本包保留源码，同时将编译后的后端、类型声明和 DSH 前端模块一同发布。不要从 GitHub 发布目录删除 `lib`；不要上传 `node_modules` 或 Python 环境。故意没有添加 `prepare` / `prepack` / `postinstall`：pnpm 的 Git 依赖构建批准与普通依赖脚本批准不同，DSH 当前界面的重试按钮不能覆盖所有 Git 构建拦截。

**首次 Python 设置仍需单独完成。** GitHub 安装不会下载 Python、创建 venv 或运行 pip。首次使用可从相同版本源码包执行下节的 Python 安装脚本；此步骤不要求先构建 Node 插件。脚本会输出 `python.executable`，在插件配置页的 Python 设置中填入即可。已正常工作的 Python 环境不用重装。详细安装、更新和排错见 [GitHub 界面安装说明](docs/ui-install.md)。

## 从源码安装

在解压后的 `dsh-document-reader` 目录中执行：

```powershell
pnpm install --frozen-lockfile
pnpm build

# Windows：创建专用 venv，不修改全局 Python。
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-python.ps1
```

`Bypass` 仅应用于这一次 PowerShell 进程，不修改用户或系统执行策略；受组织策略强制禁止时，直接使用 Python 入口：

```powershell
py -3.12 .\scripts\setup_python.py
```

默认专用环境位于 `%LOCALAPPDATA%\dsh-document-reader\venv`。安装脚本输出 `python.executable` 的实际路径，并运行依赖 doctor（检查版本和源码文件哈希）。首次安装需要 npm 与 PyPI 下载能力；Python 依赖安装不再需要 Git 或 GitHub。

Linux/macOS：

```sh
DOCUMENT_READER_PYTHON=python3.12 bash scripts/setup-python.sh
```

默认环境为 `${XDG_DATA_HOME:-$HOME/.local/share}/dsh-document-reader/venv`。自定义位置可传 `--venv /absolute/path/venv`。

安装脚本直接读取 `python/requirements.txt` 的固定发布版本，并使用 `python/constraints.lock` 约束传递依赖。离线部署参见下方依赖包准备说明。

挂载到独立 DSH 测试 profile；以下命令在插件源码目录执行：

```powershell
dsh --profile document-reader-test --from-default-profile web --dump-config
dsh plugin --profile document-reader-test add .
dsh --profile document-reader-test --dump-config
# 完成下面的 profile 配置后启动
dsh --profile document-reader-test
```

必须已有上述兼容范围内的 DSH，以及 `tools`、`fs`、`subprocess` 服务。插件的 npm peerDependencies 不会替你在 profile 中注册这些服务。若使用自己的最小 profile，也需注册工具运行时依赖的 `systemPrompt`。

更新源码后执行 `pnpm install --frozen-lockfile`、`pnpm build` 并重启 profile；Python 锁文件/源码基线变化时，重新运行安装脚本。

## 0.3.4：指定图片直接同步解析

复制 `images[].read_args` 指定图片后，已完成的结果直接从缓存返回；缓存未命中则立即发起独立模型请求，等待解析成功并写入缓存后返回。该请求不进入后台图片队列，不受 `progressive.waitMs` 的短等待限制。失败、取消或超时直接返回明确错误。

同一图片、同一模式的并发读取共用一个同步请求。后台该图已排队或正在解析时，取消该图的后台任务，由同步请求接管；其他图片继续处理。`imageConcurrency` 约束后台图片，同步请求额外执行。保持 0.3.3 的 DSH 兼容范围及 Python 依赖，升级后无需新增配置。详见 [0.3.4 同步读图说明](docs/upgrade-0.3.4.md)。下方 0.3.1 的插队行为为历史记录，以本节为准。

## 0.3.3：放宽 DSH 宿主兼容范围

全部 DSH 宿主依赖改为 `>=0.2.0-rc.2 <0.3.0-0`，接受 0.2.0-rc.2、后续 0.2 系列正式版与预发布版，拒绝更早版本及 0.3.0 的所有预发布版和正式版。Cordis 兼容 4.0.4 与当前 4.0.5-alpha.1 系列；构建依赖仍固定原有基线，不随兼容范围自动升级。Python、读取、搜索、配置及图片优先解析逻辑未变。

停止 DSH，替换源码，执行 `pnpm install --frozen-lockfile`、`pnpm build`，再重启 DSH 并刷新页面。确认插件管理页显示 `0.3.3`。已有 Python 环境无需重装。验证范围见 [0.3.3 兼容性说明](docs/upgrade-0.3.3.md)。

## 0.3.2：适配 DSH 0.2.1-alpha.1

同步升级 DSH 宿主依赖、Cordis、加载器和 Schemastery，并重新生成依赖锁文件。读取、搜索、大型 Word 渐进解析和指定图片优先解析功能保持原有行为；Python 发布包版本和持久缓存格式未变。无需版本豁免，已正常工作的 Python 环境无需重装。

停止 DSH，完整替换源码，执行 `pnpm install --frozen-lockfile`、`pnpm build`，再将新包添加到实际使用的配置档并重启 DSH、刷新页面。请确认插件管理页显示 `0.3.2`。详细步骤与验证范围见 [0.3.2 升级说明](docs/upgrade-0.3.2.md)。

## 0.3.1：指定图片优先解析

通过图片的 `read_args` 指定图片读取时，未开始的任务自动提升优先级；尚未进入搜索批次的图片可直接插队。目标图片完成即可返回，不等待整批搜索。已运行的图片继续执行，识别并发上限保持不变。同一图片、同一模式复用已有任务。详见 [0.3.1 升级说明](docs/upgrade-0.3.1.md)。

## 从 0.2.2 升级到 0.3.0：大型 Word 优化

完整替换源码，执行 `pnpm install --frozen-lockfile`、`pnpm build`，重启 DSH 并刷新页面。Python 依赖版本未变，无需重装已正常工作的环境。

Word 默认先返回正文搜索结果，通过工具返回的 `next_search_args` 分批补全图片文字；搜索不再生成图片语义说明。新增有限并发、重复图片去重、持久检查点、跨重启恢复、文档变更后的图片复用、大图无损切片、稳定定位与图片目录分页。默认完整搜索；明确只查正文时传 `scope: "text"`。

图片未识别完时，结果会显示进度和缺口，不得把零命中解释成全文不存在。已有图片模型开关和手动选择保持不变。持久缓存默认 1 GiB、7 天保留期，可在新配置分组修改或关闭。

完整行为、参数、缓存位置、恢复与限制见 **[0.3.0 使用和升级说明](docs/upgrade-0.3.0.md)**。以下历史说明与新版本有冲突时，以该文档为准。

## 从 0.2.0 / 0.2.1 升级到 0.2.2

本次修复配置页面找不到图片模型的问题。DSH 0.1.7-rc.2 的通用会话模型目录不返回 `inputModalities`（支持的输入类型），0.2.0 错误地据此过滤了全部模型。0.2.1 通过插件只读接口读取模型注册表的实际能力。

0.2.1 的页面还缺少新接口的作用域依赖声明，导致服务商列表请求被 DSH 拒绝。0.2.2 在接口注册后创建明确依赖该接口的页面作用域，修复这一回归。详细原因及验证范围见 [0.2.2 修复说明](docs/upgrade-0.2.2.md)。

停止 DSH，完整更新源码，在插件目录执行 `pnpm install --frozen-lockfile`、`pnpm build`，再重启 DSH 并刷新浏览器。已有插件安装路径不变时无需重新添加插件。无需更改 `llm-pi-ai` 中的 `input: [text, image]` 配置，也无需重装 Python。详见 [0.2.1 修复说明](docs/upgrade-0.2.1.md)。

## 从 0.1.0 / 0.1.1 升级到 0.1.2

停止 DSH，将新源码覆盖原插件目录，在该目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
py -3.12 .\scripts\setup_python.py
dsh plugin --profile web add .
dsh --profile web
```

`web` 是示例 profile（配置档），请替换成实际名称。**本次必须重新运行 Python 安装脚本**：它会将专用环境中的两个源码预发布包替换为指定发布版本，并校验安装结果，不修改全局 Python。若原配置使用自定义环境，给脚本加 `--venv 'D:\你的路径\venv'`，或把配置的 `python.executable` 改为脚本输出的路径。

文档读取/搜索参数保持不变。旧版缺少统一的图片扩展接口，新增 `python/stable_compat.py` 做小范围适配：沿用原生正文转换，将内嵌图片交给既有识别和来源标记流程。扫描图片仍由 markitdown-ocr 0.1.0 的官方识别服务处理。

## 0.1.1 历史升级说明

以下“无需重装 Python”仅适用于 0.1.0 → 0.1.1；升级到 0.1.2 请执行上一节。

本次修复 DSH 0.1.7-rc.2 启动时因 peerDependencies（宿主依赖版本约束）仍为 0.1.6-alpha.2 而跳过插件的问题。同步更新宿主包、Cordis 及其加载器、Schemastery 和依赖锁文件；文档转换逻辑与 Python 依赖未变。无需授予版本豁免。

1. 停止正在运行的 DSH，保留原有配置。
2. 将新源码覆盖原插件目录，必须包含 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。
3. 在插件目录运行以下命令；`web` 是示例 profile（配置档），请替换为实际使用的名称。

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add .
dsh --profile web
```

再次执行添加命令用于确保该配置档引用新的本地包；仅重启不一定会刷新原先安装的副本。此次无需重建已可用的 Python 专用环境。若仍提示 `dsh-document-reader@0.1.0`，说明该配置档仍指向旧包，请核对当前目录和安装目标。

详细修复与验证范围见 [0.1.1 兼容性说明](docs/compatibility-0.1.1.md)。

## 配置

推荐在 DSH 侧栏进入 **插件 → 已安装 → dsh-document-reader → document-reader 行的“配置”**。

1. 先在 **设置 → 模型** 配置好服务商、地址和凭据；对应模型的输入类型必须包含“图片”。
2. 在插件页面将视觉服务来源设为 **使用 DSH 已配置模型**，先选择服务商，再选择图片模型。
3. 按需打开“生成图片内容说明”和“识别图片文字”。二者共用所选模型，可同时开启。
4. 点击 **保存配置**。新文档转换使用新配置，不需要重启 DSH，也不需要重新构建插件。

服务地址、密钥、协议和请求头由 DSH 服务商适配器处理，本插件页面不复制或展示密钥。服务商没有图片模型时会显示空列表；已保存模型被删除后保留原选择并显示“当前不可用”，不会自动换模型。图片能力依赖 DSH 的声明，实际网关是否支持仍以调用结果为准。

模型服务与附件服务只在 DSH 图片识别模式下需要；关闭图片说明与文字识别时，纯文本读取不依赖这两项服务。无前端的命令行环境仍可修改配置文件。

**附件保留：** DSH 图片模式使用原生附件服务。待识别图片可能经过 DSH 的尺寸规范化后存入 DSH 附件目录；DSH 0.2.1-alpha.1 不自动清理这些附件，本插件的临时缓存清理也不会删除它们。模型输入沿用服务商自身的图片限制和投影策略，细小文字识别质量受这些限制影响。

页面的高级设置可以调整 Python、转换、读取、搜索、缓存和视觉限制。保存带有配置版本检查；如果另一个窗口已修改配置，需重新加载后再编辑。当前 DSH 的共享表单可能限制远程浏览器写入，页面会显示只读状态；请使用宿主允许写入的本地连接。

如需直接编辑该配置档的 `cordis.patch.yml`，以下为 DSH 模式示例。文件层按行覆盖整个配置对象，手工修改时保留自己的其他设置；页面保存通过 DSH 字段修改接口完成，无需手写整段覆盖。

```yaml
- id: document-reader
  config:
    vision:
      source: dsh
      enabled: true
      provider: '你的DSH服务商标识'
      model: '该服务商中支持图片的模型标识'
    ocr:
      enabled: true
```

0.1.2 升级后，如果旧配置中已有 `vision.baseURL`，默认继续使用独立模式。要迁移，请在页面显式选择 DSH 模式，再选择服务商与模型。独立模式仍使用 `baseURL` 和 `apiKeyEnv`（密钥环境变量名），只接受兼容 OpenAI 的旧调用方式，不能自动回退到另一种模式。

非渐进路径中，变更模型、图片提示词、图片开关、解析设置或 Python 配置后，新的读取不复用旧转换结果。Word 渐进路径分别管理正文、文字转录和图片说明缓存，见 0.3.0 说明。旧续读参数会明确报告版本失效，需要重新读取或搜索；不会把两套识别结果拼在一起。已开始的转换保持启动时的插件配置快照；如果 DSH 服务商注册发生变化，后续图片请求会拒绝继续，避免自动切换服务。

升级步骤与验证边界见 [0.2.0 变更说明](docs/upgrade-0.2.0.md)。

| 开关 | 行为 |
|---|---|
| 两者关闭 | 只提取原生文字；发现未分析图片时报告缺失 |
| 仅 OCR | 请求文字转录，参与默认搜索 |
| 仅 vision | 请求图像说明，供读取但不参与默认搜索 |
| 两者开启 | 非渐进格式一次请求返回转录与说明；Word 搜索只做转录，说明按需读取 |

非渐进路径中，不符合预期 JSON 字段的图像响应保留为混合说明，标为 partial 并排除搜索；Word 渐进路径标记该图片识别失败，不作为原文搜索。识别转录仍可能出错，来源标记不代表识别正确率。

所有配置及默认值见 [configuration.md](docs/configuration.md)。配置保存后新任务生效；同名模型实际后端变化时，请修改图片缓存版本或清除持久缓存。

## 工具使用

```json
{"file_path":"D:\\docs\\方案.docx"}
```

传给 `read_document`。`offset` 默认 1，表示转换文本行号；`limit` 默认及上限 2000。Word 不提供准确排版页码。后续直接复制 `next_read_args`；搜索后的上下文读取直接复制每个片段的 `read_args`。

```json
{"file_path":"D:\\docs\\方案.pdf","keywords":["故障切换"]}
```

传给 `search_document`。多个关键词默认任一命中；同一范围内全部命中：

```json
{"file_path":"D:\\docs\\方案.pdf","keywords":["主备","切换"],"require_all":true}
```

固定行为：字面包含、忽略大小写、短语不拆词；`C++`、`a.b` 按字面处理。不支持正则、全词、排除词或布尔查询语言。PDF 按物理页，PPTX 按幻灯片，Word 按转换文本块，Excel 按工作表，CSV 按记录，图片按整张图像聚合。

Word 默认首次搜索只等待正文提取，图片文字通过续查分批补全；其他格式首次搜索仍可能需要完成转换/OCR。缓存命中后不再次调用模型。默认一次最多 20 个命中范围，响应最多 50 KiB。`has_more=null` 表示尚未确认后面是否还有命中；若有 `next_search_args`，直接复制继续。cursor 分支仅接受 file_path/cursor，不能同时填写关键词或 offset。

`document_revision` 标识一次转换快照。源文件变化、缓存过期后旧定位可能失效，重启后旧游标不可使用；渐进 Word 的相同正文版本可从持久缓存恢复，但应从新搜索开始；重新查找，不继续使用旧行号。超长单行返回片段及不透明游标，不静默丢字。

`eof=true` 只代表到达转换文本末尾；`scan_complete=true` 只代表已扫描完可搜索内容。partial/warnings 表示已知缺失；`no_known_gaps` 表示未观测到缺口，不能保证所有原始对象均已提取。零结果仅表示在已扫描的已提取文字中未找到。

## 权限、缓存与审批

源字节全部由 `ctx.fs` 读取；Python 不重新打开原始路径。UNC/映射共享盘作为普通文件接受，是否能读由 DSH provider 和操作系统决定；不提供独立账号、网络挂载或共享盘凭证。远程 URL、设备路径、ADS、非普通文件和需要外部资源加载的 Office 文件会拒绝。

活动任务和游标按会话隔离；渐进 Word 成功检查点可跨会话、跨重启复用，仍逐次检查源文件权限。默认小条目留内存，大条目使用随机临时文件；闲置 30 分钟清理，已知 partial 结果创建后 5 分钟过期。session dispose、插件卸载会取消任务并清理。异常断电/SIGKILL 无法保证即时删除；本版本不会自动删除无法确认归属的旧目录。

Windows 创建临时目录后使用附带 PowerShell 脚本设置并验证 ACL，仅当前用户与 SYSTEM 可访问；失败则停止，不降级为宽松权限。POSIX 使用私有随机目录和 0600 文件。解析器内存/压缩展开仍受第三方实现影响，缓存配额不是严格 RSS 上限。

超额文件通过 DSH 原生审批，仅 `allowed-once` 可继续。没有审批服务、被拒绝或取消时停止，不重复转换绕过审批。源输入与结果体积分别明确后，可能分别申请有限的临时额度；已缓存结果的翻页不重复审批。硬上限只能由用户修改配置。

自定义按工具名管控读取的部署需将 `read_document` 和 `search_document` 都加入现有策略；新工具不会自动继承名为 `read` 的规则。

## 构建、测试与打包

```sh
pnpm build
pnpm test
pnpm test:package
# 指定已安装依赖的 Python，启用真实 Loader → FS → subprocess → bridge 集成测试
DOCUMENT_READER_TEST_PYTHON=/absolute/path/venv/bin/python pnpm test
/absolute/path/venv/bin/python -m pip install -r python/requirements-test.txt
/absolute/path/venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/package-source.py
# GitHub-ready 目录压缩包：额外包含 lib，仍不包含依赖或 Python 环境。
pnpm package:github
```

PowerShell 对应环境变量：`$env:DOCUMENT_READER_TEST_PYTHON = 'C:\...\python.exe'`，再执行 `pnpm test`。未设置该变量时，集成测试会明确标为 skipped。

打包脚本只收集源码、锁文件、文档、测试源码和脚本；输出 `dist/dsh-document-reader-0.3.4-source.zip`。需要可安装 npm 归档时，构建后可自行执行 `pnpm pack`。

内网离线部署可在与目标机器相同 OS/架构/Python 的联网环境执行：

```sh
python3.12 scripts/build_wheels.py --output /path/to/wheels
python3.12 scripts/setup_python.py --offline --wheelhouse /path/to/wheels
```

wheelhouse 带 SHA256 清单；纯源码 ZIP 不包含它。Windows wheels 必须在对应目标平台准备，不能直接把 Linux wheelhouse 搬到 Windows。

## 已知限制与后续工作

- 本次实际验证环境为 Linux、Node 24、Python 3.12。Windows 11 安装/ACL、UNC 共享盘和用户现有 Web profile 尚需在目标机器复测；不声称已通过 Windows 集成测试。
- 本地模拟端点验证了模型固定、响应来源与失败处理；未调用真实视觉模型，未评估真实识别准确率。
- 不支持 Word 精确排版页码、Excel 打印页码、PPT 原生矢量连线拓扑和完整 SmartArt；Office 批注/修订/复杂嵌入对象可能不完整。
- V1 只支持本地主机执行，不支持将本地插件路径传给远程 subprocess provider。
- 默认返回 JSON 文本，使用 DSH 通用 Tool 卡片，没有专用 Web 文档预览界面。
- 没有向量库、RAG、语义搜索、自动模型路由或文档写入。

实现与设计的具体对照见 [implementation.md](docs/implementation.md)，验证记录见 [validation.md](docs/validation.md)。
