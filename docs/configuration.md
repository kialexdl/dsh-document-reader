# 配置参考

初始值由 `src/config.ts` 定义，Tool 调用不得覆盖下列部署配置。

| 组 | 字段及默认值 |
|---|---|
| python | executable 空（自动探测）；startupTimeoutMs 10000；terminateGraceMs 3000 |
| conversion | timeoutMs 300000；maxConcurrent 1；maxSourceMiB 512；maxResultMiB 512；sourceMemoryMiB 8；maxArchiveMiB 1024；maxArchiveEntries 20000；maxMapRecords 100000；pdfDpi 160 |
| read | maxLines 2000；maxBytes 51200 |
| search | maxResults 20；maxBytes 51200；maxKeywords 16；maxKeywordChars 256；snippetChars 240；scanTimeoutMs 5000 |
| cache | memoryEntryMiB 1；memoryTotalMiB 16；maxTotalMiB 256；ttlMinutes 30；partialTtlMinutes 5；sweepIntervalSeconds 60；maxCursors 256 |
| vision | source auto；provider 空；maxImageMiB 20；maxResponseChars 200000；enabled false；baseURL 空；apiKeyEnv VISION_API_KEY；model 空；requestTimeoutMs 60000；maxRetries 1；maxCallsPerDocument 100；prompt 空（使用外置模板） |
| ocr | enabled false |
| progressive | enabled true；imageConcurrency 2；batchImages 16；waitMs 1000；tilePixels 1800；tileOverlap 96；maxTiles 64；maxImagePixels 100000000；persistent true；directory 空；diskMiB 1024；retentionDays 7；ocrPrompt 空；cacheVersion "1" |

大小单位 MiB=1024×1024。大小为正值，次数/行数/时间为正整数（maxRetries 可为 0）；响应 maxBytes 至少 4096。memoryEntry ≤ memoryTotal ≤ maxTotal，partialTTL ≤ TTL。部分结果 TTL 为创建后的绝对时长，不被翻页延长。

maxSourceMiB 限制源文件；maxResultMiB 限制正文加映射；maxArchiveMiB/maxArchiveEntries 在解析 Office 前限制 ZIP 容器展开；它们均不等价于 Python 解析器峰值内存。maxMapRecords 限制位置记录数，超限明确失败，不丢弃剩余记录后声称完整。

maxCallsPerDocument 包含插件发起的模型调用重试尝试；不承诺计数第三方适配器私有传输层内部重试。达到上限后，未分析图像产生 partial/warning。baseURL 只接受 http/https，拒绝内含用户名、密码、query 或 fragment；重定向关闭。自定义 prompt 仍需返回 transcript/description 两个字符串字段，否则作为混合说明处理。

搜索大小写规则由 Node Unicode 正则 `iu` 决定，不读取系统语言区域；查询与文本作 NFC 规范化，保持到原文 UTF-8 字节的映射。Node 升级导致 Unicode 数据版本变化时应复测匹配行为。日期、成本、性能或第三方准确率不由本插件估计。


## 0.2.0 原生配置页面与 DSH 模型

所有配置组均通过 `.volatile()`（运行时可变引用）发布，页面保存使用 DSH 的字段级修改及版本检查。业务层在每次调用时读取快照；文档转换固定使用该快照。缓存容量限制读取当前配置，清理间隔在保存后重新调度。

`vision.source`（视觉服务来源）可为：

- `auto`（自动兼容旧配置）：存在 baseURL 时使用旧独立服务，否则使用 DSH。只用于迁移，不选择服务商或模型。
- `dsh`：使用 `provider` 与 `model` 指定的精确服务商/模型组合。baseURL 和 apiKeyEnv 在此模式下不生效。
- `standalone`（独立模式）：保留旧的独立地址、环境变量凭据与模型配置。

`maxImageMiB` 限制 DSH 管道中单图片字节；`maxResponseChars` 限制 DSH 单次模型文本响应字符数。这两个新增限制不替代独立模式上游库自身的限制。模型调用仍受文档总超时、单请求超时和调用次数控制。

仅 DSH 模型目录中声明支持图片的模型可以在页面选择。调用前复核目录，实际发送时复核 DSH 绑定到该次请求的精确模型能力。服务商变动会让新读取避开旧缓存；转换期间发现注册变化则拒绝继续，不回退到主会话模型。

图片转录与生成说明仍分别标注；格式不符合预期的响应继续按混合说明处理，不纳入默认关键词搜索。调用错误仅返回固定说明和经过限制的机器错误码，不回传上游错误正文或密钥。

## 0.3.0 大型 Word 设置

详见 [渐进处理说明](upgrade-0.3.0.md)。`progressive.enabled=false` 可切回旧 Word 路径。0.3.4 起指定 `image_id`（图片标识）直接同步解析并缓存，不进入后台队列，也不使用 `waitMs` 短等待；`waitMs` 仍用于搜索与块读取。详见 [同步读图说明](upgrade-0.3.4.md)。`ocrPrompt` 独立控制 Word 文字转录，`vision.prompt` 仅控制 Word 按需图片说明，不会因修改说明而使转录缓存失效。`cacheVersion` 用于同名模型后端改变后的手动失效。

`tileOverlap` 必须小于 `tilePixels` 的一半；后台图片并发最多 8，每批图片最多 128；指定图片的同步请求额外执行，不占后台处理名额。渐进路径的单批等待与扫描时间不含首次本地解析时间。后台图片调用预算按每批计算；每个同步图片请求单独计算调用预算与超时，重复同步读取共用同一任务及预算。失败显式可见。持久缓存的清理在写入时执行；磁盘保留期与会话内缓存有效期独立。

动态改变并发、批次和持久化设置，在下一批使用新值；已经开始的批次保持启动时的快照。正文、内嵌原图和读取快照使用临时缓存配额；累计转录和活动切片分别受结果大小上限控制，切片用完即删除。持久检查点有独立磁盘配额。
