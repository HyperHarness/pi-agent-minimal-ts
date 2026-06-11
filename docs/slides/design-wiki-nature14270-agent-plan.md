---
title: "Design-Wiki for Nature14270 Layout Reproduction"
subtitle: "Agent development plan for a 9-qubit superconducting-chip data flywheel"
author: "pi-agent-minimal-ts planning deck"
date: "2026-05-28"
lang: zh-CN
---

# 目标

把 `nature14270` 变成第一个可重复运行的 agent benchmark：

- `wiki-agent` 读取本地论文、补充材料和图像资产
- `wiki-agent` 抽取芯片设计约束和证据映射
- `design-agent` 根据抽取结果生成 Layout IR、代码、GDS 和验证报告
- `wiki-agent` 总结成功、失败和规则，沉淀为可检索 wiki
- 下一篇论文或下一轮修正复用这些结构化记录

核心原则：主要任务由 agent 完成，我只开发能力、协议、测试和验收标准。

# 为什么选 Nature14270

`nature14270` 是合适的第一篇 benchmark：

- 目标明确：一维 9-qubit repetition code
- 器件明确：9 个 Xmon transmon qubits
- 拓扑明确：5 个 data qubits + 4 个 measurement qubits，交替排列
- 连接明确：nearest-neighbour coupling
- 证据丰富：主文、Figure 1、supplement、Table S3、readout/filter/fabrication 说明
- 边界清楚：适合做 paper-faithful reconstruction，不适合直接声称 mask-ready

官方页面：`https://www.nature.com/articles/nature14270`

# 本地证据状态

当前知识库中已有 `nature-nature14270`：

- `metadata.json`：标题、DOI、作者、citation、tags、artifact paths 完整
- `acquisition.json`：Nature URL、PDF、webpage parse、supplemental material 记录
- `parses/webpage/document.md`：主文 markdown，质量状态 good
- `parses/docling/supplement.md`：补充材料解析
- `parses/webpage/assets/`：论文图像资产
- `summary.md`：已经有论文摘要和关键结论

这意味着第一阶段不需要解决下载问题，而要解决“设计抽取和执行闭环”。

# 已开发：系统边界

当前 repo 已有清晰的公共边界：

- `wiki-agent`
  - 负责论文、wiki、source summary、evidence、页面治理
  - 可读 design-agent 输出
  - 不直接编辑 design-code、不运行 layout 脚本
- `design-agent`
  - 负责 design-code、Python 依赖、layout 脚本、GDS、设计记录和验证
  - 可读本地 wiki/paper evidence
  - 不写 wiki 页面、不下载论文、不 web search
- Feishu bridge 默认连接 `wiki-agent:rpc`

这个边界适合数据飞轮：执行和知识沉淀分离。

# 已开发：Wiki / Paper 能力

当前已具备：

- paper search/download/parse/read/search
- source metadata、summary、acquisition record
- webpage parse 和 supplemental material parse
- source summary 生成
- typed wiki page schema
- claim provenance、knowledge state、freshness、typed relations
- wiki health / lint / review / structure plan
- evidence worker / paper download worker / paper writing worker 边界

不足：还没有“从论文抽取芯片设计约束”的专门 workflow。

# 已开发：Design-Agent 能力

当前 `design-agent` 已具备：

- `write_design_code_file`
- `replace_design_code_file_text`
- `update_design_dependency`
- `sync_design_environment`
- `verify_design_python_import`
- `run_design_script`
- `submit_design_simulation`
- `write_design_artifact`

设计侧可以写代码、同步 `uv` 环境、运行 Python/KLayout 脚本、提交 Q3D-like remote simulation、写 design records。

# 已开发：Design-Code 基础

`design-repo/design-code/` 已经是一个 Python design package：

- `core/`：backend-independent layout model 和 layer definitions
- `backends/`：`gdstk` backend、Quantum Metal backend
- `templates/`：single transmon、10-qubit concept
- `layouts/`：可执行 layout entrypoints
- `simulation/`：Q3D capacitance manifest、remote solver protocol
- `tests/`：template、GDS renderer、simulation manifest、remote solver 测试

已有能力证明 agent 可以产出真实 artifact，不只是写说明。

# 已开发：已有设计记录

已有记录说明方向正确，但也暴露治理问题：

- `single-xmon-concept`：已有 KLayout script + GDS + manifest
- `ten_qubit_chip_concept`：已有 10-qubit conceptual layout record
- `superconducting_chip_kb_sufficiency_assessment`：已记录当前知识不足以支持可投片设计
- `paper-to-chip-layout-benchmark-idea`：已有 paper-to-layout benchmark 雏形

需要修正：旧记录中仍有历史路径和非统一记录结构，不能作为长期 flywheel contract。

# 当前缺口

离 “agent 自己复现 Nature14270 版图” 还缺：

- 设计抽取 schema：论文内容如何变成机器可读设计约束
- Layout IR：抽取结果如何变成可检查、可渲染布局
- Evidence map：每个设计选择来自哪一段、哪张图、哪张表
- Uncertainty policy：缺失尺寸和推断必须显式标注
- Verifier：检查 9 qubits、5 data、4 measurement、8 couplings、readout/control 等
- Handoff contract：design-agent 输出如何被 wiki-agent 消化
- Benchmark scoring：如何判断 agent 真的比上轮更好

# 目标产物

第一条完整 flywheel 应产出：

- `nature14270-extraction.json`
- `nature14270-layout-ir.json`
- `nature14270-repetition-code.py`
- `nature14270-repetition-code.gds`
- `nature14270-verification.json`
- `nature14270-verification.md`
- `nature14270-wiki-followup.md`
- wiki pages：method、dataset、finding、design-record

这些文件不是手工填答案，而是 agent workflow 的输出和回归测试对象。

# 关键设计：Extraction Schema

`wiki-agent` 要先输出结构化抽取：

```json
{
  "sourceKey": "nature-nature14270",
  "device": {
    "qubitCount": 9,
    "qubitType": "Xmon transmon",
    "architecture": "linear repetition code"
  },
  "roles": [],
  "couplingGraph": [],
  "readout": {},
  "fabrication": {},
  "parameters": {},
  "evidenceMap": [],
  "unknowns": []
}
```

核心要求：unknown 比 hallucination 好。

# 关键设计：Layout IR

`design-agent` 不应直接从自然语言写 GDS。

推荐中间层：

- `components`：qubits、readout resonators、filter、ports、markers
- `routes`：couplers、XY、Z、readout feedline、ground bridges
- `layers`：metal、junction、control、readout、crossover、label
- `parameters`：frequency、coupling、resonator、fabrication notes
- `assumptions`：论文未给出的尺寸和位置
- `evidenceRefs`：每个组件和参数的来源

GDS 是 IR 的渲染结果，不是唯一真相。

# 关键设计：Verifier

v0 verifier 检查结构正确：

- qubit_count = 9
- data qubits = 5
- measurement qubits = 4
- linear alternating pattern
- nearest-neighbour coupling edges = 8
- every qubit has control/readout representation
- Table S3 参数被映射或明确标注缺失
- all inferred geometry has assumptions
- GDS file exists and can be parsed

v1 verifier 增加 DRC-like checks 和 topology-to-GDS consistency。

# Agent 工作流

```text
wiki-agent
  read source metadata + webpage parse + supplement parse + figures
  -> write extraction.json
  -> mark unknowns and evidence refs

design-agent
  read extraction.json
  -> write layout_ir.json
  -> write/update design-code template
  -> run script and produce GDS
  -> run verifier and write records

wiki-agent
  read design records
  -> summarize reusable rules
  -> update wiki pages and benchmark state
```

这个工作流是要开发出来并让 agent 运行，不由人工代跑主流程。

# 阶段 0：Benchmark Contract

目标：把 Nature14270 定义成固定 benchmark。

要做：

- 新增 benchmark case 文档
- 定义 extraction schema
- 定义 layout IR schema
- 定义 verifier 输出格式
- 定义 scoring rubric
- 定义人工 correction JSONL 格式

验收：

- 不需要生成 GDS
- 能清楚说明哪些输出由 wiki-agent 产生，哪些由 design-agent 产生
- 能作为后续自动化测试的输入

# 阶段 1：Wiki-Agent 抽取能力

目标：让 `wiki-agent` 从本地 source 自动生成 design extraction。

要做：

- 新增 paper-to-design-extraction workflow
- 读取主文、补充材料、图像资产索引
- 抽取 device topology、role assignment、parameter tables、fabrication notes
- 写 `nature14270-extraction.json`
- 写缺失项和不确定性

验收：

- 输出中不出现无证据尺寸
- 每个关键字段有 source locator
- 能复跑并保持稳定结构

# 阶段 2：Design-Agent 布局生成

目标：让 `design-agent` 从 extraction 生成可执行布局。

要做：

- 新增 9-qubit Xmon repetition-code template
- 支持从 Layout IR 构造 layout model
- 生成 GDS 和 layout summary
- 保持 `design-repo/design-code/` 边界
- 写 design artifact manifest

验收：

- agent 自己写代码并运行脚本
- 产物包含 GDS + IR + summary
- topology verifier 通过

# 阶段 3：验证和闭环总结

目标：让结果进入数据飞轮，而不是只留下 GDS。

要做：

- 新增 topology verifier
- 新增 evidence verifier
- 新增 GDS parse/check
- `wiki-agent` 读取 verification records
- 生成 method/dataset/finding/design-record wiki pages
- 将失败写入 benchmark state

验收：

- 错误会变成 failure record 或 correction request
- wiki 页面引用 design records 和 source evidence
- 下一轮运行会读取已有经验

# 阶段 4：从一篇论文扩展到多篇

目标：验证 flywheel 是否真的复用知识。

要做：

- 选择第二篇有 chip layout / micrograph / parameter table 的论文
- 跑相同 workflow
- 比较抽取质量、unknown 数量、verifier failure 类型
- 更新通用 Xmon / readout / frequency planning 页面
- 建立 benchmark leaderboard

验收：

- 第二篇论文不需要重新设计全部 schema
- 常见错误数量下降
- human correction 可被后续复用

# 风险与边界

不能过度承诺：

- 论文通常不足以复现 mask-ready layout
- Figure micrograph 不能自动给出所有尺寸
- PDK、junction process、airbridge rules、packaging details 往往不完整
- Q3D/HFSS 验证只能从局部结构开始

可承诺：

- paper-faithful reconstruction
- topology-faithful layout
- evidence-backed assumptions
- reproducible IR / code / GDS / verification records

# 近期里程碑

第 1 周：

- benchmark contract
- extraction schema
- layout IR schema
- verifier schema

第 2 周：

- wiki-agent design extraction workflow
- Nature14270 first extraction run
- correction file format

第 3 周：

- design-agent Nature14270 layout template
- GDS generation
- topology verifier

第 4 周：

- wiki summary pages
- benchmark report
- second-paper readiness review

# 成功标准

最小成功：

- agent 产出 Nature14270 extraction、IR、GDS 和 verification
- verification 明确通过和失败项
- wiki-agent 归纳 reusable rules

真正成功：

- 第二篇论文复用同一流程
- 人工 correction 被记录并影响下一轮
- benchmark 分数和失败类型可追踪
- design-agent 越来越少依赖人工解释论文

# 下一步

下一步不做具体版图开发，先做 planning-to-implementation handoff：

- 把本 PPT 作为路线图
- 另写一份开发计划文档，拆成 PR-sized tasks
- 第一项实现只做 schema + benchmark contract
- 后续每个阶段都要求 agent 自己跑 Nature14270

判断标准：每次开发都让 agent 多承担一点任务，而不是让人工多填一点答案。
