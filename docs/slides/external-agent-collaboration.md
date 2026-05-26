---
marp: true
title: 智能体系统、评测与实验 Harness 交流材料
description: 基于 pi-agent-minimal-ts 现状与超导量子芯片设计 agent 计划的讨论 slide
paginate: true
---

# 智能体系统、评测与实验 Harness

## 基于 `pi-agent-minimal-ts` 现状与超导量子芯片设计 agent 计划

交流目标：把“能跑的 demo”推进为可复现、可比较、可迭代的研究系统。

---

# 交流定位

这次交流不把系统包装成已经完成的通用设计智能体，而是讨论一个正在形成的研究基础设施：

- 现有基座：论文获取、解析、wiki 知识库、worker 边界、Feishu/RPC 运行、论文写作流程。
- 当前重点：把复杂科研任务拆成可追踪、可评测、可复盘的 agent workflow。
- 领域计划：面向超导量子芯片设计，建设 evidence-first 的 design agent 与 benchmark。
- 合作价值：共同定义任务、过程日志、评测指标和公平比较协议。

---

# 我们关心的核心问题

1. 复杂任务中，agent 如何可靠地进行任务分解、工具调用、状态管理和自我修正？
2. 单智能体、多 worker、多智能体编排在真实任务中的边界是什么？
3. 如何从 demo 走向稳定、可复现、可比较的实验系统？
4. benchmark 是否只评最终答案，还是也评过程质量、成本、鲁棒性、可追踪性和长期稳定性？
5. 实验 harness 如何记录执行过程、中间状态、失败案例，并支持不同模型和架构公平比较？

---

# `pi-agent-minimal-ts` 当前定位

`pi-agent-minimal-ts` 目前更像一个科研 agent harness，而不是单一聊天机器人：

- CLI / JSONL RPC / Feishu bridge 三种运行入口。
- paper acquisition：检索、下载、浏览器扩展、解析、阅读、source metadata。
- wiki agent：source summary、typed synthesis page、claim provenance、typed relation、lint、health。
- worker router：按意图隔离 `paper-download-subagent`、`wiki-evidence-worker`、`paper-writing-worker`。
- public design/code/layout work：走独立 `design-agent`，不进入 wiki-agent/router。
- repo manager：桥接侧管理 paper/design/wiki 工作区的 status、diff、commit、push。

---

# 当前系统边界

```text
CLI / RPC / Feishu bridge
        |
        v
main chat agent / wiki-agent coordinator
        |
        +--> paper-download-subagent  -> acquisition, PDFs, webpages, parses
        +--> wiki-evidence-worker     -> source summaries, fixed-evidence drafts
        +--> wiki-agent               -> durable typed wiki pages
        +--> paper-writing-worker     -> manuscript files, LaTeX compile

design-agent                    -> public design/code/layout artifacts
        |
        v
wiki-agent curates records/artifacts into durable wiki updates
```

设计原则：paper/wiki/writing 工作交给边界清晰的 worker；public design/code/layout work 由独立 `design-agent` 入口处理，wiki-agent 只在后续做记录整理和知识库更新。

---

# 任务分解与工具调用：现有经验

复杂科研任务不是一次性回答，而是链式工作流：

- 获取证据：`search_papers` / `download_paper` / browser extension。
- 结构化输入：`parse_paper` / `inspect_paper` / source summary。
- 固定证据合成：`bootstrap_wiki_page_evidence` / `build_wiki_page`。
- 结构治理：`wiki_lint` / `wiki_structure_plan` / `wiki_health`。
- 设计记录：`write_design_artifact`。
- 写作输出：paper-writing worker 读取 wiki evidence 后编辑 LaTeX 并编译。

讨论点：哪些步骤应该由 planner 自动决定，哪些必须由 harness 明确约束？

---

# 状态管理：从聊天上下文到可审计工作区

当前状态不依赖单次 prompt 记忆，而是落在可检查的持久层：

- `knowledge-base/sources/`：单篇论文或单个来源的 evidence summary。
- `knowledge-base/pages/`：跨来源的 typed synthesis / concept / method / finding 页面。
- `knowledge-base/manifests/`：source summary 与 acquisition、parse、quality artifact 的 provenance。
- `knowledge-base/state/wiki-operations.jsonl`：多文件 wiki 操作日志。
- `design-repo/design-records/`：设计决策、验证报告、失败记录、benchmark case。
- worker handoff：记录 role、instruction、route reason、changed paths、tools used、failed tools、next owner。

---

# 自我修正：不能只靠“让模型再想一遍”

当前更可靠的自我修正来自 harness 可观测性：

- health/lint 把问题显式化：缺失来源、弱证据、坏 frontmatter、破损实验引用、重复页面、下载阻断。
- structure plan 把修复动作变成可审阅、低风险、预算化 action。
- blocklist / access state 区分 license-denied、Cloudflare、manual-login、download-blocked。
- fixed-evidence page construction 把证据获取和页面写作拆开，降低 hallucination。
- worker boundary 让“谁能调用什么工具”成为实验变量，而不是隐含 prompt 约定。

合作问题：如何把这些 correction signals 变成 benchmark 中的过程评分？

---

# 单 agent 与多 agent / 多 worker 的适用边界

单 agent 适合：

- 上下文短、工具少、失败代价低的探索任务。
- 用户需要快速交互式试探，而不是严格可复现比较。

多 worker 适合：

- 工具权限差异明显：下载、写 wiki、写设计记录、写论文不能混在一起。
- 任务需要 fixed evidence：获取证据和合成结论要隔离。
- 过程需要审计：每个 worker 的输入、输出、失败路径都要可记录。

风险：多 worker 会增加路由错误、状态同步、成本归因和 benchmark 设计复杂度。

---

# 从 demo 到实验系统的关键问题

demo 往往只展示最终产物；实验系统必须记录“产物如何产生”：

- 输入快照：模型、prompt、工具面、workspace、evidence fixture。
- 执行轨迹：tool start/end、参数摘要、错误类型、重试、fallback。
- 中间状态：source summary、page draft、lint finding、design record、verification report。
- 失败分类：模型误判、工具失败、证据不足、权限阻断、路径安全、外部网站变化。
- 可复跑协议：同一 case、同一 evidence、同一 harness，替换模型或 agent 架构。

核心观点：agent benchmark 应该评“系统行为”，不只评自然语言答案。

---

# Benchmark：现有方案与局限

当前 repo 已有 wiki page construction benchmark 设计：

- 固定 paper acquisition、parsing、retrieval、source-summary generation。
- 变量只放在 page construction：证据理解、综合、grounding、结构、uncertainty handling、wiki integration。
- case 包含 required evidence、distractor、claim card、expected sections、must-not-assert claims。
- scoring 包括 harness compliance、wiki artifact validity、evidence coverage、uncertainty handling、lint status。

局限：这主要覆盖“固定证据合成”，还不能充分评估长周期设计任务、工具链执行、失败恢复和专家反馈闭环。

---

# Benchmark 不应只评最终答案

建议的多维指标：

- 正确性：最终结论是否被 evidence 支持。
- 过程质量：是否使用了正确工具、正确顺序、正确边界。
- 证据忠实性：是否引用给定 evidence，是否避免 unsupported extrapolation。
- 鲁棒性：遇到下载失败、解析低质、证据冲突、工具错误时是否降级处理。
- 成本：token、wall time、工具调用数、重试次数、人工介入次数。
- 可追踪性：是否能从结论追溯到 source、artifact、tool output、experiment ref。
- 长期稳定性：同一任务跨版本、跨模型、跨日期是否产生可解释差异。

---

# 自动评测、人工评测、LLM-as-judge

自动评测适合：

- schema 合规、工具权限、引用 key、lint issue、路径安全、运行是否超时。
- 固定证据下的 must include / must not assert / source coverage。

人工评测适合：

- 领域判断、设计合理性、实验假设、边界条件、专家可接受性。
- 判断一个 failure record 是否真的暴露了有价值的工程问题。

LLM-as-judge 适合：

- 结构清晰度、冗余度、综合质量、是否回答了问题。
- 不适合作为唯一 pass/fail gate，尤其不能替代 provenance 和 domain checks。

---

# Harness 目标

一个有研究价值的 agent harness 至少要做到：

- 任务定义可版本化：case、input、evidence、expected、scoring 都是文件。
- 工具面可冻结：不同模型看到同样的 allowed/forbidden tools。
- 执行过程可回放：JSONL trace、tool event、workspace diff、failure class。
- 状态可比较：每次运行的 artifacts、lint、health、cost、duration 都可归档。
- 架构可替换：同一 benchmark 可运行 single agent、router-worker、多 agent graph。
- 人工反馈可进入闭环：专家 correction 变成 wiki page、design record 或 benchmark update。

---

# 当前 harness 已具备的基础

已有基础：

- JSONL RPC agent，适合外部 bridge 或实验 runner 驱动。
- `createToolsForBoundary(workspaceDir, role)` 支持 role-isolated tool surface。
- wiki typed schema、retrieval contract、claim provenance、typed relations、experiment refs。
- wiki health/lint/structure plan 支持确定性诊断和低风险修复。
- local wiki web viewer 可浏览页面和 graph。
- paper/design repo manager 能把 agent 产物纳入 Git 流程。

短板：

- benchmark runner 还未完全产品化。
- cost/trace/failure taxonomy 需要进一步规范。
- design-agent 当前主要记录结构化 artifact，直接设计代码能力还很小。

---

# 超导量子芯片设计 agent：正确定位

当前计划不是“让 LLM 独立设计一颗可流片芯片”，而是：

- 面向超导量子芯片设计的 evidence-first agentic infrastructure。
- 把设计任务拆成：需求、假设、文献证据、参数、工具执行、验证报告、失败记录、专家修正。
- 让 design agent 先做 bounded proposal 和 artifact writing，而不是绕过物理仿真、EDA、DRC 或专家审批。
- 以 benchmark 方式推进：paper-to-layout reconstruction、frequency collision、coupler/readout constraint、package/layout check、QEC/layout compatibility。

安全表述：这是“验证导向的设计协作系统原型”，不是完成的自主芯片设计系统。

---

# 领域任务拆解草案

```text
npm run design-agent / design-agent
  -> receive public design/code/layout task
  -> retrieve evidence and source summaries as needed
  -> produce assumptions and parameter schema
  -> call deterministic design / analysis tools
  -> write design record or verification report
  -> run lint / checks / expert review
  -> hand design records/artifacts to wiki-agent
  -> wiki-agent curates wiki updates, failure records, and benchmark cases
```

首批任务建议：

- 固定频率 transmon frequency allocation 与 collision analysis。
- coupler/readout constraints 的 evidence-grounded 约束抽取。
- paper-to-layout reconstruction：只评 evidence coverage 和 uncertainty label，不声称可制造。
- qLDPC / surface-code layout compatibility 的 open-problem mapping。

---

# 设计工作区与知识库分层

设计代码、实验产物和知识记录统一纳入 knowledge-base，但保留不同子目录边界：

- `design-repo/design-code/`
  - Python package：`pi_chip_design`
  - layout family、parameter schema、generator、verification helper、exporter。
- `design-repo/design-artifacts/`
  - generated layout、logs、results、experiment code snapshots。
- `design-repo/design-records/`
  - design record、verification report、failure record、benchmark case。
- `knowledge-base/pages/`
  - 经 wiki-agent curated 的稳定知识、方法、概念和发现。

这让设计资料进入同一个数据飞轮，同时避免把代码、二进制产物、结构化记录和稳定知识页面混在一起。

---

# 建议与外部团队共同讨论的实验协议

1. 定义 3 类任务：
   - fixed-evidence synthesis
   - tool-grounded design/verification
   - long-horizon research workflow
2. 对每类任务约定：
   - 输入格式、工具权限、状态记录、失败分类、评分指标。
3. 同一任务运行多个设置：
   - single agent
   - role-routed worker
   - multi-agent graph
   - different model backends
4. 结果比较：
   - final artifact
   - trace quality
   - cost and latency
   - repairability
   - expert review outcome

---

# 可作为合作切入点的 benchmark case

优先从可控、可复现任务开始：

- Wiki page construction：固定 source summaries，评 synthesis 与 provenance。
- Citation faithfulness：给定 claim cards，检查 supported/refuted/not-enough-info。
- Frequency allocation mini-case：给定 chip graph 与 frequency constraints，评工具调用和 collision report。
- Paper-to-layout reconstruction：给定论文 evidence，生成 uncertainty-labeled reconstruction record。
- Failure recovery：注入 missing parse、download-blocked、conflicting evidence、broken experiment ref，评 agent 降级策略。

这些 case 可以逐步扩展为超导量子芯片设计 agent 的公开 benchmark。

---

# 需要向对方请教的问题

- 他们如何定义 agent trace？是否记录工具参数、模型中间推理摘要、workspace diff？
- 他们的 benchmark 是否区分 model capability 和 harness capability？
- 多 agent 编排中，状态同步和失败恢复如何做归因？
- LLM-as-judge 在他们的体系中承担多大权重？是否有人工专家 calibration？
- 对长期任务，如何防止 benchmark 被一次性 prompt 或固定答案“刷分”？
- 是否愿意共同定义一个 superconducting-chip-design mini-benchmark？

---

# 我们可以贡献的部分

- 一个正在演化的科研 agent harness 实例，而不是纯概念讨论。
- paper -> source summary -> wiki page -> design record -> manuscript 的端到端工作流。
- worker boundary、tool surface、wiki evidence contract、lint/health 的实现经验。
- 超导量子芯片设计方向的早期任务分解、证据地图、benchmark 设想。
- 对“从 demo 到实验系统”的工程问题清单：状态、日志、复跑、失败分类、成本、人工反馈。

---

# 期望合作产出

短期：

- 对齐 agent harness 与 benchmark 的术语和日志格式。
- 共同设计 3-5 个固定证据 benchmark case。
- 交换单 agent / 多 worker / 多 agent 的对照实验结果。

中期：

- 形成一套可复跑的 experiment runner 与 trace schema。
- 在超导量子芯片设计 mini-benchmark 上比较不同 agent 架构。
- 把专家评审意见转为 failure record、wiki update 和 benchmark regression case。

---

# 结束页

核心观点：

> 面向复杂科研与工程任务的 agent 系统，真正的研究对象不是一次漂亮回答，而是可追踪的工作流、可审计的状态、可复现的实验协议，以及能被专家持续修正的知识闭环。

讨论重点：我们能否共同定义一个从固定证据合成走向工具验证设计任务的 agent benchmark？
