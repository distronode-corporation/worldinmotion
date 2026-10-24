// A small fake of the parts of the `vscode` API this extension uses. vitest aliases `vscode` to
// this file. Each piece behaves like the real API for the calls made here (return values,
// `undefined` on cancel, duplicate command ids throwing, `<view>.focus` existing only for a
// contributed view), and the `fake` object lets a test play the person.

import { readFileSync } from "node:fs";
import { posix } from "node:path";

type Listener<T> = (e: T) => unknown;
export type Disposable = { dispose(): unknown };

export class EventEmitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event = (fn: Listener<T>): Disposable => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire(e: T): void {
    for (const fn of [...this.listeners]) fn(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }
  static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? "", c.path ?? "", c.query ?? "", c.fragment ?? "");
  }
  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, base.authority, posix.join(base.path, ...segments), base.query, base.fragment);
  }
  get fsPath(): string {
    return this.path;
  }
  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
  }
  toJSON(): unknown {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
  toString(): string {
    const auth = this.authority === "" ? "" : `//${this.authority}`;
    return `${this.scheme}:${auth}${encodeURI(this.path).replaceAll("#", "%23")}${this.query === "" ? "" : `?${this.query}`}`;
  }
}

export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class ThemeIcon {
  readonly id: string;
  readonly color: ThemeColor | undefined;
  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export type TreeItemCollapsibleState = (typeof TreeItemCollapsibleState)[keyof typeof TreeItemCollapsibleState];

export class TreeItem {
  label: string;
  collapsibleState: TreeItemCollapsibleState;
  id?: string;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(label: string, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export type StatusBarAlignment = (typeof StatusBarAlignment)[keyof typeof StatusBarAlignment];

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export type ExtensionMode = (typeof ExtensionMode)[keyof typeof ExtensionMode];

export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

export class Selection {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position) {
    this.start = start;
    this.end = end;
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

// ---- documents and editors ----

export class TextDocument {
  readonly uri: Uri;
  readonly languageId: string;
  private readonly text: string;
  constructor(uri: Uri, text: string, languageId = "plaintext") {
    this.uri = uri;
    this.text = text;
    this.languageId = languageId;
  }
  /** The whole text, or the text of a selection (lines split on `\n`). */
  getText(range?: Selection): string {
    if (range === undefined) return this.text;
    const lines = this.text.split("\n");
    const out: string[] = [];
    for (let l = range.start.line; l <= range.end.line; l += 1) {
      const line = lines[l] ?? "";
      const from = l === range.start.line ? range.start.character : 0;
      const to = l === range.end.line ? range.end.character : line.length;
      out.push(line.slice(from, to));
    }
    return out.join("\n");
  }
}

export type TextEditor = { document: TextDocument; selection: Selection };

// ---- the state a test inspects and drives ----

type Command = (...args: unknown[]) => unknown;
type ContentProvider = { provideTextDocumentContent(uri: Uri): string | Promise<string>; onDidChange?: (fn: Listener<Uri>) => Disposable };
type QuickPickAnswer = (items: readonly unknown[], options: unknown) => unknown;

export type FakeWebview = {
  options: Record<string, unknown>;
  html: string;
  readonly cspSource: string;
  asWebviewUri(uri: Uri): Uri;
  onDidReceiveMessage(fn: Listener<unknown>): Disposable;
  postMessage(msg: unknown): Promise<boolean>;
  posted: unknown[];
  /** Plays the page posting a message. */
  receive(msg: unknown): void;
};
export type FakeWebviewView = {
  webview: FakeWebview;
  visible: boolean;
  onDidChangeVisibility(fn: Listener<void>): Disposable;
  onDidDispose(fn: Listener<void>): Disposable;
  setVisible(v: boolean): void;
  dispose(): void;
};

export type FakeTreeView = {
  id: string;
  provider: { getParent?(n: unknown): unknown; getChildren(n?: unknown): unknown[] };
  badge: { value: number; tooltip: string } | undefined;
  message: string | undefined;
  revealed: unknown[];
  reveal(element: unknown, options?: unknown): Promise<void>;
  dispose(): void;
};

const contributed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  contributes: { views: Record<string, { id: string }[]> };
};
const VIEW_IDS = new Set(Object.values(contributed.contributes.views).flatMap((list) => list.map((v) => v.id)));

function freshState() {
  return {
    commands: new Map<string, Command>(),
    executed: [] as { id: string; args: unknown[] }[],
    config: new Map<string, unknown>(),
    configEvents: new EventEmitter<{ affectsConfiguration(section: string): boolean }>(),
    closeEvents: new EventEmitter<TextDocument>(),
    providers: new Map<string, ContentProvider>(),
    webviewProviders: new Map<string, { resolveWebviewView(view: FakeWebviewView): void }>(),
    treeViews: new Map<string, FakeTreeView>(),
    output: [] as string[],
    outputShown: 0,
    statusItems: [] as FakeStatusBarItem[],
    messages: [] as { level: "info" | "warning" | "error"; message: string; options?: unknown; items: string[] }[],
    /** What the person answers to the next message with buttons: an item label, or undefined. */
    messageAnswers: [] as (string | undefined)[],
    quickPickAnswers: [] as QuickPickAnswer[],
    quickPicks: [] as { items: readonly unknown[]; options: unknown }[],
    inputAnswers: [] as (string | undefined)[],
    shown: [] as TextDocument[],
    activeTextEditor: undefined as TextEditor | undefined,
    workspaceRoot: "/work",
    /** Like the real API: undefined when no folder is open. */
    workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  };
}

export const fake = {
  state: freshState(),
  reset(): void {
    this.state = freshState();
  },
  /** Changes a setting the way the Settings editor does: stored, then the change event. */
  setConfig(key: string, value: unknown): void {
    this.state.config.set(key, value);
    this.state.configEvents.fire({ affectsConfiguration: (section: string) => key === section || key.startsWith(`${section}.`) });
  },
  async run(id: string, ...args: unknown[]): Promise<unknown> {
    return commands.executeCommand(id, ...args);
  },
  resolveWebview(id: string): FakeWebviewView {
    const provider = this.state.webviewProviders.get(id)!;
    const visibility = new EventEmitter<void>();
    const disposed = new EventEmitter<void>();
    const received = new EventEmitter<unknown>();
    const view: FakeWebviewView = {
      visible: true,
      webview: {
        options: {},
        html: "",
        cspSource: "https://fake.vscode-cdn.net",
        asWebviewUri: (uri) => Uri.from({ scheme: "https", authority: "file+.vscode-resource.fake.vscode-cdn.net", path: uri.path }),
        onDidReceiveMessage: received.event,
        posted: [],
        postMessage(msg) {
          this.posted.push(msg);
          return Promise.resolve(true);
        },
        receive: (msg) => received.fire(msg),
      },
      onDidChangeVisibility: visibility.event,
      onDidDispose: disposed.event,
      setVisible(v) {
        this.visible = v;
        visibility.fire();
      },
      dispose: () => disposed.fire(),
    };
    provider.resolveWebviewView(view);
    return view;
  },
};

class FakeStatusBarItem {
  readonly id: string;
  readonly alignment: StatusBarAlignment;
  readonly priority: number;
  text = "";
  tooltip: string | undefined;
  name: string | undefined;
  command: string | undefined;
  backgroundColor: ThemeColor | undefined;
  visible = false;
  disposed = false;
  constructor(id: string, alignment: StatusBarAlignment, priority: number) {
    this.id = id;
    this.alignment = alignment;
    this.priority = priority;
  }
  show(): void {
    this.visible = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

function message(level: "info" | "warning" | "error") {
  return (text: string, ...rest: unknown[]): Promise<string | undefined> => {
    const options = typeof rest[0] === "object" && rest[0] !== null ? rest.shift() : undefined;
    const items = rest as string[];
    fake.state.messages.push({ level, message: text, options, items });
    if (items.length === 0) return Promise.resolve(undefined);
    const answer = fake.state.messageAnswers.shift();
    // The real API resolves to one of the items, or undefined when dismissed.
    return Promise.resolve(answer !== undefined && items.includes(answer) ? answer : undefined);
  };
}

export const window = {
  get activeTextEditor(): TextEditor | undefined {
    return fake.state.activeTextEditor;
  },
  createOutputChannel(_name: string) {
    return {
      appendLine: (line: string) => fake.state.output.push(line),
      show: () => (fake.state.outputShown += 1),
      dispose: () => undefined,
    };
  },
  createStatusBarItem(id: string, alignment: StatusBarAlignment, priority: number): FakeStatusBarItem {
    const item = new FakeStatusBarItem(id, alignment, priority);
    fake.state.statusItems.push(item);
    return item;
  },
  createTreeView(id: string, options: { treeDataProvider: FakeTreeView["provider"] }): FakeTreeView {
    const view: FakeTreeView = {
      id,
      provider: options.treeDataProvider,
      badge: undefined,
      message: undefined,
      revealed: [],
      reveal(element) {
        // Like the real reveal: walk up with getParent (required) to a root the provider lists.
        const p = this.provider;
        if (p.getParent === undefined) return Promise.reject(new Error("TreeDataProvider must implement getParent to reveal"));
        let root = element;
        for (let up = p.getParent(root); up !== undefined; up = p.getParent(up)) root = up;
        if (!p.getChildren(undefined).includes(root)) return Promise.reject(new Error("Cannot resolve tree item for element"));
        this.revealed.push(element);
        return Promise.resolve();
      },
      dispose: () => fake.state.treeViews.delete(id),
    };
    fake.state.treeViews.set(id, view);
    return view;
  },
  registerWebviewViewProvider(id: string, provider: { resolveWebviewView(view: FakeWebviewView): void }): Disposable {
    fake.state.webviewProviders.set(id, provider);
    return { dispose: () => fake.state.webviewProviders.delete(id) };
  },
  showInformationMessage: message("info"),
  showWarningMessage: message("warning"),
  showErrorMessage: message("error"),
  showQuickPick(items: readonly unknown[], options?: unknown): Promise<unknown> {
    fake.state.quickPicks.push({ items, options });
    const answer = fake.state.quickPickAnswers.shift();
    return Promise.resolve(answer === undefined ? undefined : answer(items, options));
  },
  showInputBox(_options?: unknown): Promise<string | undefined> {
    return Promise.resolve(fake.state.inputAnswers.shift());
  },
  showTextDocument(doc: TextDocument, _options?: unknown): Promise<{ document: TextDocument }> {
    fake.state.shown.push(doc);
    return Promise.resolve({ document: doc });
  },
};

export const workspace = {
  get workspaceFolders(): readonly { uri: Uri; name: string; index: number }[] | undefined {
    return fake.state.workspaceFolders;
  },
  getConfiguration(section: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const full = `${section}.${key}`;
        return fake.state.config.has(full) ? (fake.state.config.get(full) as T) : fallback;
      },
    };
  },
  onDidChangeConfiguration: (fn: Listener<{ affectsConfiguration(section: string): boolean }>) => fake.state.configEvents.event(fn),
  onDidCloseTextDocument: (fn: Listener<TextDocument>) => fake.state.closeEvents.event(fn),
  registerTextDocumentContentProvider(scheme: string, provider: ContentProvider): Disposable {
    fake.state.providers.set(scheme, provider);
    return { dispose: () => fake.state.providers.delete(scheme) };
  },
  async openTextDocument(uri: Uri): Promise<TextDocument> {
    const provider = fake.state.providers.get(uri.scheme);
    if (provider === undefined) throw new Error(`cannot open ${uri.toString()}`);
    return new TextDocument(uri, await provider.provideTextDocumentContent(uri));
  },
  asRelativePath(pathOrUri: Uri | string, _includeWorkspaceFolder?: boolean): string {
    const path = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
    const root = fake.state.workspaceRoot;
    // Like the real API: relative inside the workspace, unchanged outside it.
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  },
};

export const languages = {
  setTextDocumentLanguage(doc: TextDocument, languageId: string): Promise<TextDocument> {
    return Promise.resolve(new TextDocument(doc.uri, doc.getText(), languageId));
  },
};

export const commands = {
  registerCommand(id: string, fn: Command): Disposable {
    if (fake.state.commands.has(id)) throw new Error(`command '${id}' already exists`);
    fake.state.commands.set(id, fn);
    return { dispose: () => fake.state.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    fake.state.executed.push({ id, args });
    const fn = fake.state.commands.get(id);
    if (fn !== undefined) return fn(...args);
    if (id.endsWith(".focus") && VIEW_IDS.has(id.slice(0, -".focus".length))) return undefined;
    throw new Error(`command '${id}' not found`);
  },
};
