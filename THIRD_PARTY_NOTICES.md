# 第三方开源组件与许可说明

核对日期：2026-10-09；插件版本：0.3.4。依据锁定版本的发布包元数据、上游许可文本和实际打包内容核对。

## 本项目与第三方许可的关系

根目录 `LICENSE`（许可证文件）为本项目自身代码的 Apache License 2.0（Apache 2.0 开源许可证）。它不替代第三方组件的许可，也不将上游代码重新许可。`NOTICE`（版权声明文件）记录主要第三方来源；随包保留的许可原文位于 `licenses`（许可目录）。

| 组件 | 固定版本 | 使用方式 | 上游许可与保存位置 |
| --- | --- | --- | --- |
| Microsoft MarkItDown | 0.1.7 | Python 文档转换；由安装脚本另行安装，适配层使用并扩展其转换器 | MIT；[原文](licenses/MarkItDown-MIT.txt) |
| markitdown-ocr | 0.1.0 | 图片文字识别服务及文档图片提取；由安装脚本另行安装 | MIT；[原文](licenses/MarkItDown-MIT.txt) |
| Zod | 4.4.3 | 运行时校验；代码已打包进 `lib/client.js`（前端编译产物） | MIT；[原文](licenses/Zod-MIT.txt) |
| PyMuPDF | 1.28.2 | markitdown-ocr 声明的间接依赖，随 Python 安装流程安装 | GNU AGPL 第 3 版或 Artifex 商业许可；见下节 |

MIT（Massachusetts Institute of Technology，麻省理工学院宽松开源许可证）要求在软件副本或实质性部分中保留上游版权声明与许可声明。仓库已保留 Microsoft 与 Zod 的完整原文，源码包、含预构建产物的包和 npm 安装包都必须包含这些文件。本项目自身代码可继续使用 Apache 2.0。

## 上游来源与版权

### MarkItDown 与 markitdown-ocr

- 上游：[microsoft/markitdown](https://github.com/microsoft/markitdown)。
- 固定版本：[MarkItDown 0.1.7](https://pypi.org/project/markitdown/0.1.7/)、[markitdown-ocr 0.1.0](https://pypi.org/project/markitdown-ocr/0.1.0/)。
- 版权：`Copyright (c) Microsoft Corporation.`（Microsoft 公司版权所有）。
- 保存的原文来源：[v0.1.7/LICENSE](https://github.com/microsoft/markitdown/blob/v0.1.7/LICENSE)；markitdown-ocr 0.1.0 发布包内的许可文本与其相同，除末尾空行差异。

本插件提供独立的 DSH 集成与查询功能，不是 Microsoft 官方发行，也未声称获得其背书。`python/stable_compat.py`（转换适配层）以及桥接模块使用上游转换器和辅助方法；本声明保留相关来源与上游版权。运行时不修改已安装的上游文件。

### Zod

- 上游：[colinhacks/zod](https://github.com/colinhacks/zod)。
- 固定版本：4.4.3。
- 版权：`Copyright (c) 2025 Colin McDonnell`（2025 年 Colin McDonnell 版权所有）。
- 许可原文取自锁定版本安装包内的 `LICENSE`，不是根据通用 MIT 模板自行生成。

## PyMuPDF 的额外许可义务

markitdown-ocr 0.1.0 的发布包元数据明确声明 `pymupdf>=1.24.0`（最低版本约束）；本项目 `python/constraints.lock`（Python 依赖锁文件）将其固定为 1.28.2。上游部分文档处理路径可使用 PyMuPDF，不能因为插件主要调用其他转换路径，就将它从依赖许可审查中忽略。

PyMuPDF / MuPDF 采用 GNU AGPL（GNU Affero General Public License，GNU Affero 通用公共许可证）第 3 版或 Artifex 商业许可。参见 [官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)、[官方许可选择说明](https://pymupdf.io/licensing) 和 [上游完整许可](https://github.com/pymupdf/PyMuPDF/blob/main/COPYING)。

对于受 AGPL 约束的组合应用、再分发和网络使用，应提供适用的许可证、保留版权声明并履行相应源码提供等义务；如果采用商业许可，应取得覆盖实际使用与分发方式的授权。本项目的 Apache 2.0 声明仅描述自身代码的许可，不授予 PyMuPDF 商业许可，也不豁免 AGPL。只公开本仓库或补充致谢，不能自动证明完整部署满足这些义务。

当前发布的插件包不内置 PyMuPDF 代码或二进制，但安装脚本仍会安装此间接依赖。因此本次补充许可文件**不等于完成“全部依赖均为宽松许可证”的整改**。若需要闭源产品集成且不采用商业授权，应先替换或移除该依赖并验证相关功能与完整依赖安装，而不是仅修改许可声明。

## 打包与再分发

1. 源码、GitHub 仓库、预构建包与 npm 包保留 `LICENSE`、`NOTICE`、本文件和 `licenses` 下的许可原文；不能只留下上游链接而删除随包文本。
2. 当前插件包不复制 Python 依赖的第三方源码或二进制；Python 安装脚本从发布源另行安装固定版本。前端包内的 Zod 已单独列明，不能将含预构建产物的包描述为完全不含第三方代码。
3. DSH、其他 Node/Python 外部依赖及其传递依赖仍各自适用原有许可。本文件列出文档转换相关重点和当前实际打包组件，不是所有依赖的完整许可审计报告。
4. 如另行分发离线依赖目录、Python 环境、容器或包含依赖的安装程序，须核对**实际分发版本的全部依赖**，保留其许可、版权及其他必要文件，并处理源码提供等义务；不得从 MIT 主包的许可推断整个依赖树的许可。
5. 更新依赖、前端打包策略或复制上游代码时，应同步更新对应许可文本及本说明，并重新检查打包内容。
