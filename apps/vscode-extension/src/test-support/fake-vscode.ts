/*
 * TEST DOUBLE for the `vscode` module (aliased by vitest.config.ts). Implements only the API
 * surface the soot extension uses, records what the extension did, and lets tests answer
 * input boxes and quick picks. It is NOT VS Code: passing tests here does not mean the
 * extension works in a real editor.
 */

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
  readonly #listeners: Listener<T>[] = [];
  readonly event = (listener: Listener<T>) => {
    this.#listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const l of this.#listeners) l(e);
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

/** `vscode.ThemeColor`: a reference to a theme color id, resolved by the editor's theme. */
export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

/** `vscode.ThemeIcon`: a codicon id, optionally tinted with a theme color. */
export class ThemeIcon {
  readonly id: string;
  readonly color?: ThemeColor;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    if (color !== undefined) this.color = color;
  }
}

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  contextValue?: string;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon;
  constructor(label: string, collapsibleState: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export const fake = {
  settings: new Map<string, unknown>(),
  /**
   * Every `getConfiguration(..).update(..)` call, as `section.key`. In VS Code a Workspace
   * update writes `.vscode/settings.json` into the repository; tests assert it stays empty.
   */
  settingWrites: [] as string[],
  /** Backing store for `extensionContext().workspaceState` (VS Code's own storage, not a file). */
  workspaceState: new Map<string, unknown>(),
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  treeProviders: new Map<string, unknown>(),
  messages: [] as { level: 'info' | 'warning' | 'error'; text: string }[],
  output: [] as string[],
  documents: [] as { content: string; language: string }[],
  inputBoxAnswers: [] as (string | undefined)[],
  quickPickAnswers: [] as (string | undefined)[],
  quickPickItems: [] as string[][],
  workspaceFolder: null as string | null,
  reset(): void {
    this.settings.clear();
    this.settingWrites.length = 0;
    this.workspaceState.clear();
    this.commands.clear();
    this.treeProviders.clear();
    this.messages.length = 0;
    this.output.length = 0;
    this.documents.length = 0;
    this.inputBoxAnswers.length = 0;
    this.quickPickAnswers.length = 0;
    this.quickPickItems.length = 0;
    this.workspaceFolder = null;
  },
};

export const workspace = {
  get workspaceFolders() {
    return fake.workspaceFolder === null ? undefined : [{ uri: { fsPath: fake.workspaceFolder } }];
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const v = fake.settings.get(`${section}.${key}`);
        return v === undefined ? fallback : (v as T);
      },
      update(key: string, value: unknown): Promise<void> {
        fake.settings.set(`${section}.${key}`, value);
        fake.settingWrites.push(`${section}.${key}`);
        return Promise.resolve();
      },
    };
  },
  openTextDocument(options: { content: string; language: string }) {
    fake.documents.push(options);
    return Promise.resolve(options);
  },
};

const message = (level: 'info' | 'warning' | 'error') => (text: string) => {
  fake.messages.push({ level, text });
  return Promise.resolve(undefined);
};

export const window = {
  createOutputChannel: () => ({
    appendLine: (line: string) => {
      fake.output.push(line);
    },
    dispose: () => undefined,
  }),
  registerTreeDataProvider: (id: string, provider: unknown) => {
    fake.treeProviders.set(id, provider);
    return { dispose: () => undefined };
  },
  showInformationMessage: message('info'),
  showWarningMessage: message('warning'),
  showErrorMessage: message('error'),
  showInputBox: () => Promise.resolve(fake.inputBoxAnswers.shift()),
  showQuickPick: (items: string[]) => {
    fake.quickPickItems.push([...items]);
    return Promise.resolve(fake.quickPickAnswers.shift());
  },
  showTextDocument: () => Promise.resolve(undefined),
};

/** A stand-in `ExtensionContext`: subscriptions and a `workspaceState` Memento. */
export function extensionContext() {
  return {
    subscriptions: [] as unknown[],
    workspaceState: {
      keys: () => [...fake.workspaceState.keys()],
      get<T>(key: string, fallback?: T): T | undefined {
        return fake.workspaceState.has(key) ? (fake.workspaceState.get(key) as T) : fallback;
      },
      update(key: string, value: unknown): Promise<void> {
        if (value === undefined) fake.workspaceState.delete(key);
        else fake.workspaceState.set(key, value);
        return Promise.resolve();
      },
    },
  };
}

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    fake.commands.set(id, handler);
    return { dispose: () => undefined };
  },
  executeCommand: (id: string, ...args: unknown[]) => {
    const handler = fake.commands.get(id);
    if (handler === undefined) throw new Error(`command not registered: ${id}`);
    return Promise.resolve(handler(...args));
  },
};
