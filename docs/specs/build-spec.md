# Build: Open-Source Intelligent Multi-Model Agent Orchestrator

## 1. Project Overview

Build an open-source, model-agnostic AI orchestration system that enables existing AI coding agents, IDEs, and agent harnesses to automatically decompose a single natural-language prompt into multiple independent or dependent tasks, assign each task to the most cost-effective capable AI model, execute tasks concurrently where possible, and dynamically adjust model selection based on task progress, complexity, and execution results.

The system should act as an intelligent orchestration layer that works alongside existing AI coding tools rather than replacing them.

**The fundamental user experience:**

A developer submits ONE prompt to their existing AI coding assistant.

The orchestration system automatically:
1. Understands the overall objective.
2. Breaks the prompt into granular tasks.
3. Determines the expertise and capabilities required for each task.
4. Discovers available models and their capabilities.
5. Selects the cheapest model capable of completing each task reliably.
6. Delegates tasks to different agents and models.
7. Executes independent tasks concurrently.
8. Manages task dependencies and shared context.
9. Monitors execution progress and task difficulty.
10. Dynamically upgrades or downgrades models when appropriate.
11. Validates individual task results.
12. Integrates completed work into one coherent result.
13. Reports what was completed, which models were used, and the total cost.

The user should not need to manually select models, define agent roles, or create workflows.

**This is not a multi-model chat application. It is an intelligent task-level model orchestration engine.**

---

# 2. Core Product Principles

### Model agnostic
Support multiple AI providers and model families without hardcoding dependencies on a particular provider.

### Harness agnostic
Work with existing AI coding harnesses, including Claude Code, OpenAI Codex, Cursor, Windsurf, Kilo Code, VS Code, GitHub Copilot, and other compatible tools.

### Task-level intelligence
Model selection happens at the individual task level, NOT at the overall prompt level.

### Cost efficiency
Use the cheapest model that can reliably complete each task.

### Dynamic model selection
Model selection is not permanent. Agents can be upgraded, downgraded, or reassigned while work is in progress.

### Autonomous execution
After receiving the original prompt, the system should handle decomposition, assignment, execution, monitoring, and integration automatically.

### Preserve existing workflows
Do not require users to abandon their preferred AI coding harness, provider, editor, or existing development workflow.

---

# 3. Intelligent Prompt Decomposition

This is the most important component.

The orchestrator must analyze the original prompt and identify separate actionable tasks.

Example user prompt:

"Change my page title to HELLO WORLD, update the primary button color to purple, and make sure the authentication bug from the previous issue has been fixed."

The orchestrator should generate a task graph similar to:

### Task A: Update page title
- Locate the relevant page component.
- Change the title to HELLO WORLD.
- Verify the change.
- Estimated complexity: Low.

### Task B: Update button color
- Locate the primary button styling.
- Update the color to purple.
- Verify that other button variants are unaffected.
- Estimated complexity: Low.

### Task C: Verify previous authentication bug
- Identify the previous bug from issue history, project context, or supplied references.
- Inspect the relevant implementation.
- Reproduce the original issue if possible.
- Run regression tests.
- Determine whether the bug is resolved.
- Estimated complexity: Medium to High.

Tasks A and B should execute concurrently.

Task C should execute concurrently if it does not depend on the changes made by A or B.

The orchestrator must understand task dependencies instead of blindly parallelizing everything.

## Task decomposition requirements

- Identify independent tasks.
- Identify dependent tasks.
- Identify shared files and potential conflicts.
- Identify required capabilities.
- Estimate task complexity.
- Estimate token consumption and cost.
- Identify required context and tools.
- Generate explicit task acceptance criteria.
- Produce a dependency graph.
- Avoid unnecessary task fragmentation.
- Avoid assigning multiple agents conflicting write access to the same resources.

The planner must be able to revise the task graph when new information emerges.

---

# 4. Model Discovery and Capability Registry

The system must maintain an up-to-date registry of available models.

It should discover models through provider APIs, compatible gateways, local model runtimes, and user-configured providers.

Potential providers include:

- OpenAI
- Anthropic
- Google Gemini
- DeepSeek
- xAI / Grok
- Meta / Llama
- Mistral
- Qwen
- OpenRouter
- Ollama
- LM Studio
- LiteLLM-compatible endpoints
- Other OpenAI-compatible endpoints

Do not assume that all providers expose identical capabilities.

## Model registry

Maintain metadata for each model:

- Provider.
- Model identifier.
- Model family.
- Input pricing.
- Output pricing.
- Context window.
- Maximum output tokens.
- Reasoning capabilities.
- Coding capabilities.
- Tool-calling support.
- Structured output support.
- Vision support.
- Latency estimates.
- Availability.
- Rate limits.
- Supported API features.
- Historical task success rate.

Model information should be refreshed when possible.

Allow users to configure custom models, API endpoints, and local models.

Never hardcode model names or assume that a particular model remains the cheapest or most capable.

---

# 5. Intelligent Task-Level Model Routing

Build a routing engine that selects a model independently for every task.

Do not select one model for an entire user prompt.

Example routing:

| Task | Candidate model | Reason |
|---|---|---|
| Rename a variable | Small/cheap model | Simple deterministic change |
| Update CSS | Claude Haiku or equivalent | Low complexity |
| Add a React component | Small or medium coding model | Moderate implementation |
| Design a database schema | Strong reasoning model | Architectural reasoning |
| Debug a complex race condition | Strong coding/reasoning model | Complex investigation |
| Review security-sensitive code | Strong reasoning model | Higher reliability requirements |
| Generate simple unit tests | Small coding model | Structured repetitive work |

These are examples, not fixed assignments.

The routing engine must evaluate actual available models and their measured capabilities.

## Routing algorithm

For each task:

1. Analyze task requirements.
2. Identify mandatory model capabilities.
3. Filter out models that cannot satisfy those requirements.
4. Estimate expected completion cost.
5. Estimate probability of successful completion.
6. Consider latency and availability.
7. Select the cheapest model that meets the required reliability threshold.
8. Assign the task.
9. Monitor the result.
10. Reevaluate model selection when necessary.

Use historical performance data to improve future routing decisions.

Implement configurable cost-versus-quality policies.

Example:

- Economy: prioritize low cost.
- Balanced: optimize cost and reliability.
- Quality: prioritize successful completion.
- Custom: user-defined routing constraints.

---

# 6. Dynamic Model Escalation and Downgrading

Model selection must continue throughout execution.

A task initially assigned to a small model may become more complicated than anticipated.

The orchestrator must recognize this and escalate the task.

Example:

Task: Update a button's background color.

Initial assignment:
Claude Haiku.

During execution, the agent discovers:
The color is generated through a shared theme engine with multiple inheritance layers.

The agent reports that the implementation is more complicated than expected.

The orchestrator should:

1. Capture the failed attempt and findings.
2. Preserve relevant context.
3. Reevaluate task complexity.
4. Select a more capable model.
5. Reassign the task.
6. Continue execution without restarting the entire workflow.

### Escalation triggers

- Repeated unsuccessful attempts.
- Unexpected code complexity.
- Missing or ambiguous requirements.
- Failure to satisfy acceptance criteria.
- Tool execution failures.
- Low confidence in the proposed solution.
- Contradictory findings.
- Excessive reasoning or token consumption.
- Unexpected dependencies.

### Downgrade triggers

- Complex investigation is complete.
- Remaining work becomes straightforward.
- A stronger model has produced a clear implementation plan.
- Remaining tasks are simple verification or repetitive edits.

Avoid unnecessary model switching. Model transitions have context-transfer and execution costs.

Implement configurable escalation thresholds, retry limits, and budget constraints.

---

# 7. Agent Execution Engine

The execution engine must support multiple agents operating simultaneously.

Each agent should receive:

- Its specific task.
- Relevant project context.
- Required files or references.
- Acceptance criteria.
- Dependencies.
- Available tools.
- Model assignment.
- Execution constraints.

Agents should not receive the entire original prompt unless necessary.

The system must support:

### Parallel execution
Independent tasks run simultaneously.

### Sequential execution
Dependent tasks wait for prerequisite tasks.

### Task reassignment
Incomplete or unsuccessful tasks can be assigned to another model.

### Shared context
Agents can exchange relevant discoveries and intermediate results.

### Conflict detection
Detect when agents modify overlapping files or incompatible resources.

### Execution isolation
Use worktrees, branches, patches, or equivalent isolation mechanisms when appropriate.

### Failure recovery
Recover from interrupted execution without losing completed work.

### Cancellation
Allow the user or orchestrator to cancel individual tasks or the entire workflow.

---

# 8. Harness and IDE Integrations

The project must be installable as a skill, extension, or integration depending on the host environment.

Do not build a separate coding assistant that competes with existing harnesses.

Build a universal orchestration core and thin adapters.

## A. Universal Agent Skill

Create an installation-friendly skill that can be consumed by compatible agent harnesses.

Include:
- SKILL.md.
- Installation instructions.
- Invocation instructions.
- Configuration instructions.
- Tool permissions.
- Supported provider documentation.
- Examples.

The skill should instruct the host agent to delegate task-level orchestration to the engine.

Investigate compatible skill formats and provide adapters where formats differ.

## B. IDE Extensions

Provide integrations for:

- Cursor.
- Windsurf.
- Kilo Code.
- VS Code.
- GitHub Copilot where supported.
- Other compatible IDE extensions.

The extensions should expose:

- Orchestration enable/disable.
- Current task graph.
- Active agents.
- Assigned models.
- Execution status.
- Model escalation events.
- Cost estimates.
- Actual cost.
- Retry and failure information.
- Task cancellation.

The extension should allow developers to inspect what is happening without requiring them to manage every agent manually.

## C. CLI

Provide a standalone CLI for environments that do not support extensions.

Example:

`orchestrator run "Implement feature X and verify existing bug Y"`

Also support:

- `orchestrator models`
- `orchestrator status`
- `orchestrator config`
- `orchestrator cost`
- `orchestrator stop`

## D. Harness adapters

Investigate native integration possibilities for:

- Claude Code.
- Codex.
- DeepSeek-based coding harnesses.
- Grok-based agents.
- Cursor.
- Windsurf.
- Kilo Code.
- GitHub Copilot.
- Google AI development environments.
- Meta-related agent environments.
- Other MCP-compatible or tool-enabled harnesses.

Use official extension APIs, skills, MCP, CLI, and documented interfaces where available.

Do not claim universal compatibility without testing.

---

# 9. Provider Abstraction Layer

Create a provider abstraction that separates model orchestration from provider-specific API implementations.

Use LiteLLM or an equivalent abstraction where appropriate.

The engine must support:

- Provider-specific authentication.
- API key management.
- Model discovery.
- Cost calculation.
- Streaming responses.
- Tool calling.
- Structured output.
- Retry handling.
- Rate-limit handling.
- Provider fallback.

Users should be able to use their own API keys.

Support local model endpoints.

Never transmit secrets between agents or expose API credentials in task context.

---

# 10. Context and Memory Management

A major challenge is preventing agents from receiving unnecessary context.

Implement intelligent context selection.

Each agent should receive only the information required for its task.

The context manager should support:

- Original prompt.
- Task-specific instructions.
- Relevant code snippets.
- Project structure.
- Relevant files.
- Previous agent findings.
- Dependency outputs.
- Acceptance criteria.
- Relevant historical issue context.

Agents should produce structured task results rather than dumping entire conversations into shared memory.

Persist workflow state so execution can resume after interruption.

---

# 11. Integration and Verification

The final integration layer must ensure that all tasks work together.

It should:

1. Collect completed task results.
2. Check task acceptance criteria.
3. Detect conflicting modifications.
4. Run relevant tests.
5. Run type checks and linting where available.
6. Identify incomplete work.
7. Reassign failed tasks when appropriate.
8. Produce a consolidated result.

Do not mark a task complete merely because an agent returned a successful response.

Completion requires evidence.

For code changes, inspect the actual diff and run appropriate validation.

---

# 12. Cost and Performance Dashboard

Expose an execution dashboard.

Display:

- Original user prompt.
- Generated task graph.
- Number of tasks.
- Active agents.
- Model assigned to each task.
- Model transitions.
- Token usage.
- Estimated cost.
- Actual cost.
- Execution duration.
- Success and failure rates.
- Final validation results.

Provide a breakdown of what each model cost.

The system should demonstrate measurable savings compared with sending the entire prompt to an expensive model.

Do not claim savings without actual benchmark data.

---

# 13. Security and Safety

This is an important requirement because multiple agents may have access to a user's codebase and tools.

Implement:

- Permission-aware execution.
- Secret isolation.
- Sandboxed execution where appropriate.
- Explicit approval for destructive operations.
- File access boundaries.
- Command execution controls.
- Audit logs.
- Provider credential isolation.
- Prompt injection defenses.
- Untrusted tool-output handling.

Never allow an agent to bypass the permissions of its host harness.

Preserve the user's existing approval and security settings.

---

# 14. Technical Architecture

Use a modular architecture.

Suggested components:

1. Core Orchestrator.
2. Prompt Analyzer.
3. Task Decomposer.
4. Dependency Graph Engine.
5. Model Discovery Service.
6. Capability Registry.
7. Model Routing Engine.
8. Agent Execution Engine.
9. Context Manager.
10. Escalation Manager.
11. Integration and Validation Engine.
12. Provider Adapters.
13. Harness Adapters.
14. IDE Extensions.
15. CLI.
16. Cost and Observability Layer.

Prefer a language and architecture that make the core engine reusable across multiple integration environments.

A reasonable starting point:

- TypeScript for the core orchestration engine.
- Python adapters where Python ecosystems provide meaningful advantages.
- SQLite for local persistence.
- JSON or JSON Schema for structured task contracts.
- MCP for compatible tool integrations.
- LiteLLM or equivalent for model connectivity.
- LangGraph or an equivalent workflow engine if it adds value.

These are initial recommendations, not mandatory dependencies. Avoid unnecessary framework stacking.

---

# 15. GitHub Repository

Create a clean, professional, community-friendly open-source repository.

Suggested name:

`intelligent-agent-router`

Alternative names can be proposed, but choose one and use it consistently.

Suggested structure:

```text
/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── CHANGELOG.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
│
├── apps/
│   ├── cli/
│   └── vscode-extension/
│
├── packages/
│   ├── core/
│   ├── planner/
│   ├── task-graph/
│   ├── model-registry/
│   ├── model-router/
│   ├── agent-runtime/
│   ├── context-manager/
│   ├── escalation/
│   ├── provider-adapters/
│   ├── harness-adapters/
│   ├── integrations/
│   └── observability/
│
├── skills/
│   └── universal-orchestrator/
│       └── SKILL.md
│
├── extensions/
│   ├── cursor/
│   ├── windsurf/
│   ├── kilo/
│   └── vscode/
│
├── docs/
│   ├── architecture.md
│   ├── installation.md
│   ├── providers.md
│   ├── model-routing.md
│   ├── task-decomposition.md
│   ├── harness-integrations.md
│   ├── security.md
│   └── examples.md
│
├── examples/
│
└── tests/
```

Adapt the structure as needed to ensure installable, independently testable packages.

---

# 16. Development Phases

Build incrementally.

Do not attempt to build every integration simultaneously.

### Phase 1: Core orchestration MVP

Implement:
- Prompt decomposition.
- Task generation.
- Dependency graphs.
- Model registry.
- Multi-provider connectivity.
- Task-level model routing.
- Parallel execution.
- Structured results.
- Basic validation.

The MVP must demonstrate one prompt being distributed across at least two different providers and models.

### Phase 2: Dynamic intelligence

Implement:
- Runtime escalation.
- Model downgrading.
- Failure recovery.
- Cost optimization.
- Historical model performance.
- Adaptive routing.

### Phase 3: Universal skill

Implement:
- Universal skill specification.
- Claude Code integration.
- Codex integration.
- Generic MCP integration.
- Installation documentation.

### Phase 4: IDE extensions

Implement:
- VS Code extension.
- Cursor compatibility.
- Windsurf compatibility.
- Kilo Code compatibility.
- Additional supported IDE integrations.

### Phase 5: Observability and ecosystem

Implement:
- Dashboard.
- Cost analytics.
- Execution visualization.
- Provider plugins.
- Community integrations.
- Performance benchmarking.

---

# 17. Acceptance Tests

The following scenarios must work.

### Test 1: Simple parallel changes

Prompt:

"Change the page title to HELLO WORLD and update the primary button to purple."

Expected:
- Two separate tasks.
- Cheap capable models selected.
- Both execute concurrently if safe.
- Final validation confirms both changes.

### Test 2: Mixed complexity

Prompt:

"Change the button color to purple, add a reusable dropdown component, and investigate the previous authentication bug."

Expected:
- Simple styling task assigned to an inexpensive model.
- Component implementation assigned according to complexity.
- Authentication investigation assigned to an appropriately capable model.
- Tasks execute concurrently when dependencies permit.

### Test 3: Runtime escalation

Prompt:

"Update the theme color."

Expected:
- Start with an inexpensive model.
- Detect unexpected theme-engine complexity.
- Escalate to a stronger model.
- Continue from previous findings.
- Avoid restarting unrelated tasks.

### Test 4: Cross-provider execution

Prompt:

"Implement a new feature, add tests, and review the implementation for security issues."

Expected:
- Tasks assigned to models from different providers when beneficial.
- Independent tasks execute concurrently.
- Results are integrated and validated.

### Test 5: Cost optimization

Run equivalent workloads with:
- One expensive model handling everything.
- The orchestration engine using multiple appropriately selected models.

Measure:
- Total cost.
- Completion time.
- Success rate.
- Number of retries.
- Output quality.

### Test 6: Failure recovery

Simulate:
- Provider outage.
- Rate limiting.
- Model timeout.
- Agent failure.
- Invalid task output.

Expected:
- Appropriate retries or provider fallback.
- Task state preserved.
- Other completed tasks unaffected.
- Workflow resumes successfully.

---

# 18. Documentation and Developer Experience

The README must immediately explain:

- What the project does.
- Why it exists.
- How it differs from ordinary multi-agent systems.
- How task-level model routing works.
- Supported providers.
- Supported harnesses.
- Installation.
- Configuration.
- Example execution.
- Cost optimization.
- Contribution instructions.

Provide a simple quick-start experience.

A developer should be able to install the project, configure provider credentials, enable the skill or extension, and start using orchestration without building a custom agent workflow.

Include example configurations and environment variable documentation.

Never commit real API keys.

---

# 19. Development Instructions

Before implementation:

1. Research existing open-source projects and relevant integration APIs.
2. Identify reusable components.
3. Avoid reinventing existing provider abstractions.
4. Verify actual compatibility claims.
5. Produce a concise architecture plan.
6. Identify technical risks and integration limitations.

Then implement the project incrementally.

Requirements:

- Maintain strict TypeScript typing where applicable.
- Write unit and integration tests.
- Include mocked provider tests.
- Avoid unnecessary abstractions.
- Avoid excessive dependencies.
- Ensure all packages build independently.
- Maintain clear interfaces between modules.
- Document architectural decisions.
- Keep the core engine independent of individual IDEs.
- Do not implement fake integrations or placeholder functionality while claiming support.

Do not stop after generating a README, architecture diagram, or prototype.

Build a working MVP first, demonstrate it with real model providers, and then expand integrations.

---

# 20. Definition of Success

A developer installs this project into their existing AI development environment.

They submit a single natural-language prompt.

The system independently determines:

- What needs to be done.
- How to divide the work.
- Which tasks can run simultaneously.
- Which model is cheapest while still capable.
- Which provider to use.
- When to escalate to a stronger model.
- When to downgrade to a cheaper model.
- How to validate the work.
- How to integrate the results.

The developer receives one coherent completed result without manually managing agents.

**The ultimate goal: Make intelligent multi-model task orchestration a universal capability that any AI coding harness can install.**

Build this as a practical, extensible, genuinely open-source project, not a conceptual demo.

Before you start implementation, I'd establish these as non-negotiable:
1. BYOK first: Bring your own API keys. Don't make users pay you for model access.
2. Local-first: Keep orchestration state, credentials, and project context on the user's machine by default.
3. No vendor lock-in: Models and IDEs should be replaceable independently.
4. Task-level billing: Track the cost of every individual task, including escalations.
5. Capability benchmarks: Build a feedback loop that measures which models actually succeed at which tasks.
6. Safe concurrency: Use Git worktrees or equivalent isolation to prevent agents from overwriting each other's changes.
One architectural warning
The hardest part isn't connecting GPT, Claude, Gemini, or DeepSeek. It's making sure multiple agents can modify the same codebase without creating conflicts, losing context, or falsely reporting completion.

I'd make the task graph, execution state, and file-conflict management first-class parts of the engine.

My suggested MVP: TypeScript orchestration engine + LiteLLM + SQLite + Git worktrees + universal agent skill. Get that working before building four or five IDE extensions.