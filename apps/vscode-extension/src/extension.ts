import * as vscode from 'vscode';
import {
  activeBlock,
  costBlock,
  escalationDetails,
  escalationLine,
  failureBlock,
  graphBlock,
  otherEventsBlock,
  renderBoard,
  taskBlock,
} from './core/blocks.js';
import { SootCli, type AgentSetting } from './core/soot-cli.js';
import { toRunView, type EscalationView, type RunView } from './core/view-model.js';

/*
 * Thin VS Code / Cursor adapter (ADR-029). It runs the soot CLI and shows what the engine
 * reports as stacked text blocks in one tree view and one plain-text board. No orchestration
 * happens here, nothing is approved here, and nothing is published. Run in a real VS Code
 * (1.144, macOS, `--agent mock`) for M7-01; unit tests use a fake `vscode` module.
 */

export const COMMANDS = [
  'soot.enable',
  'soot.disable',
  'soot.run',
  'soot.refresh',
  'soot.showBoard',
  'soot.stopRun',
  'soot.cancelTask',
] as const;

const POLL_MS = 500;

/** Key for orchestration on/off in VS Code's per-workspace storage (ADR-041). */
export const ENABLED_STATE_KEY = 'soot.enabled';

/**
 * Theme colors contributed in package.json (`contributes.colors`): soot's locked palette
 * (ADR-009) on dark themes, orange #ff7a1a and cream #e8dcc8, with darker variants on light
 * and high-contrast-light themes so the text stays readable (ADR-044). The editor keeps its own
 * background; soot only tints icons.
 */
export const ESCALATION_COLOR = 'soot.escalation';
export const SECONDARY_COLOR = 'soot.secondary';

const icon = (id: string, color: string) => new vscode.ThemeIcon(id, new vscode.ThemeColor(color));

interface NodeExtra {
  contextValue?: string;
  runId?: string;
  taskId?: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
}

export class SootNode extends vscode.TreeItem {
  declare label: string;
  readonly children: SootNode[];
  readonly runId: string | null;
  readonly taskId: string | null;
  constructor(label: string, children: SootNode[] = [], extra: NodeExtra = {}) {
    super(
      label,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.children = children;
    this.runId = extra.runId ?? null;
    this.taskId = extra.taskId ?? null;
    if (extra.contextValue !== undefined) this.contextValue = extra.contextValue;
    if (extra.description !== undefined) this.description = extra.description;
    if (extra.tooltip !== undefined) this.tooltip = extra.tooltip;
    if (extra.icon !== undefined) this.iconPath = extra.icon;
  }
}

const leaf = (label: string) => new SootNode(label);

/**
 * One escalation as a tree node (M7-06): label = task, attempt and the model step; children =
 * from, to, why and each trigger, so nothing depends on hovering or on a wide sidebar.
 */
export function escalationNode(e: EscalationView, runId: string): SootNode {
  const [from = '', to = '', why = '', ...triggers] = escalationDetails(e);
  return new SootNode(
    escalationLine(e),
    [
      new SootNode(from, [], { icon: icon('circle-outline', SECONDARY_COLOR) }),
      new SootNode(to, [], { icon: icon('triangle-up', ESCALATION_COLOR) }),
      new SootNode(why, [], { tooltip: e.reason, icon: icon('comment', SECONDARY_COLOR) }),
      ...triggers.map(
        (t) => new SootNode(t.trim(), [], { icon: icon('warning', ESCALATION_COLOR) }),
      ),
    ],
    {
      runId,
      taskId: e.taskId,
      tooltip: escalationDetails(e).join('\n'),
      icon: icon('triangle-up', ESCALATION_COLOR),
    },
  );
}

export function treeFor(enabled: boolean, view: RunView | null): SootNode[] {
  const roots = [
    new SootNode(`Orchestration: ${enabled ? 'on' : 'off'}`, [], {
      contextValue: enabled ? 'soot.enabled' : 'soot.disabled',
    }),
  ];
  if (view === null) return [...roots, leaf('(no run yet: soot: Run a prompt)')];
  const tasks = view.tasks.map(
    (t) =>
      new SootNode(
        taskBlock(t),
        t.attempts.map((a) => {
          const escalated = a.escalationLevel !== null && a.escalationLevel > 0;
          return new SootNode(
            `#${String(a.attempt)} ${a.state} · ${a.model ?? 'no model'}${escalated ? ` · escalated ×${String(a.escalationLevel)}` : ''}${a.failure === null ? '' : ` · ${a.failure}`}`,
            [],
            escalated ? { icon: icon('triangle-up', ESCALATION_COLOR) } : {},
          );
        }),
        {
          contextValue: t.active ? 'soot.task.active' : 'soot.task',
          runId: view.runId,
          taskId: t.id,
          description: t.verdict ?? t.state,
        },
      ),
  );
  roots.push(
    new SootNode(
      `Run ${view.runId}: ${view.state}`,
      [
        new SootNode('Task graph', graphBlock(view.tasks).map(leaf)),
        new SootNode('Tasks', tasks),
        new SootNode('Active agents', activeBlock(view.tasks).map(leaf)),
        new SootNode(
          `Escalations (${String(view.escalations.length)})`,
          view.escalations.length === 0
            ? [leaf('(no escalations)')]
            : view.escalations.map((e) => escalationNode(e, view.runId)),
          { icon: icon('triangle-up', ESCALATION_COLOR) },
        ),
        new SootNode('Retries and other events', otherEventsBlock(view.events).map(leaf)),
        new SootNode('Failures', failureBlock(view.tasks).map(leaf)),
        new SootNode('Cost', costBlock(view.cost).map(leaf)),
      ],
      { contextValue: view.running ? 'soot.run.running' : 'soot.run', runId: view.runId },
    ),
  );
  return roots;
}

export class SootTree implements vscode.TreeDataProvider<SootNode> {
  readonly #changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  roots: SootNode[] = [];
  set(roots: SootNode[]): void {
    this.roots = roots;
    this.#changed.fire(undefined);
  }
  getTreeItem(node: SootNode): SootNode {
    return node;
  }
  getChildren(node?: SootNode): SootNode[] {
    return node === undefined ? this.roots : node.children;
  }
}

/** State the commands share; exported for tests. */
export interface SootController {
  readonly tree: SootTree;
  view: RunView | null;
  /** Refresh, or join the refresh already in flight (polling). */
  refresh(): Promise<void>;
  /**
   * Wait for any refresh in flight, then fetch fresh. Used once a run has ended, so a poll that
   * started while the run was still going cannot leave its older state in the view.
   */
  refreshFresh(): Promise<void>;
}

function settings() {
  const c = vscode.workspace.getConfiguration('soot');
  return {
    enabled: c.get<boolean>('enabled', false),
    cliPath: c.get<string>('cliPath', ''),
    nodePath: c.get<string>('nodePath', 'node'),
    agent: c.get<AgentSetting>('agent', 'none'),
    mockScript: c.get<string>('mockScript', 'mock-agent.json'),
    dataDir: c.get<string>('dataDir', ''),
  };
}

function cliFor(): SootCli | string {
  const s = settings();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined)
    return 'soot: open a folder (a git repository with soot.config.json) first.';
  if (s.cliPath === '')
    return 'soot: set "soot.cliPath" to your soot checkout\'s apps/cli/dist/bin.js.';
  return new SootCli({
    nodePath: s.nodePath,
    cliPath: s.cliPath,
    cwd: folder,
    dataDir: s.dataDir === '' ? null : s.dataDir,
  });
}

export function activate(context: vscode.ExtensionContext): SootController {
  const out = vscode.window.createOutputChannel('soot');
  const tree = new SootTree();
  let currentRun: string | null = null;
  let refreshing: Promise<void> | null = null;
  // On/off lives in VS Code's per-workspace storage, never in a settings file (ADR-041):
  // writing `.vscode/settings.json` dirtied the repository, and soot refuses to run on a dirty
  // working tree, so Enable broke the next Run in the first real VS Code run. A committed
  // `soot.enabled` setting is still the default until Enable/Disable is used here.
  const enabled = () =>
    context.workspaceState.get<boolean>(ENABLED_STATE_KEY) ?? settings().enabled;
  const setEnabled = async (on: boolean) => {
    await context.workspaceState.update(ENABLED_STATE_KEY, on);
    await controller.refresh();
  };
  const refreshOnce = async () => {
    const cli = cliFor();
    if (typeof cli === 'string') {
      tree.set(treeFor(enabled(), controller.view));
      return;
    }
    if (currentRun === null) {
      const list = await cli.status();
      const runs = Array.isArray(list.data?.runs) ? (list.data.runs as { runId: string }[]) : [];
      currentRun = runs.at(-1)?.runId ?? null;
    }
    if (currentRun !== null) {
      const status = await cli.status(currentRun);
      if (status.data !== null && status.code === 0) {
        const running = status.data.running === true;
        const cost = running ? null : (await cli.cost(currentRun)).data;
        controller.view = toRunView(status.data, cost);
      }
    }
    tree.set(treeFor(enabled(), controller.view));
  };
  // One refresh at a time: polling never stacks CLI processes.
  const startRefresh = (): Promise<void> => {
    const p: Promise<void> = refreshOnce().finally(() => {
      if (refreshing === p) refreshing = null;
    });
    refreshing = p;
    return p;
  };
  const controller: SootController = {
    tree,
    view: null,
    refresh: () => refreshing ?? startRefresh(),
    refreshFresh: async () => {
      while (refreshing !== null) await refreshing.catch(() => undefined);
      await startRefresh();
    },
  };
  const fail = (message: string) => {
    void vscode.window.showErrorMessage(message);
  };

  const handlers: Record<(typeof COMMANDS)[number], (...args: unknown[]) => unknown> = {
    'soot.enable': () => setEnabled(true),
    'soot.disable': () => setEnabled(false),
    'soot.run': async () => {
      const s = settings();
      if (!enabled()) {
        void vscode.window.showWarningMessage(
          'soot orchestration is off for this workspace (soot: Enable orchestration).',
        );
        return;
      }
      const cli = cliFor();
      if (typeof cli === 'string') {
        fail(cli);
        return;
      }
      const prompt = await vscode.window.showInputBox({
        prompt: 'One prompt for soot (recorded prompts only for now)',
        ignoreFocusOut: true,
      });
      if (prompt === undefined || prompt.trim() === '') return;
      const handle = cli.run(prompt, s.agent, s.mockScript, (line) => {
        out.appendLine(line);
      });
      currentRun = handle.runId;
      out.appendLine(
        `soot: started ${handle.runId} (agent: ${s.agent}; unattended: approvals are refused, never given)`,
      );
      const timer = setInterval(() => {
        void controller.refresh();
      }, POLL_MS);
      try {
        const result = await handle.done;
        clearInterval(timer);
        // The run has ended: never settle for a poll that started before that.
        await controller.refreshFresh();
        const report = result.data?.report;
        const r =
          typeof report === 'object' && report !== null ? (report as Record<string, unknown>) : {};
        const problems = Array.isArray(r.problems)
          ? r.problems.filter((p): p is string => typeof p === 'string')
          : [];
        const message =
          typeof result.data?.error === 'string'
            ? `soot: ${result.data.error}`
            : `soot run ${handle.runId}: ${typeof r.status === 'string' ? r.status : `exit ${String(result.code)}`}${problems.length > 0 ? ` (${problems.join('; ')})` : ''}`;
        out.appendLine(message);
        if (result.code === 0) void vscode.window.showInformationMessage(message);
        else if (result.code === 2) void vscode.window.showWarningMessage(message);
        else fail(message);
        return result;
      } finally {
        clearInterval(timer);
      }
    },
    'soot.refresh': () => controller.refresh(),
    'soot.showBoard': async () => {
      await controller.refresh();
      if (controller.view === null) {
        fail('soot: no run to show yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({
        content: renderBoard(controller.view),
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(doc);
      return doc;
    },
    'soot.stopRun': async (node?: unknown) => {
      const cli = cliFor();
      if (typeof cli === 'string') {
        fail(cli);
        return;
      }
      const runId = node instanceof SootNode && node.runId !== null ? node.runId : currentRun;
      if (runId === null) {
        fail('soot: no run to stop.');
        return;
      }
      const r = await cli.stop(runId);
      out.appendLine(`soot: stop ${runId}: exit ${String(r.code)}`);
      return r;
    },
    'soot.cancelTask': async (node?: unknown) => {
      const cli = cliFor();
      if (typeof cli === 'string') {
        fail(cli);
        return;
      }
      let runId = currentRun;
      let taskId: string | null;
      if (node instanceof SootNode && node.taskId !== null) {
        runId = node.runId;
        taskId = node.taskId;
      } else {
        const active = controller.view?.tasks.filter((t) => t.active).map((t) => t.id) ?? [];
        taskId =
          (await vscode.window.showQuickPick(active, { placeHolder: 'Cancel which task?' })) ??
          null;
      }
      if (runId === null || taskId === null) return;
      const r = await cli.stop(runId, taskId);
      out.appendLine(`soot: cancel ${taskId} in ${runId}: exit ${String(r.code)}`);
      await controller.refresh();
      return r;
    },
  };
  for (const id of COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handlers[id]));
  }
  context.subscriptions.push(vscode.window.registerTreeDataProvider('soot.runs', tree), out);
  tree.set(treeFor(enabled(), null));
  return controller;
}

export function deactivate(): void {
  // Nothing to clean up: runs are separate soot processes and keep their own state.
}
