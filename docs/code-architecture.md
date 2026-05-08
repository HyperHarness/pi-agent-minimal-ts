# 代码架构说明

这份文档面向准备参与重构的维护者。范围以 `src/**` 生产代码为主，补充入口命令、测试映射，以及浏览器扩展、脚本、知识库目录如何接入。`dist/**`、`node_modules/**`、下载产物、历史报告和论文项目资料不逐项解释。

## 整体架构

运行层很薄，真正的系统边界在 agent runtime、工具集合、论文/知识库/浏览器/Feishu 子系统之间：

```text
CLI / RPC / Feishu bridge
        |
        v
agent runtime + worker router
        |
        +--> tool registry and boundary profiles
        |
        +--> paper acquisition, parsing, local library, wiki, browser extension
        |
        +--> Feishu transport, memory, PDF delivery, managed repo commands
```

核心原则：

- `src/agent/agent-cli.ts` 负责本地 CLI/RPC 进程形态，`src/agent/agent-runtime.ts` 负责一次 agent turn 怎么运行。
- `src/agent/agent-routing.ts` 在进入默认 main agent 前识别 worker 意图，选择 `paper-download-subagent`、`wiki-evidence-worker`、`design-subagent` 或 `paper-writing-worker`。
- `src/agent/tools.ts` 是工具装配中心，按各领域工具 factory 的命名分组拼出默认/full 工具面；worker 可见工具面的白名单定义在 `src/agent/tool-types.ts`。
- 论文能力分三层：检索/下载由 `paper-manager.ts` 和 `paper-download.ts` 承担，持久记录由 `paper-store.ts` 承担，解析和阅读由 `paper-reader/**` 承担。
- 论文工具适配层位于 `src/agent/paper/tools.ts`，和 paper 领域服务放在同一目录树下。
- Wiki 能力集中在 `src/agent/wiki/**`：store/content/bootstrap/lint/summary/relations/health 是领域服务，`wiki/tools.ts` 是 agent 工具适配层，`wiki/worker.ts` 承载 clean-context evidence worker。
- 浏览器扩展不是 agent runtime 的一部分。agent 通过 `paper-extension-bridge.ts` 写 job；native host `paper-extension-host.ts` 被浏览器调用，再把下载或网页快照登记回本地库。
- Feishu bridge 在 `src/feishu-bridge/**`，它是传输、队列、记忆、PDF 回传和仓库命令边界，不应该承载科学推理逻辑。

## 运行入口

`package.json` scripts 到生产入口的对应关系：

| 命令 | 入口 | 说明 |
| --- | --- | --- |
| `npm run build` | `tsc -p tsconfig.json` | 编译所有 `src/**` 和 `test/**` TypeScript。 |
| `npm test` | `npm run build && node --test ...` | 先构建，再跑 `dist/test/**/*.test.js`。 |
| `npm run agent` | `src/pi-agent.ts` -> `src/agent/agent-cli.ts` | 构建后启动本地 REPL/chat。 |
| `npm run agent:rpc` | `src/pi-agent.ts --mode rpc` -> `src/agent/agent-cli.ts` | JSONL RPC agent，供 Feishu bridge 或其它桥接进程驱动。 |
| `npm run feishu-bridge` | `src/feishu-bridge/index.ts` | 启动 Feishu 长连接桥，并按配置启动/复用 RPC agent。 |
| `npm run wiki:web` | `scripts/wiki-web.mjs` | 本地 wiki 和 graph 浏览器，不在 `src/**` 内，但读取 `knowledge-base/wiki`。 |
| `npm run paper-extension-host` | `src/paper-extension-host.ts` -> `src/agent/paper/extension/paper-extension-host.ts` | 浏览器 native messaging host 的 Node 入口。 |

顶层入口文件：

- `src/pi-agent.ts`: CLI/RPC 直启包装，同时重新导出 prompt、routing、runtime、CLI helper，测试也会从这里验证路由和 REPL 行为。
- `src/index.ts`: package 公共导出面，主要给测试、脚本或外部复用者使用；新增生产模块时先判断是否需要暴露在这里。
- `src/paper-extension-host.ts`: native host 极薄入口，只调用 paper domain extension 子目录中的 `runPaperExtensionNativeHost`。

## 核心数据流

### 普通聊天

1. `src/pi-agent.ts` 调用 `agent-cli.ts` 的 `main()`。
2. `agent-cli.ts` 解析 provider/model/session 参数，创建 `AgentContext`，并把用户输入交给 `runSessionPrompt()`。
3. `agent-runtime.ts` 若没有命中 worker route，则创建运行时工具 `createTools()`，执行 `agentLoop()`，把非失败 turn 写回上下文。
4. REPL 通过 `createReplEventHandler()` 输出 message/tool 事件，并在结束时刷新 paper download queue 统计。

### Worker 路由

1. `agent-runtime.ts` 调用 `routeChatPromptToWorker()`。
2. 若命中，`runRoutedWorkerPrompt()` 用 `createToolsForBoundary()` 创建隔离工具面和干净上下文。
3. worker 正常回包直接流给用户；随后 `createWorkerHandoffMessage()` 把变更路径、产物、工具状态压缩写回 main context。
4. 失败 worker turn 不写入 main context，避免污染后续推理。

### 论文下载

1. `search_papers` 工具进 `paper/tools.ts`，默认调用 `paper-manager.ts` 的 `searchPapers()`，组合 arXiv、APS、通用 web 检索。
2. `download_paper` 调用 `paper-manager.ts` 的 `downloadPaper()`。它先查 blocklist 和本地记录，再按 source 选择 arXiv 直下、supported publisher、extension job 或 manual login。
3. 低层 publisher 下载逻辑在 `paper-download.ts`；Science/Nature/APS 识别在 `publisher-adapters/**`。
4. 下载结果由 `paper-store.ts` 写入 `knowledge-base/raw/papers`、`knowledge-base/raw/pdfs` 和 source metadata。
5. 若需要浏览器扩展，`paper-extension-bridge.ts` 写 queue，`paper-extension-host.ts` 之后登记 PDF bytes、下载路径或网页快照。

### 论文解析

1. `parse_paper` 工具进 `paper/tools.ts`，默认调用 `paper-reader/paper-reader.ts`。
2. `paper-reader-store.ts` 定位 PDF、缓存目录和 parse artifact。
3. `paper-reader.ts` 选择引擎：OpenDataLoader、Docling、TeX source、webpage 或 plain text baseline。
4. `quality.ts` 评估 parse 质量，`chunks.ts` 生成检索块。
5. `paper-store.ts` 把 parse manifest、reading failure 或 queued reading 状态回写到 paper record。

### Wiki 构建

1. `search_paper_wiki`、`write_paper_wiki_source`、`build_wiki_page` 等工具在 `src/agent/wiki/tools.ts`。
2. 持久写入和检索由 `wiki/content.ts` 与 `wiki/store.ts` 承担。
3. `wiki/bootstrap.ts` 从已有 source summary 和 parsed fallback 组装页面证据。
4. `wiki/summary.ts` 读取解析文本并调用 `wiki-evidence-worker` 生成 grounded source summary。
5. `wiki/relations.ts` 维护 source summary 之间的相关论文关系。
6. `wiki/health.ts` 扫描 wiki/source/parse/download 状态并按需触发修复。
7. `wiki/worker.ts` 创建 clean-context summary/page worker，`agent-runtime.ts` 只负责注入它们。

### Feishu 消息

1. `feishu-bridge/index.ts` 加载配置、初始化 Lark client、memory store、RPC client cache 和 per-chat queue。
2. Feishu event 进入后，`message-utils.ts` 提取文本并判断是否响应，`mention-detection.ts` 处理群聊 @。
3. 桥接层先识别 `paper-git.ts` 管理的 repo 命令，否则构造 prompt 交给 `PiRpcClient`。
4. `pi-client.ts` 管理 agent RPC 子进程，`agent-tool-status.ts` 把 tool events 变成可读状态。
5. `stream-updater.ts` 和 `card-builder.ts` 维护流式卡片，`reply-sender.ts` 负责最终回复重试。
6. `pdf-delivery.ts` 从 agent 事件或文本中解析 PDF 附件并回传到 Feishu。

### 浏览器扩展 native host

1. agent 通过 `createPaperExtensionJob()` 追加 job event。
2. 浏览器扩展轮询 native host，native host 用 `parseExtensionHostMessage()` 校验消息。
3. `handleExtensionHostMessage()` 根据消息类型返回 jobs、登记 job status、登记下载 PDF 或登记网页快照。
4. PDF 登记经 `paper-store.ts` 写入 paper record；网页快照经 `paper-webpage-fetch.ts`/`paper-reader/engines/webpage.ts` 保存 parse artifacts。
5. `writeNativeHostManifest()` 写 native host manifest；浏览器端配置在 `extension/paper-downloader/**`，测试在 `test/browser-extension/**`。

## 生产代码文件索引

### 顶层入口

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/pi-agent.ts` | CLI/RPC 主入口和 agent runtime 相关导出。 | `npm run agent`、`npm run agent:rpc`、测试。 | `agent-cli.ts`、`agent-runtime.ts`、`agent-routing.ts`、`agent-prompts.ts`。 | 保持直启判断简单；REPL/RPC 逻辑不要放回顶层。 |
| `src/index.ts` | package 级公共导出面。 | 外部导入者、`test/index.test.ts`。 | 多个 `src/agent/**` 模块。 | 新增导出会扩大公共 API；删除导出前先查测试和脚本。 |
| `src/paper-extension-host.ts` | native messaging host 的直启包装。 | `npm run paper-extension-host`、native host manifest。 | `agent/paper/extension/paper-extension-host.ts`。 | 只保留入口逻辑；协议、登记和 manifest 逻辑应留在 paper domain 模块。 |

### Agent runtime 与工具边界

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/agent-cli.ts` | CLI/RPC 进程、模型解析、REPL 事件格式、session 统计。 | `src/pi-agent.ts`。 | `agent-runtime.ts`、`model-resolver.ts`、`env-proxy.ts`、`paper-download-jobs.ts`、RPC helpers。 | 这是入口层大文件；拆分时优先按 CLI args、REPL formatting、RPC mode、session stats 分组，并保留现有事件文本测试。 |
| `src/agent/agent-runtime.ts` | 单 turn agentLoop、worker route 执行、工具生命周期、失败 turn 处理、瞬时模型错误重试。 | `agent-cli.ts`、顶层导出测试。 | `tools.ts`、`agent-routing.ts`、`paper-extension-bridge.ts`、`wiki/worker.ts`。 | 高耦合点是 routed worker 执行与 runtime tool 注入；改动要同时看 worker handoff、tool cleanup 和失败消息持久化。 |
| `src/agent/agent-routing.ts` | 自然语言/显式前缀到 worker role 的路由，worker handoff 路径提取。 | `agent-runtime.ts`、`src/pi-agent.ts` 导出。 | `agent-prompts.ts`、Pi message type。 | 路由正则会影响用户请求归属；新增工具产物时同步 `extractWorkerHandoffPaths()`。 |
| `src/agent/agent-prompts.ts` | main agent 与各 worker 的 system prompt 常量。 | `agent-routing.ts`、`agent-runtime.ts`、`pi-agent.ts`。 | 无运行时依赖。 | 修改 prompt 等同修改行为；同步 README 中 worker 边界说明和相关路由测试。 |
| `src/agent/tools.ts` | 聚合 file/web/paper/wiki/design/health 工具，提供 full/default profile 与 boundary 工具过滤。 | `agent-runtime.ts`、测试、公共导出。 | `file-tools.ts`、`web-tools.ts`、`paper/tools.ts`、`wiki/tools.ts`、`library-health-tools.ts`、`tool-types.ts`。 | 新工具必须同时考虑默认工具顺序、full profile、cleanup、boundary 白名单和测试；默认顺序应来自领域 factory 的命名分组，避免靠数组 `slice()` 推断。 |
| `src/agent/tool-types.ts` | 工具依赖注入接口、工具集合 metadata 类型、`ToolProfile`、worker role 和各 boundary 可见工具名。 | 各 `*-tools.ts`、`tools.ts`、README/文档。 | paper、wiki、browser、web 相关类型。 | 这是工具契约和安全边界 owner；新增工具不能只在 `tools.ts` 暴露，必须确认哪些 worker 可见。测试替身也从这里进来，改类型时优先保持可选依赖便于单测。 |
| `src/agent/model-resolver.ts` | 从 CLI/env/auth 状态中选择初始 provider/model。 | `agent-cli.ts`、测试。 | `@mariozechner/pi-ai` 类型。 | 这是启动失败诊断热点；修改错误信息会影响用户排查和测试。 |
| `src/agent/env-proxy.ts` | 从环境变量配置 undici 全局代理。 | `agent-cli.ts`、测试。 | `undici`。 | WSL/代理问题常落在这里；保持 env 读取集中。 |

### Agent 工具包装

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/file-tools.ts` | workspace 受限文件读写、列表、删除、文本替换、时间、写作技能加载、LaTeX 编译、设计记录/工件写入工具。 | `tools.ts`、worker boundary。 | Node fs/path/child_process、`wiki/store.ts` 的 filename sanitizer。 | 路径安全是核心；所有写操作必须经过 workspace 校验，CLI trace 依赖工具参数字段。设计工件也留在 workspace 内，避免与论文/wiki 持久目录混淆。 |
| `src/agent/web-tools.ts` | `web_search`、`fetch_url`、`fetch_paper_webpage` 工具包装。 | `tools.ts`。 | `web-search.ts`、`web-fetch.ts`、`paper-webpage-fetch.ts`。 | 区分普通网页抓取与论文网页抓取，避免把 publisher 解析逻辑塞进通用 fetch。 |
| `src/agent/library-health-tools.ts` | 本地论文列表/搜索、wiki health、wiki health fix 的 tool schema。 | `tools.ts`。 | `local-paper-library.ts`、`wiki/health.ts`、`paper-manager.ts`、`wiki/summary.ts`。 | `wiki_health_fix` 会触发下载/解析/总结；测试时优先用依赖注入隔离真实网络。 |

### 论文检索、下载与记录

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/paper/index.ts` | paper domain facade，统一导出论文获取、解析、存储、浏览器和扩展接口。 | `src/index.ts`、外部/测试导入者。 | `paper/**` 子模块和 `knowledge-base.ts` 路径 helper。 | 外部工具优先从这里或明确子域入口导入，避免重新穿透到旧平铺路径。 |
| `src/agent/paper/tools.ts` | 论文检索/下载/blocklist/manual/login/parse/inspect/read/search 的 tool schema 和执行器。 | `tools.ts`、`wiki/tools.ts` 复用部分工具。 | `paper-manager.ts`、`paper-download.ts`、`paper-reader/**`、`paper-store.ts`、browser manager、extension bridge。 | 大文件；拆分时按 search/download/extension/reader 工具拆，但保持 tool name、details shape 和 boundary 测试不变。 |
| `src/agent/paper/acquisition/arxiv.ts` | arXiv ID 解析、HTML URL 构造、搜索和 PDF 下载。 | `paper-manager.ts`、测试。 | Node/fetch。 | arXiv canonical id 会进入 paper key；改规范化逻辑要迁移或兼容旧记录。 |
| `src/agent/paper/acquisition/aps-search.ts` | APS 检索结果解析和搜索。 | `paper-manager.ts`、测试。 | fetch/HTML 解析逻辑。 | APS 站点结构易变；保持 parser 单测覆盖真实样例 HTML。 |
| `src/agent/network.ts` | 网络响应/错误处理小工具。 | 下载和 web 相关模块。 | fetch/Response 类型。 | 保持低层无业务语义，避免散落 publisher 特例。 |
| `src/agent/web-search.ts` | agent 侧 web search provider 调用和结果规范化。 | `web-tools.ts`、`paper-manager.ts`。 | child_process 或外部检索命令。 | 与 Feishu bridge 的 `web/search.ts` 是两套实现；合并前先确认缓存和格式差异。 |
| `src/agent/web-fetch.ts` | 普通网页内容抓取。 | `web-tools.ts`、测试。 | fetch。 | 不承担论文网页结构化解析；论文网页走 `paper-webpage-fetch.ts`。 |
| `src/agent/paper/acquisition/paper-download.ts` | 低层 PDF 下载、publisher canonical id、supported publisher 下载。 | `paper-manager.ts`、`paper/tools.ts`、`paper-extension-host.ts`。 | publisher adapters、fetch、browser/session fallback。 | license/access/Cloudflare 错误分类会影响 fallback 和 blocklist；不要把高层策略塞进这里。 |
| `src/agent/paper/acquisition/paper-manager.ts` | 高层论文检索/下载策略：去重、blocklist、arXiv fallback、publisher/manual/extension flow、APS batch。 | `paper/tools.ts`、`wiki/health.ts`、测试。 | `arxiv.ts`、`aps-search.ts`、`paper-download.ts`、`paper-store.ts`、`paper-blocklist.ts`、`publisher-access-state.ts`、browser/extension。 | 最大业务文件；拆分方向是 search aggregation、candidate ranking、download strategy、publisher fallback、manual registration。每步要保留 result shape。 |
| `src/agent/paper/storage/paper-store.ts` | paper record/source metadata 路径、读写、查重、parse/reading 状态回写。 | `paper-manager.ts`、`paper-reader-store.ts`、`paper-extension-host.ts`、`wiki/health.ts`。 | `knowledge-base.ts`、`paper-types.ts`、Node fs/path/crypto。 | 这是数据格式 owner；改字段要兼容现有 JSON，优先加迁移/宽松读取。 |
| `src/agent/paper/types.ts` | paper source、record、download/search/result 等共享类型。 | paper、reader、wiki、extension 多模块。 | 无运行时依赖。 | 类型是跨子系统契约；重命名状态值会波及测试和持久 JSON。 |
| `src/agent/knowledge-base.ts` | 解析 workspace 下 knowledge-base/raw/wiki 路径。 | store、local library、wiki store。 | Node path。 | 路径布局 owner；不要在各模块硬编码新路径。 |
| `src/agent/paper/storage/knowledge-paths.ts` | paper domain 对 knowledge-base 路径 helper 的 facade。 | `paper/index.ts`、边界测试。 | `knowledge-base.ts`。 | 当前只重导出路径 API；若后续拆 wiki/paper 路径，这里是兼容层。 |
| `src/agent/paper/storage/local-paper-library.ts` | 扫描本地 paper records、parse manifest 和 source summaries，提供 list/search。 | `library-health-tools.ts`、`wiki/health.ts`、`wiki/bootstrap.ts`、`wiki/tools.ts`。 | `knowledge-base.ts`、`paper-download.ts`、reader types。 | 是 wiki/health 的本地索引层；搜索评分变更会影响 evidence bootstrap。 |
| `src/agent/paper/acquisition/paper-blocklist.ts` | 下载 blocklist 读写、匹配和 paper key 推导。 | `paper-manager.ts`、`paper/tools.ts`、`wiki/health.ts`。 | `paper-types.ts`、Node fs/path。 | reason code 是运维语义；`download-blocked` 类健康降级依赖这里的匹配。 |
| `src/agent/paper/acquisition/publisher-access-state.ts` | publisher 访问状态、Cloudflare cooldown 等持久状态。 | `paper-manager.ts`。 | Node fs/path。 | 限流/阻断判断影响是否访问真实 publisher；测试中保持 now/read/write 可注入。 |
| `src/agent/paper/extension/paper-download-jobs.ts` | extension job event log 路径、追加、读取、汇总。 | `paper-manager.ts`、`paper-extension-bridge.ts`、`paper-extension-host.ts`、`agent-cli.ts`。 | `paper-types.ts`、extension protocol 类型。 | 这是队列事件源；新增 status/purpose 要同步 extension protocol 和 browser-extension 测试。 |
| `src/agent/paper/extension/paper-extension-bridge.ts` | agent 侧创建 extension job，并提供 queued bridge 实现。 | `agent-runtime.ts`、`paper-manager.ts`、`paper/tools.ts`。 | `paper-download-jobs.ts`。 | 它只写 queue，不直接和浏览器通信；不要引入 native messaging 进程依赖。 |

### Publisher adapters

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/paper/acquisition/publisher-adapters/types.ts` | publisher adapter 接口。 | `publisher-adapters/index.ts`。 | 无。 | 接口变更要同步所有 adapter。 |
| `src/agent/paper/acquisition/publisher-adapters/index.ts` | 根据输入选择 Science/Nature/APS adapter，并从 HTML 解析 PDF path。 | `paper-download.ts`、测试。 | `science.ts`、`nature.ts`、`aps.ts`。 | 统一入口；新增 publisher 从这里注册。 |
| `src/agent/paper/acquisition/publisher-adapters/science.ts` | Science URL/HTML/PDF 识别规则。 | adapter index。 | adapter types。 | 站点规则易变，先加 fixture 测试再改。 |
| `src/agent/paper/acquisition/publisher-adapters/nature.ts` | Nature URL/HTML/PDF 识别规则。 | adapter index。 | adapter types。 | 与 Nature download/webpage 流程相关，改动后跑 Nature 相关单测。 |
| `src/agent/paper/acquisition/publisher-adapters/aps.ts` | APS URL/HTML/PDF 识别规则。 | adapter index。 | adapter types。 | APS DOI 规范化也在 `paper-download.ts`，两处要一致。 |

### 浏览器与扩展

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/paper/browser/browser-session.ts` | Playwright/CDP/system Chrome 启动、manual login、授权状态分类。 | `paper-manager.ts`、`paper/tools.ts`、测试。 | Playwright、Node child_process/fs。 | 浏览器路径和 profile 逻辑跨 WSL/Windows；改动要跑 browser-session 相关测试。 |
| `src/agent/paper/browser/paper-browser-manager-types.ts` | browser manager HTTP API 类型。 | client/server/discovery。 | 无。 | API 类型要与 client/server 同步。 |
| `src/agent/paper/browser/paper-browser-manager-discovery.ts` | browser manager metadata 文件读写、stale 判断、发现。 | `paper-browser-manager-client.ts`、测试。 | Node fs/path。 | metadata stale 规则影响是否复用浏览器 manager。 |
| `src/agent/paper/browser/paper-browser-manager-client.ts` | 发现或启动 browser manager，并调用 open/download API。 | `paper/tools.ts`、测试。 | discovery、HTTP fetch、child_process。 | 进程启动和 HTTP 调用交织；拆分时保留 spawn result 兼容。 |
| `src/agent/paper/browser/paper-browser-manager-server.ts` | browser manager HTTP server。 | browser manager 进程、测试。 | HTTP、manager types。 | 端口绑定在沙箱可能失败；测试中区分环境限制和逻辑失败。 |
| `src/agent/paper/extension/paper-extension-protocol.ts` | native host 消息/响应类型和 runtime parser。 | `paper-extension-host.ts`、browser-extension 测试。 | `paper-types.ts`。 | 协议契约 owner；新增字段要保持 parser 严格但向后兼容可选字段。 |
| `src/agent/paper/extension/paper-extension-host.ts` | native messaging 编解码、job polling、PDF/bytes/download path 登记、网页快照登记、manifest 写入。 | `src/paper-extension-host.ts`、浏览器 native host、测试。 | protocol、jobs、paper-store、paper-reader、paper-webpage-fetch。 | 大文件；拆分方向是 native framing、message handler、PDF registration、webpage registration、manifest。路径候选和 WSL 兼容要谨慎。 |
| `src/agent/paper/acquisition/paper-webpage-fetch.ts` | 论文网页 HTML 抓取、诊断、Pandoc/LaTeXML markdown 清洗和结构化提取。 | `web-tools.ts`、`paper-extension-host.ts`、reader webpage engine。 | `paper-reader/latexml-markdown.ts`、child_process、fetch。 | 大文件；HTML parser 变动要用 publisher fixture 覆盖 access status、metadata、assets。 |

### 论文阅读与解析

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/paper/reading/types.ts` | 解析文档、section、quality、engine 等 reader 类型和 `PaperReaderError`。 | reader engines、`paper/tools.ts`、wiki/health。 | 无。 | 这是 parse artifact 的类型契约；新增 engine/status 要同步 store 和 tests。 |
| `src/agent/paper/reading/paper-reader.ts` | `parsePaper`、`inspectPaper`、`readPaperSection`、`searchPaperText` 的主编排。 | `paper/tools.ts`、`wiki/summary.ts`、`wiki/health.ts`。 | reader store、engines、quality、chunks。 | 解析 engine 选择和缓存策略集中在这里；改默认 engine 会影响大量行为。 |
| `src/agent/paper/reading/paper-reader-store.ts` | PDF/source 定位、parse artifact 路径、缓存读写、paper key 查找。 | `paper-reader.ts`、`paper-store.ts`、tests。 | `paper-store.ts`、Node fs/path/crypto。 | 保持 repo-managed-path 约束；外部路径放开会扩大安全面。 |
| `src/agent/paper/reading/quality.ts` | Markdown/section parse 质量评分。 | `paper-reader.ts`、`webpage.ts`、`wiki/health.ts`。 | reader types。 | 健康检查和总结 gating 依赖评分阈值；改评分要同步测试预期。 |
| `src/agent/paper/reading/chunks.ts` | 从 parsed document 生成检索 chunks。 | `paper-reader.ts`。 | reader types。 | chunk id 和位置字段影响 `search_paper_text` 结果。 |
| `src/agent/paper/reading/latexml-markdown.ts` | HTML entity 解码和 LaTeXML/Pandoc markdown 清洗。 | `paper-webpage-fetch.ts`、webpage engine。 | 无。 | 清洗规则太激进会破坏公式和引用；用 fixture 回归。 |
| `src/agent/paper/reading/engines/opendataloader.ts` | OpenDataLoader local/hybrid 解析。 | `paper-reader.ts`。 | child_process、reader types。 | 外部工具依赖可能缺失；错误应可诊断并允许 fallback。 |
| `src/agent/paper/reading/engines/docling.ts` | Docling 解析。 | `paper-reader.ts`。 | child_process、reader types。 | 同样是外部工具边界；保持失败信息具体。 |
| `src/agent/paper/reading/engines/tex-source.ts` | arXiv/TeX source 解析为文档结构。 | `paper-reader.ts`。 | Node fs/path、reader types。 | TeX 解析启发式多，改动需覆盖章节、公式、参考文献样例。 |
| `src/agent/paper/reading/engines/plain-text-baseline.ts` | PDF 文本 baseline 解析。 | `paper-reader.ts` fallback。 | child_process、reader types。 | 是兜底引擎；宁可低质量也要稳定返回可诊断 artifact。 |
| `src/agent/paper/reading/engines/webpage.ts` | 保存网页快照解析 artifact。 | `paper-extension-host.ts`、`paper-reader.ts`。 | `paper-webpage-fetch.ts` 类型、quality、store。 | 与 extension webpage snapshot 协议联动；quality 字段要兼容。 |

### Wiki、source summary 与健康检查

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/agent/wiki/index.ts` | wiki domain facade，统一导出 source/page/bootstrap/lint/summary/relations/health/worker API。 | `src/index.ts`、边界测试、外部复用者。 | `wiki/**` 子模块。 | 外部导入优先走这里或明确子域入口，避免重新形成散落路径。 |
| `src/agent/wiki/types.ts` | wiki source/page/search/bootstrap/worker 类型。 | wiki tools、content、bootstrap、worker。 | 无。 | Worker JSON 输出契约在这里；字段变动要同步 prompt 和 parser。 |
| `src/agent/wiki/store.ts` | wiki 目录、source/page/assets/manifests/state 路径和 scaffold。 | `content.ts`、`tools.ts`、`file-tools.ts` 的设计工件写入。 | `knowledge-base.ts`、Node fs/path。 | Wiki 路径 owner；共享文档要避免写死用户 home 路径。 |
| `src/agent/wiki/content.ts` | 写 source summary、写 synthesis page、alias merge、wiki 搜索。 | `wiki/tools.ts`、`wiki/summary.ts`、tests。 | wiki store、types、paper reader store、Node fs。 | Source/page 文件格式 owner；搜索索引简单但被 answer/build flows 依赖。 |
| `src/agent/wiki/bootstrap.ts` | 为新 wiki page 构建固定 evidence 包和 seed queries。 | `wiki/tools.ts`、tests。 | `local-paper-library.ts`、`wiki/content.ts`。 | 这是 no-page-yet bootstrap 入口；改 seed query 会改变页面覆盖范围。 |
| `src/agent/wiki/lint.ts` | Wiki 结构和引用健康 lint。 | `wiki/tools.ts`、tests。 | wiki store、wiki types。 | lint severity 会影响 agent 修复建议；保持 issue kind 稳定。 |
| `src/agent/wiki/summary.ts` | 从 parsed paper 构建 summary evidence，调用 worker 生成/写入 source summary。 | `wiki/tools.ts`、`library-health-tools.ts`、`wiki/health.ts`。 | `paper-reader.ts`、`wiki/content.ts`、`local-paper-library.ts`。 | 证据截断和 worker confidence gating 是质量关键；不要让 worker 无证据扩写。 |
| `src/agent/wiki/relations.ts` | 发现和更新 source summary 的 related paper keys。 | `wiki/tools.ts`、`wiki/summary.ts`。 | `local-paper-library.ts`、`wiki/store.ts`。 | 关系评分会影响知识图谱；写入模式 append/replace 要保留。 |
| `src/agent/wiki/health.ts` | 检查/修复 wiki、parse、summary、download 状态。 | `library-health-tools.ts`、tests。 | `local-paper-library.ts`、`paper-manager.ts`、`paper-reader.ts`、`paper-blocklist.ts`、`wiki/lint.ts`。 | 大文件；download-blocked 降级、自动下载、自动总结都在这里，拆分时保持 issue kind/status 稳定。 |
| `src/agent/wiki/tools.ts` | Wiki source/page/relations/health answer/research/bootstrap/build/alias 相关工具编排。 | `tools.ts`。 | `wiki/**` 领域服务、`local-paper-library.ts`、`paper/tools.ts`。 | 最大耦合文件；优先拆分为 source tools、page tools、research-answer flow、topic expansion，同时保留外部证据禁用开关。 |
| `src/agent/wiki/worker.ts` | 创建 clean-context `wiki-evidence-worker` summary/page 子任务，并解析 worker JSON 输出。 | `agent-runtime.ts`。 | `agent-prompts.ts`、`tools.ts` boundary、`agentLoop`。 | 递归工具过滤是关键，不能让 worker 直接调用 `generate_paper_wiki_summary` 或 `build_wiki_page` 形成自递归。 |

### Feishu bridge

| 文件 | 职责 | 上游调用者 | 下游依赖 | 重构注意点 |
| --- | --- | --- | --- | --- |
| `src/feishu-bridge/index.ts` | Feishu 长连接主流程、消息队列、RPC client 管理、streaming reply、repo command/PDF delivery/memory 编排。 | `npm run feishu-bridge`。 | 几乎所有 `feishu-bridge/**` helper、Lark SDK。 | 最大桥接文件；拆分优先按 event parse、agent invocation、reply rendering、side effects。不要放入领域推理。 |
| `src/feishu-bridge/config.ts` | `.env`/环境变量配置加载，含 Windows env 读取。 | `index.ts`、tests。 | Node fs/path/child_process。 | 配置名是部署契约；改默认值要同步 env example 和 README。 |
| `src/feishu-bridge/types.ts` | bridge 内部 incoming message 类型。 | `index.ts`、session/memory helper。 | 无。 | 保持 ParsedIncomingMessage 稳定，避免影响 per-chat session key。 |
| `src/feishu-bridge/colors.ts` | 控制台颜色和日志 helper。 | `index.ts`。 | 无。 | 只做呈现，不承载逻辑。 |
| `src/feishu-bridge/chat-queue.ts` | per-key 串行队列。 | `index.ts`、tests。 | 无。 | 群聊/私聊并发顺序依赖它；避免引入全局阻塞。 |
| `src/feishu-bridge/pi-client.ts` | JSONL RPC agent 子进程 client，事件解析和命令发送。 | `index.ts`、tests。 | Node child_process/events。 | 与 `agent-cli.ts` RPC event 协议强耦合；新增 event 要双边测试。 |
| `src/feishu-bridge/pi-client-retry.ts` | 启动 PiRpcClient 的重试包装。 | `index.ts`、tests。 | `pi-client.ts`。 | 保持只处理启动重试，不吞掉长期运行错误。 |
| `src/feishu-bridge/pi-session.ts` | 按消息解析 agent session dir、client options 和 client key。 | `index.ts`、tests。 | bridge types。 | session key 变化会影响上下文隔离和记忆复用。 |
| `src/feishu-bridge/agent-tool-status.ts` | 将 RPC tool events 格式化为 Feishu 进度状态。 | `index.ts`、tests。 | `pi-client.ts` 事件类型。 | UI 文案改动会影响可观测性测试。 |
| `src/feishu-bridge/agent-web-search.ts` | 旧式 agent web search follow-up 指令和结果包装。 | `index.ts`。 | `web/search.ts`。 | 与 agent 自身工具检索不同；合并前先确认桥接 fallback 语义。 |
| `src/feishu-bridge/paper-git.ts` | Feishu 侧 managed repo status/diff/log/commit/push 和自动提交。 | `index.ts`、tests。 | child_process、fs。 | 这是桥接侧服务，不是 LLM tool；保持仓库命令受配置限制。 |
| `src/feishu-bridge/web/search.ts` | Feishu bridge 独立 web search、缓存 key、Jina/DuckDuckGo 解析和格式化。 | `agent-web-search.ts`、`index.ts`。 | child_process/fetch。 | 不要误认为 agent 工具 `web-search.ts`；两者测试分开。 |
| `src/feishu-bridge/feishu/message-utils.ts` | Feishu 消息文本提取、@ stripping、是否响应、prompt 构造。 | `index.ts`、tests。 | 无。 | 群聊触发规则敏感；mention metadata 由 `mention-detection.ts` 补充。 |
| `src/feishu-bridge/feishu/mention-detection.ts` | 检测 bot mention，信任 Feishu mention metadata。 | `index.ts`、tests。 | 无。 | 群 @ 修复热点；`mentioned_type:"bot"` 应优先于 open_id 猜测。 |
| `src/feishu-bridge/feishu/sender-name.ts` | 获取/解析 Feishu sender display name。 | `index.ts`、tests。 | Lark client。 | 失败时应降级，不阻断回复。 |
| `src/feishu-bridge/feishu/card-builder.ts` | 生成 Feishu thinking/status/stream/error card JSON。 | `index.ts`、tests。 | 无。 | 卡片 JSON 字段变动需跑 card 测试。 |
| `src/feishu-bridge/feishu/stream-updater.ts` | 流式卡片更新节流/状态管理。 | `index.ts`、tests。 | 无。 | 避免过频 API 调用；异常要允许最终文本回复兜底。 |
| `src/feishu-bridge/feishu/reply-sender.ts` | Feishu 回复发送与错误解析/重试。 | `index.ts`、tests。 | Lark client。 | API 错误分类影响重试和日志。 |
| `src/feishu-bridge/feishu/long-message.ts` | 长文本分片。 | `index.ts`、tests。 | 无。 | 分片要保持 markdown/链接基本可读。 |
| `src/feishu-bridge/feishu/pdf-delivery.ts` | 从 agent event/text/config 解析和回传 PDF 附件。 | `index.ts`、tests。 | Node fs/path。 | 路径必须受 workspace/config 限制，避免任意文件泄露。 |
| `src/feishu-bridge/memory/chat-memory.ts` | per-chat 短期历史存储。 | `index.ts`、tests。 | Node fs/path。 | prompt_history 和 stored_history 区分很重要，避免 assistant 回复回灌。 |
| `src/feishu-bridge/memory/long-term-memory.ts` | 长期 fact/preference 存储。 | `index.ts`、tests。 | Node fs/path。 | 只存可持久事实，不要写入敏感信息。 |
| `src/feishu-bridge/memory/key-memory.ts` | 关键记忆候选提取和 key-based store。 | `index.ts`、tests。 | Node fs/path。 | 提取规则影响长期偏好质量；保持可解释。 |
| `src/feishu-bridge/memory/extractors.ts` | 从文本提取 durable user/group facts。 | `index.ts`、tests。 | 无。 | 规则应保守，避免把临时聊天当长期事实。 |
| `src/feishu-bridge/memory/debug.ts` | memory debug 行格式化。 | `index.ts`、tests。 | memory 类型。 | 调试输出要避免泄露敏感路径或密钥。 |

## 测试映射

按生产模块优先看的测试：

- Runtime/CLI/router/tools: `test/agent/pi-agent.test.ts`、`test/agent/tools.test.ts`、`test/agent/tools-extension.test.ts`、`test/agent/model-resolver.test.ts`、`test/agent/env-proxy.test.ts`、`test/index.test.ts`。
- 论文检索/下载/store/blocklist/jobs: `test/agent/arxiv.test.ts`、`test/agent/aps-search.test.ts`、`test/agent/paper-download.test.ts`、`test/agent/paper-manager.test.ts`、`test/agent/paper-manager-extension.test.ts`、`test/agent/paper-store.test.ts`、`test/agent/paper-download-jobs.test.ts`、`test/agent/publisher-adapters/index.test.ts`。
- 浏览器和扩展: `test/agent/browser-session.test.ts`、`test/agent/browser-session-runtime.test.ts`、`test/agent/paper-browser-manager-client.test.ts`、`test/agent/paper-browser-manager-discovery.test.ts`、`test/agent/paper-browser-manager-server.test.ts`、`test/agent/paper-extension-host.test.ts`、`test/agent/paper-extension-host-registration.test.ts`、`test/agent/paper-extension-protocol.test.ts`、`test/browser-extension/paper-downloader.test.mjs`。
- 论文解析/阅读/网页: `test/agent/paper-reader.test.ts`、`test/agent/paper-webpage-fetch.test.ts`、`test/agent/local-paper-library.test.ts`。
- Wiki/source/relations/health: `test/agent/wiki-domain-boundary.test.ts`、`test/agent/paper-summary.test.ts`、`test/agent/paper-relations.test.ts`、`test/agent/wiki-health.test.ts`、`test/agent/local-paper-library.test.ts`、`test/agent/tools.test.ts`。
- Web 工具: `test/agent/web-fetch.test.ts`、`test/agent/web-search.test.ts`。
- Feishu bridge: `test/feishu-bridge/*.test.ts`，按文件名基本一一对应 `src/feishu-bridge/**`；主流程相关优先看 `pi-client.test.ts`、`pi-session.test.ts`、`agent-tool-status.test.ts`、`mention-detection.test.ts`、`message-utils.test.ts`、`paper-git.test.ts`、`pdf-delivery.test.ts`、`config.test.ts`。

## 重构切入建议

- `src/agent/paper/acquisition/paper-manager.ts`: 先抽纯函数和策略对象，不先动持久 JSON 格式。建议切为 search aggregation、candidate ranking、download orchestration、publisher fallback、manual registration。
- `src/agent/paper/storage/paper-store.ts`: 先补数据格式 fixture，再动路径和 record schema。任何字段改名都要支持旧记录读取。
- `src/agent/wiki/tools.ts`: 先按工具族拆分 helper，保留 public tool names 和 details shape。`answer_research_question` 与 `build_wiki_page` 的外部证据开关是关键边界。
- `src/agent/paper/extension/paper-extension-host.ts`: 先拆 native framing、protocol handling、PDF registration、webpage snapshot registration、manifest writer。每一步都要跑 extension host 和 browser-extension 测试。
- `src/feishu-bridge/index.ts`: 先抽无状态 helper，不改变消息队列、memory、RPC client cache 的生命周期。桥接层不要吸收 agent/domain 逻辑。
- `src/agent/agent-cli.ts`: 可拆 CLI args、RPC mode、REPL event formatting、session stats；改 `[tool:start]`/`[tool:end]` 文本前先看 `test/agent/pi-agent.test.ts`。

重构前的最低验证建议：

1. 改 runtime/tools/router: 跑 `npm test`。
2. 改 extension/native host: 跑 `npm test` 加 `test/browser-extension/paper-downloader.test.mjs` 覆盖。
3. 改 docs-only: 跑 `npm run build`，并做 `src/**` 路径覆盖检查。
