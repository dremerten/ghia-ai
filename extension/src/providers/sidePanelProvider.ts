import * as vscode from "vscode";
import { AIService } from "../services/aiService";
import { CacheService } from "../services/cacheService";
import { ContextExtractor } from "../utils/contextExtractor";
import {
  writeWithConsent,
  removePyAidBlocks,
  type WriteMode,
} from "../utils/fileWriter";
import * as path from "path";

export const ALLOW_WRITE_KEY = "pyaid.allowFileWrites";

/**
 * Data structure for explanation history entries.
 */
interface HistoryEntry {
  id: string;
  code: string;
  explanation: string;
  languageId: string;
  fileName: string;
  lineNumber: number;
  timestamp: number;
}

type ConversationRole = "user" | "assistant";

interface ConversationEntry {
  id: string;
  role: ConversationRole;
  content: string;
  timestamp: number;
  kind: "ask" | "explain";
  pending?: boolean;
}
interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationEntry[];
}

const SESSION_STORE_KEY = "pyaid.panel.sessions";
const SESSION_ACTIVE_KEY = "pyaid.panel.activeSession";
const FLOATING_SESSION_STORE_KEY = "pyaid.floating.sessions";
const FLOATING_SESSION_ACTIVE_KEY = "pyaid.floating.activeSession";

interface FloatingConversationEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  pending?: boolean;
}

interface FloatingChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: FloatingConversationEntry[];
}

/**
 * Enhanced Side Panel Provider using VS Code's Webview API.
 *
 * **Advantages over hover:**
 * - Complete UI control: Custom HTML/CSS/JS
 * - Persistent: Stays open while coding
 * - Rich formatting: Syntax highlighting, expandable sections, history
 * - No conflicts: Completely separate from hover system
 * - Interactive: Buttons, forms, navigation
 *
 * **Trade-offs:**
 * - Takes screen real estate
 * - Requires explicit action to open
 * - More complex implementation
 *
 * This is the recommended approach for detailed explanations.
 */
export class SidePanelProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "pyaid.explanationPanel";

  private readonly aiService = new AIService();
  private readonly cacheService = new CacheService();
  private readonly contextExtractor = new ContextExtractor();

  private view?: vscode.WebviewView;
  private iconUrl = "";
  private history: HistoryEntry[] = [];
  private sessions: ChatSession[] = [];
  private currentSessionId: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private askInFlight = false;
  private pythonFocus = true;
  private allowFileWrites = false;

  // Track current explanation being displayed with full context for refresh
  private currentExplanation: {
    code: string;
    explanation: string;
    isLoading: boolean;
    languageId: string;
    context: string;
  } | null = null;

  private fileOptions: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    this.allowFileWrites = this.context.globalState.get<boolean>(
      ALLOW_WRITE_KEY,
      false
    );

    this.loadSessions();
    // Preload file options
    void this.loadFileOptions();
  }

  /**
   * Extracts the first fenced code block content from a markdown string.
   */
  private extractCodeSnippet(answer: string): string | null {
    // Prefer the first fenced block (with or without language tag).
    const fenced =
      answer.match(/```(?:[^\n`]*)\n([\s\S]*?)```/) ??
      answer.match(/```([\s\S]*?)```/);
    if (fenced && fenced[1]) return fenced[1].trim();

    // Fallback: single-line inline code enclosed in backticks.
    const inline = answer.match(/`([^`]+)`/);
    if (inline && inline[1]) return inline[1].trim();

    return null;
  }

  /** Choose a comment prefix for markers based on file extension. */
  private commentPrefix(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if ([".py", ".sh", ".rb", ".pl"].includes(ext)) return "#";
    if ([".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".java", ".go", ".c", ".cc", ".cpp", ".h", ".hpp"].includes(ext))
      return "//";
    return "//";
  }

  /** Wraps a snippet with PyAid markers for later removal. */
  private wrapWithMarkers(snippet: string, targetPath: string): string {
    const prefix = this.commentPrefix(targetPath);
    const start = `${prefix} PyAid:start`;
    const end = `${prefix} PyAid:end`;
    const body = snippet.trimEnd();
    return `${start}\n${body}\n${end}\n`;
  }

  /**
   * Resolves a target path. If none provided, fall back to the active file when writes are allowed.
   */
  private resolveTargetPath(provided?: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    // If user supplied a path, resolve relative to workspace root (first folder) if not absolute.
    if (provided && provided.trim().length > 0) {
      const p = provided.trim();
      if (path.isAbsolute(p)) return p;
      if (workspaceFolders && workspaceFolders.length > 0) {
        return path.join(workspaceFolders[0].uri.fsPath, p);
      }
      if (editor) {
        return path.join(path.dirname(editor.document.uri.fsPath), p);
      }
      return path.resolve(p);
    }

    // Fallback: current active file
    if (editor) {
      return editor.document.uri.fsPath;
    }
    return undefined;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    this.iconUrl = webviewView.webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "media", "pyaid.png")
      )
      .toString();

    const config = vscode.workspace.getConfiguration("pyaid");
    this.pythonFocus = config.get("askPythonMode", true);
    this.allowFileWrites = this.context.globalState.get<boolean>(
      ALLOW_WRITE_KEY,
      false
    );

    webviewView.webview.html = this.getHtml();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "copy":
            if (this.currentExplanation) {
              await vscode.env.clipboard.writeText(
                this.currentExplanation.explanation
              );
              vscode.window.showInformationMessage("Copied to clipboard");
            }
            break;
          case "refresh":
            await this.refreshExplanation();
            break;
          case "loadHistory":
            this.loadHistoryEntry(message.id);
            break;
          case "clearHistory":
            this.history = [];
            this.clearCurrentConversation();
            this.updateView();
            break;
          case "newSession":
            this.addSession(message.title);
            this.updateView();
            break;
          case "switchSession":
            this.setActiveSession(message.id);
            this.updateView();
            break;
          case "renameSession":
            if (typeof message.title === "string") {
              this.renameSession(message.id, message.title);
              this.updateView();
            }
            break;
          case "explainSelection":
            await this.explainCurrentSelection();
            break;
      case "ask":
        await this.handleAsk(message.question, {
          includeSelection: Boolean(message.includeSelection),
          includeFile: Boolean(message.includeFile),
          targetPath: message.targetPath,
          writeMode: message.writeMode,
        });
        break;
      case "toggleScope":
        await this.toggleScope();
        break;
      case "toggleWritePermission":
        // If caller passes an explicit value, use it; otherwise toggle.
        this.setAllowFileWrites(
          typeof message.allow === "boolean"
            ? message.allow
            : !this.allowFileWrites
        );
        break;
    }
  },
  null,
  this.disposables
);

    // Initial render
    this.updateView();

    // Keep context hints fresh when user changes editors/selections
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.updateView()),
      vscode.window.onDidChangeTextEditorSelection(() => this.updateView())
    );
  }

  /**
   * Explains the currently selected or cursor-adjacent code.
   */
  async explainCurrentSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.showMessage("No active editor. Open a file first.");
      return;
    }

    const document = editor.document;
    const selection = editor.selection;

    let code: string;
    let context: string;
    let lineNumber: number;

    if (!selection.isEmpty) {
      // Use selected text
      code = document.getText(selection).trim();
      context = "";
      lineNumber = selection.start.line + 1;
    } else {
      // Use cursor line
      const position = selection.active;
      const extracted = this.contextExtractor.extract(document, position);
      code = extracted.code;
      context = extracted.context;
      lineNumber = position.line + 1;
    }

    if (code.length === 0) {
      this.showMessage("Select some code or place cursor on a non-empty line.");
      return;
    }

    await this.explainCode(
      code,
      context,
      document.languageId,
      document.fileName,
      lineNumber
    );
  }

  /**
   * Main method to explain code and display in the panel.
   */
  async explainCode(
    code: string,
    context: string,
    languageId: string,
    fileName: string,
    lineNumber: number
  ): Promise<void> {
    // Reveal the panel if it exists
    if (this.view) {
      this.view.show(true);
    }

    // Set loading state with full context for potential refresh
    this.currentExplanation = {
      code,
      explanation: "",
      isLoading: true,
      languageId,
      context,
    };
    this.updateView();

    // Check cache first
    let explanation = this.cacheService.get(code);

    if (!explanation) {
      try {
        explanation = await this.aiService.explain(code, languageId, context);
        this.cacheService.set(code, explanation);
      } catch (err) {
        explanation = `Error: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    // Update state preserving languageId and context for refresh
    this.currentExplanation = {
      code,
      explanation,
      isLoading: false,
      languageId,
      context,
    };

    // Add to history
    const historyEntry: HistoryEntry = {
      id: this.generateId(),
      code,
      explanation,
      languageId,
      fileName: fileName.split("/").pop() || fileName,
      lineNumber,
      timestamp: Date.now(),
    };
    this.history.unshift(historyEntry);

    // Keep history limited to 20 entries
    if (this.history.length > 20) {
      this.history = this.history.slice(0, 20);
    }

    // Also surface in the conversation stream for a chat-like feel
    const now = Date.now();
    this.updateSessionConversation((messages) => {
      messages.push(
        {
          id: this.generateId(),
          role: "user",
          content: `Explain ${fileName.split("/").pop()}:${lineNumber}`,
          timestamp: now,
          kind: "explain",
        },
        {
          id: this.generateId(),
          role: "assistant",
          content: explanation,
          timestamp: now,
          kind: "explain",
        }
      );
      this.trimConversation(messages);
    });

    this.updateView();
  }

  /**
   * Refreshes the current explanation by fetching again from AI.
   * Uses stored languageId and context for accurate re-fetch.
   */
  private async refreshExplanation(): Promise<void> {
    if (!this.currentExplanation) return;

    const { code, languageId, context } = this.currentExplanation;

    // Delete only the current entry from cache instead of clearing all
    this.cacheService.delete(code);

    this.currentExplanation.isLoading = true;
    this.updateView();

    try {
      const explanation = await this.aiService.explain(
        code,
        languageId,
        context
      );
      this.cacheService.set(code, explanation);
      this.currentExplanation.explanation = explanation;
    } catch (err) {
      this.currentExplanation.explanation = `Error: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    this.currentExplanation.isLoading = false;
    this.updateView();
  }

  /**
   * Handles free-form questions from the side panel prompt.
   * Mirrors Copilot/Claude side panels with a lightweight chat stream.
   */
  private async handleAsk(
    question: string,
    options: {
      includeSelection: boolean;
      includeFile: boolean;
      targetPath?: string;
      writeMode?: WriteMode;
    }
  ): Promise<void> {
    const trimmed = question?.trim();
    if (!trimmed) return;

    const editor = vscode.window.activeTextEditor;
    const MAX_CHARS = 30_000;

    let contextInfo:
      | { languageId?: string; content?: string; truncated?: boolean }
      | undefined;

    if (editor) {
      const doc = editor.document;
      const selection = editor.selection;

      if (options.includeSelection && selection && !selection.isEmpty) {
        const content = doc.getText(selection);
        contextInfo = {
          languageId: doc.languageId,
          content,
          truncated: content.length > MAX_CHARS,
        };
      } else if (options.includeFile) {
        const full = doc.getText();
        const truncated = full.length > MAX_CHARS;
        const content = truncated ? full.slice(0, MAX_CHARS) : full;
        contextInfo = {
          languageId: doc.languageId,
          content,
          truncated,
        };
      }
    }

    const userEntry: ConversationEntry = {
      id: this.generateId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
      kind: "ask",
    };

    const assistantPlaceholder: ConversationEntry = {
      id: this.generateId(),
      role: "assistant",
      content: "Thinking…",
      timestamp: Date.now(),
      kind: "ask",
      pending: true,
    };

    this.updateSessionConversation((messages) => {
      messages.push(userEntry, assistantPlaceholder);
      this.trimConversation(messages);
    });

    this.askInFlight = true;
    this.updateView();

    try {
      const answer = await this.aiService.ask(
        trimmed,
        contextInfo,
        undefined,
        this.pythonFocus
      );

      await this.maybeWriteAnswer(answer, options);
      this.replaceConversationEntry(assistantPlaceholder.id, {
        ...assistantPlaceholder,
        content: answer,
        pending: false,
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.replaceConversationEntry(assistantPlaceholder.id, {
        ...assistantPlaceholder,
        content: `Error: ${message}`,
        pending: false,
        timestamp: Date.now(),
      });
    }

    this.askInFlight = false;
    this.updateView();
  }

  /**
   * Loads a history entry as the current explanation.
   */
  private loadHistoryEntry(id: string): void {
    const entry = this.history.find((h) => h.id === id);
    if (entry) {
      this.currentExplanation = {
        code: entry.code,
        explanation: entry.explanation,
        isLoading: false,
        languageId: entry.languageId,
        context: "", // History doesn't store context, but languageId is preserved
      };
      this.updateView();
    }
  }

  /**
   * Shows a message in the panel.
   */
  private showMessage(message: string): void {
    this.currentExplanation = {
      code: "",
      explanation: message,
      isLoading: false,
      languageId: "plaintext",
      context: "",
    };
    this.updateView();
  }

  /**
   * Updates the webview content.
   */
  private updateView(): void {
    if (this.view) {
      const activeSession = this.getActiveSession();
      this.view.webview.postMessage({
        type: "update",
        explanation: this.currentExplanation,
        history: this.history.slice(0, 10),
        conversation: activeSession.messages,
        sessions: this.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          createdAt: s.createdAt,
          messageCount: s.messages.length,
        })),
        activeSessionId: this.currentSessionId,
        contextHints: this.getContextHints(),
        busy: this.currentExplanation?.isLoading || this.askInFlight,
        pythonFocus: this.pythonFocus,
        allowFileWrites: this.allowFileWrites,
        fileOptions: this.fileOptions,
      });
    }
  }

  private loadSessions(): void {
    const stored = this.context.globalState.get<ChatSession[]>(
      SESSION_STORE_KEY,
      []
    );
    this.sessions = Array.isArray(stored) ? stored : [];

    if (this.sessions.length === 0) {
      const first = this.createSession("Session 1");
      this.sessions.push(first);
    }

    const storedActive = this.context.globalState.get<string | null>(
      SESSION_ACTIVE_KEY,
      null
    );
    if (storedActive && this.sessions.some((s) => s.id === storedActive)) {
      this.currentSessionId = storedActive;
    } else {
      this.currentSessionId = this.sessions[0].id;
    }

    void this.persistSessions();
  }

  private createSession(title?: string): ChatSession {
    const now = Date.now();
    return {
      id: this.generateId(),
      title: title ?? `Session ${this.sessions.length + 1}` ,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  private getActiveSession(): ChatSession {
    if (this.currentSessionId) {
      const existing = this.sessions.find((s) => s.id === this.currentSessionId);
      if (existing) return existing;
    }
    const fallback = this.createSession("Session 1");
    this.sessions.unshift(fallback);
    this.currentSessionId = fallback.id;
    void this.persistSessions();
    return fallback;
  }

  private setActiveSession(id: string): void {
    const found = this.sessions.find((s) => s.id === id);
    if (!found) return;
    this.currentSessionId = id;
    found.updatedAt = Date.now();
    void this.persistSessions();
  }

  private addSession(title?: string): void {
    const session = this.createSession(title);
    this.sessions.unshift(session);
    this.currentSessionId = session.id;
    void this.persistSessions();
  }

  private renameSession(id: string, title: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    session.title = title.trim() || session.title;
    session.updatedAt = Date.now();
    void this.persistSessions();
  }

  private clearCurrentConversation(): void {
    const session = this.getActiveSession();
    session.messages = [];
    session.updatedAt = Date.now();
    void this.persistSessions();
  }

  private persistSessions(): Promise<void> {
    // Keep most recently updated sessions at the top
    this.sessions = this.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all([
      this.context.globalState.update(SESSION_STORE_KEY, this.sessions),
      this.context.globalState.update(SESSION_ACTIVE_KEY, this.currentSessionId),
    ]).then(() => undefined);
  }

  private updateSessionConversation(
    updater: (messages: ConversationEntry[]) => void
  ): ConversationEntry[] {
    const session = this.getActiveSession();
    updater(session.messages);
    session.updatedAt = Date.now();
    void this.persistSessions();
    return session.messages;
  }

  private async loadFileOptions(): Promise<void> {
    try {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,.svn,.hg,.DS_Store,.venv,.tox,.next,out,dist,build,tmp,temp}/**",
        120
      );
      this.fileOptions = uris
        .map((u) => vscode.workspace.asRelativePath(u, false))
        .filter((p) => p && !p.endsWith("/"));
      this.updateView();
    } catch {
      // ignore listing errors
    }
  }

  private getContextHints(): {
    hasSelection: boolean;
    selectionLabel: string | null;
    hasFile: boolean;
    fileName: string | null;
  } {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        hasSelection: false,
        selectionLabel: null,
        hasFile: false,
        fileName: null,
      };
    }

    const selection = editor.selection;
    const hasSelection = selection && !selection.isEmpty;
    const selectionLines = hasSelection
      ? selection.end.line - selection.start.line + 1
      : 0;
    const selectionLabel = hasSelection
      ? `${selectionLines} line${selectionLines === 1 ? "" : "s"} selected`
      : null;

    return {
      hasSelection,
      selectionLabel,
      hasFile: true,
      fileName: editor.document.fileName.split("/").pop() ?? null,
    };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private replaceConversationEntry(
    id: string,
    replacement: ConversationEntry
  ): void {
    this.updateSessionConversation((messages) => {
      const idx = messages.findIndex((c) => c.id === id);
      if (idx >= 0) {
        messages[idx] = replacement;
      }
    });
  }

  private trimConversation(messages: ConversationEntry[]): void {
    const MAX_ENTRIES = 40;
    if (messages.length > MAX_ENTRIES) {
      messages.splice(0, messages.length - MAX_ENTRIES);
    }
  }

  /**
   * Returns the HTML for the webview panel.
   * Includes modern styling and interactive features.
   */
  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>PyAid panel</title>
  <style>
    :root {
      --surface: var(--vscode-sideBar-background);
      --card: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background));
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--surface);
      line-height: 1.5;
      overflow-y: auto;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 100%;
      padding-bottom: 12px;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--card) 90%, var(--accent) 8%), var(--card));
    }
    .title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
    }
    .title-row { display: flex; align-items: center; gap: 6px; }
    .title h1 { font-size: 14px; margin: 0; display:flex; align-items:center; gap:6px; }
    .subtitle { color: var(--muted); font-size: 12px; }
    .pill {
      border: 1px solid var(--border);
      color: var(--accent);
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .header-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .btn {
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--vscode-foreground);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: border-color 120ms ease, background 120ms ease;
    }
    .btn:hover { border-color: var(--accent); }
    .btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: transparent;
    }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn.ghost { background: transparent; }
    .section {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      padding: 12px;
    }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .muted { color: var(--muted); font-size: 12px; }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--vscode-editor-background);
      box-shadow: 0 1px 0 rgba(0,0,0,0.08);
    }
    .explanation-text { white-space: pre-wrap; word-wrap: break-word; }
    .code-preview {
      margin-top: 10px;
      padding: 10px;
      border-radius: 6px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--accent);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow: auto;
      max-height: 180px;
    }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    .spinner {
      width: 16px; height: 16px;
      border: 2px solid var(--vscode-progressBar-background);
      border-top: 2px solid var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .chat-stream { display: flex; flex-direction: column; gap: 8px; max-height: 40vh; overflow-y: auto; padding-right: 4px; }
    .session-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 0 4px; }
    .session-select { flex: 1; border: 1px solid var(--border); background: var(--vscode-editor-background); color: var(--vscode-foreground); border-radius: 6px; padding: 8px; font-family: var(--vscode-font-family); }
    .session-actions { display: flex; gap: 6px; }
    .bubble {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--vscode-editor-background);
      box-shadow: 0 1px 0 rgba(0,0,0,0.05);
    }
    .bubble.user { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
    .bubble.assistant { background: color-mix(in srgb, var(--card) 85%, var(--accent) 5%); }
    .bubble .meta { color: var(--muted); font-size: 11px; margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
    .bubble .content { white-space: pre-wrap; word-break: break-word; }
    .composer { display: flex; flex-direction: column; gap: 8px; }
    .composer textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-editor-background);
      resize: vertical;
      min-height: 64px;
      color: var(--vscode-foreground);
    }
    .composer-row { display: flex; gap: 8px; align-items: flex-start; }
    .composer-row button { height: 38px; }
    .chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    datalist option { color: var(--vscode-foreground); }
    .scope-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--card);
      font-size: 12px;
    }
    .hint { color: var(--muted); font-size: 12px; }
    .empty { text-align: center; color: var(--muted); padding: 16px; }
    .history-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .history-item { cursor: pointer; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--vscode-editor-background); }
    .history-item:hover { border-color: var(--accent); }
    .code-block { position: relative; margin: 8px 0; }
    .code-block pre { margin: 0; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--vscode-editor-background); overflow-x: auto; }
    .code-block button.copy-btn { position: absolute; top: 6px; right: 6px; border: 1px solid var(--border); background: var(--card); cursor: pointer; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="title">
        <div class="title-row">
          <span class="pill">Panel</span>
          <h1><img src="${this.iconUrl}" alt="PyAid" style="width:18px;height:18px;border-radius:4px;"> PyAid</h1>
        </div>
        <div class="subtitle">Ask, explain, and keep context pinned like a sidekick.</div>
      </div>
      <div class="header-actions">
        <button class="btn ghost" onclick="refreshExplanation()" id="refresh-btn">Refresh</button>
        <button class="btn primary" onclick="explainSelection()">Explain Selection</button>
        <button class="btn ghost" id="write-toggle" onclick="toggleWritePermission()">
          ${this.allowFileWrites ? "Allow writes: On" : "Allow writes: Off"}
        </button>
      </div>
    </div>

    <div class="section" id="live-section">
      <div class="section-title">
        <span>Current</span>
        <span class="muted" id="live-hint"></span>
      </div>
      <div id="live-card" class="card empty">Select code or ask a question to start.</div>
    </div>

    <div class="section">
      <div class="section-title">
        <span>Conversation</span>
        <button class="btn ghost" onclick="clearHistory()" style="font-size:11px; padding:4px 8px;">Clear Session</button>
      </div>
      <div class="session-bar">
        <select id="session-select" class="session-select"></select>
        <div class="session-actions">
          <button class="btn ghost" onclick="newSession()">New</button>
          <button class="btn ghost" onclick="renameSession()">Rename</button>
        </div>
      </div>
      <div id="chat-stream" class="chat-stream"></div>
    </div>

    <div class="section">
      <div class="section-title">
      <span>Ask Anything</span>
      <span class="muted" id="busy-indicator"></span>
    </div>
      <div class="scope-row">
        <button class="btn ghost" id="scope-toggle-inline" onclick="toggleScope()" aria-pressed="true">
          Python focus: On
        </button>
        <span class="hint">Python-heavy answers when on; general answers when off.</span>
      </div>
      <form id="composer" class="composer">
        <div class="hint" id="context-hint"></div>
        <div class="chips" id="write-controls" style="display:${this.allowFileWrites ? "flex" : "none"}">
          <label class="chip">
            Target file:
            <input list="file-options" type="text" id="target-file" placeholder="e.g. start.py" style="width:180px;">
            <datalist id="file-options"></datalist>
          </label>
          <label class="chip">
            Mode:
            <select id="write-mode">
              <option value="append">Append</option>
              <option value="replace">Replace</option>
              <option value="remove">Remove PyAid blocks</option>
            </select>
          </label>
          <span class="hint">Enabled when writes are allowed.</span>
        </div>
        <div class="composer-row">
          <textarea id="question" rows="3" placeholder="Ask about this code, a bug, or a concept…"></textarea>
          <button type="submit" class="btn primary" id="send-btn">Send</button>
        </div>
      </form>
    </div>

    <div class="section" id="history-section" style="display:none;">
      <div class="section-title" onclick="toggleHistory()" style="cursor:pointer;">
        <span>Recent Explanations</span>
        <span class="muted">Tap to load</span>
      </div>
      <ul class="history-list" id="history-list"></ul>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let latestContextHints = { fileName: null };
    let latestConversation = [];
    let thinkTimer = null;
    let thinkingIndex = 0;
    const thinkingEmojis = ["🤔", "🌀", "💭", "✨", "⌛"];
    let allowWrites = false;
    let messageFileOptions = [];
    let latestSessions = [];
    let activeSessionId = null;

    document.getElementById('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const question = document.getElementById('question').value;
      const includeSelection = true;
      const includeFile = true;
      const targetPath = document.getElementById('target-file').value || undefined;
      const writeMode = document.getElementById('write-mode').value || "append";
      vscode.postMessage({ command: 'ask', question, includeSelection, includeFile, targetPath, writeMode });
      document.getElementById('question').value = '';
    });
    document.getElementById('session-select').addEventListener('change', handleSessionChange);

    function explainSelection() { vscode.postMessage({ command: 'explainSelection' }); }
    function copyExplanation() { vscode.postMessage({ command: 'copy' }); }
    function refreshExplanation() { vscode.postMessage({ command: 'refresh' }); }
    function loadHistory(id) { vscode.postMessage({ command: 'loadHistory', id }); }
    function clearHistory() { vscode.postMessage({ command: 'clearHistory' }); }
    function toggleScope() { vscode.postMessage({ command: 'toggleScope' }); }
    function toggleHistory() {
      const section = document.getElementById('history-section');
      section.classList.toggle('open');
    }
    function toggleWritePermission() {
      vscode.postMessage({ command: 'toggleWritePermission', allow: !allowWrites });
    }

    function newSession() {
      const defaultName = 'Session ' + String((latestSessions?.length || 0) + 1);
      const title = prompt('Name this session', defaultName);
      if (title !== null) {
        vscode.postMessage({ command: 'newSession', title });
      }
    }

    function renameSession() {
      if (!activeSessionId) return;
      const current = latestSessions.find((s) => s.id === activeSessionId);
      const title = prompt('Rename session', current?.title || '');
      if (title !== null && title.trim().length > 0) {
        vscode.postMessage({ command: 'renameSession', id: activeSessionId, title });
      }
    }

    function handleSessionChange(event) {
      const id = event.target.value;
      if (id) {
        vscode.postMessage({ command: 'switchSession', id });
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text ?? '';
      return div.innerHTML;
    }

    function renderWithCodeBlocks(text) {
      if (!text) return "";
      const tick = String.fromCharCode(96);
      const fence = new RegExp(tick + tick + tick + "[\\s\\S]*?" + tick + tick + tick, "g");
      let out = "";
      let lastIndex = 0;
      let match;
      while ((match = fence.exec(text))) {
        // text before code block
        out += escapeHtml(text.slice(lastIndex, match.index));
        const code = match[0].slice(3, -3).trim();
        out +=
          '<div class="code-block"><button class="copy-btn" data-code="' +
          encodeURIComponent(code) +
          '">📋</button><pre><code>' +
          escapeHtml(code) +
          "</code></pre></div>";
        lastIndex = match.index + match[0].length;
      }
      out += escapeHtml(text.slice(lastIndex));
      return out;
    }

    function attachCopyButtons(root) {
      root.querySelectorAll('.copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const encoded = btn.getAttribute('data-code') || '';
          const decoded = decodeURIComponent(encoded);
          navigator.clipboard.writeText(decoded);
        });
      });
    }

    function formatTime(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function renderExplanation(explanation) {
      const liveCard = document.getElementById('live-card');
      const hint = document.getElementById('live-hint');
      if (!explanation || (!explanation.explanation && !explanation.isLoading)) {
        liveCard.className = 'card empty';
        liveCard.innerHTML = 'Select code or ask a question to start.';
        hint.textContent = '';
        return;
      }

      if (explanation.isLoading) {
        liveCard.className = 'card';
        liveCard.innerHTML = \`
          <div class="actions" style="align-items:center;">
            <div class="spinner"></div>
            <span>Generating explanation…</span>
          </div>\`;
        hint.textContent = 'Working';
        return;
      }

      const codePreview = explanation.code
        ? \`<div class="code-preview">\${escapeHtml(explanation.code)}</div>\`
        : '';

      liveCard.className = 'card';
      liveCard.innerHTML = \`
        <div class="explanation-text">\${renderWithCodeBlocks(explanation.explanation)}</div>
        \${codePreview}
        <div class="actions">
          <button class="btn" onclick="copyExplanation()">📋 Copy</button>
          <button class="btn" onclick="refreshExplanation()">🔄 Refresh</button>
        </div>
      \`;
      attachCopyButtons(liveCard);
      hint.textContent = explanation.languageId ? explanation.languageId : '';
    }

    function renderConversation(conversation) {
      latestConversation = conversation || [];
      const stream = document.getElementById('chat-stream');
      if (!conversation || conversation.length === 0) {
        stream.innerHTML = '<div class="empty">No chat yet. Ask a question or explain a selection to start a thread.</div>';
        return;
      }
      stream.innerHTML = conversation.map(entry => {
        const meta = \`\${entry.kind === 'ask' ? 'Ask' : 'Explain'} • \${formatTime(entry.timestamp)}\`;
        const status = entry.pending
          ? ' (' + thinkingEmojis[thinkingIndex % thinkingEmojis.length] + ' thinking…)'
          : '';
        const displayContent = renderWithCodeBlocks(entry.content);
        return \`
          <div class="bubble \${entry.role}">
            <div class="meta">\${meta}\${status}</div>
            <div class="content">\${displayContent}</div>
          </div>
        \`;
      }).join('');
      attachCopyButtons(stream);
      stream.scrollTop = stream.scrollHeight;
    }

    function renderHistory(history) {
      const section = document.getElementById('history-section');
      const list = document.getElementById('history-list');
      if (!history || history.length === 0) {
        section.style.display = 'none';
        return;
      }
      section.style.display = 'block';
      list.innerHTML = history.map(entry => \`
        <li class="history-item" onclick="loadHistory('\${entry.id}')">
          <div><strong>\${escapeHtml(entry.fileName)}</strong> · \${entry.lineNumber}</div>
          <div class="muted">\${escapeHtml(entry.code.substring(0, 80))}</div>
          <div class="muted">\${formatTime(entry.timestamp)}</div>
        </li>
      \`).join('');
    }

    function renderSessions(sessions, selectedId) {
      latestSessions = sessions || [];
      activeSessionId = selectedId || (latestSessions[0]?.id ?? null);
      const select = document.getElementById('session-select');
      if (!select) return;
      select.innerHTML = latestSessions
        .map((s) => {
          const time = new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const selected = s.id === activeSessionId ? 'selected' : '';
          return '<option value= + s.id +  ' + selected + '>' + escapeHtml(s.title) + ' • ' + time + '</option>';
        })
        .join('');
      select.value = activeSessionId || '';
    }

    function renderContextHints(hints) {
      latestContextHints = hints || latestContextHints;
      const targetInput = document.getElementById('target-file');
      const modeSelect = document.getElementById('write-mode');
      const datalist = document.getElementById('file-options');
      document.getElementById('context-hint').textContent = latestContextHints.fileName || '';
      document.getElementById('refresh-btn').style.display = 'inline-flex';
      targetInput.disabled = !allowWrites;
      modeSelect.disabled = !allowWrites;
      if (datalist && Array.isArray(messageFileOptions)) {
        datalist.innerHTML = messageFileOptions
          .map((opt) => '<option value="' + opt + '"></option>')
          .join('');
      }
    }

    function setBusy(isBusy) {
      document.getElementById('send-btn').disabled = isBusy;
      document.getElementById('busy-indicator').textContent = isBusy ? 'Working…' : '';
      if (isBusy) {
        startThinkCycle();
      } else {
        stopThinkCycle();
      }
    }

    function setScope(pythonOn) {
      const btn = document.getElementById('scope-toggle-inline');
      if (!btn) return;
      btn.setAttribute('aria-pressed', pythonOn ? 'true' : 'false');
      btn.textContent = pythonOn ? 'Python focus: On' : 'Python focus: Off';
      btn.classList.toggle('primary', pythonOn);
    }

    function setWriteToggle(enabled) {
      allowWrites = !!enabled;
      const btn = document.getElementById('write-toggle');
      if (btn) {
        btn.textContent = enabled ? 'Allow writes: On' : 'Allow writes: Off';
        btn.classList.toggle('primary', enabled);
      }
      const writeControls = document.getElementById('write-controls');
      if (writeControls) {
        writeControls.style.display = enabled ? 'flex' : 'none';
      }
      const tgt = document.getElementById('target-file');
      const mode = document.getElementById('write-mode');
      if (tgt) tgt.disabled = !enabled;
      if (mode) mode.disabled = !enabled;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        renderExplanation(message.explanation);
        renderSessions(message.sessions, message.activeSessionId);
        renderConversation(message.conversation);
        renderHistory(message.history);
        renderContextHints(message.contextHints);
        setBusy(!!message.busy);
        setScope(!!message.pythonFocus);
        messageFileOptions = message.fileOptions || [];
        setWriteToggle(!!message.allowFileWrites);
      }
    });

    function startThinkCycle() {
      if (thinkTimer) return;
      thinkTimer = setInterval(() => {
        thinkingIndex = (thinkingIndex + 1) % thinkingEmojis.length;
        renderConversation(latestConversation);
      }, 800);
    }

    function stopThinkCycle() {
      if (thinkTimer) {
        clearInterval(thinkTimer);
        thinkTimer = null;
      }
      thinkingIndex = 0;
    }
  </script>
</body>
</html>`;
  }

  /**
   * Toggles Python-focused answers for free-form questions.
   * Persists to user settings so it survives reloads.
   */
  private async toggleScope(): Promise<void> {
    this.pythonFocus = !this.pythonFocus;
    await vscode.workspace
      .getConfiguration("pyaid")
      .update("askPythonMode", this.pythonFocus, vscode.ConfigurationTarget.Global);
    this.updateView();
  }

  private async setAllowFileWrites(enabled: boolean): Promise<void> {
    this.allowFileWrites = enabled;
    await this.context.globalState.update(ALLOW_WRITE_KEY, enabled);
    this.updateView();
  }

  /**
   * Writes a snippet directly into the active editor when possible.
   * Returns true if an edit was applied (and saved), false otherwise.
   */
  private async writeSnippetToEditor(
    snippet: string,
    mode: WriteMode
  ): Promise<boolean> {
    if (mode === "remove") return false;
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!editor || !doc) return false;

    const edit = new vscode.WorkspaceEdit();
    const uri = doc.uri;

    if (mode === "replace") {
      if (editor.selection && !editor.selection.isEmpty) {
        edit.replace(uri, editor.selection, snippet);
      } else {
        const lastLine = doc.lineCount - 1;
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(
            lastLine,
            doc.lineAt(Math.max(lastLine, 0)).text.length
          )
        );
        edit.replace(uri, fullRange, snippet);
      }
    } else {
      const insertPos = editor.selection?.end ?? new vscode.Position(
        doc.lineCount,
        doc.lineAt(Math.max(doc.lineCount - 1, 0)).text.length
      );
      const toInsert = snippet.endsWith("\n") ? snippet : snippet + "\n";
      edit.insert(uri, insertPos, toInsert);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await doc.save().catch(() => {/* ignore save errors */});
      void vscode.window.showInformationMessage("PyAid wrote to editor");
      return true;
    }
    return false;
  }

  /**
   * Centralized write logic: append, replace (after removing existing PyAid blocks),
   * or remove previously written PyAid blocks.
   */
  private async maybeWriteAnswer(
    answer: string,
    options: { targetPath?: string; writeMode?: WriteMode }
  ): Promise<void> {
    if (!this.allowFileWrites) return;
    const mode = options.writeMode ?? "append";
    const targetPath = this.resolveTargetPath(options.targetPath);
    const snippet = mode === "remove" ? "" : this.extractCodeSnippet(answer) ?? answer;

    // Removal path
    if (mode === "remove") {
      if (!targetPath) {
        void vscode.window.showWarningMessage(
          "PyAid: Choose a target file to remove PyAid code from."
        );
        return;
      }
      await removePyAidBlocks(targetPath).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`PyAid remove failed: ${msg}`);
      });
      return;
    }

    if (!snippet || snippet.trim().length === 0) {
      void vscode.window.showWarningMessage("PyAid: No code block found to write.");
      return;
    }

    const payload = targetPath
      ? this.wrapWithMarkers(snippet, targetPath)
      : snippet;

    if (targetPath) {
      if (mode === "replace") {
        await removePyAidBlocks(targetPath).catch(() => {});
      }
      const finalPayload =
        mode === "append"
          ? payload.endsWith("\n") ? payload : payload + "\n"
          : payload;
      await writeWithConsent(targetPath, finalPayload, mode, true).catch(
        (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`PyAid write failed: ${msg}`);
        }
      );
      return;
    }

    // No target path: write into active editor
    await this.writeSnippetToEditor(snippet, mode);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Alternative: Floating Webview Panel.
 * Opens beside the current editor and behaves like a chat-first assistant.
 */
export class FloatingPanelProvider implements vscode.Disposable {
  private readonly aiService = new AIService();
  private readonly cacheService = new CacheService();
  private readonly contextExtractor = new ContextExtractor();

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private pythonFocus = true;
  private allowFileWrites = false;
  private fileOptions: string[] = [];
  private iconUrl = "";
  private cspSource = "";
  private sessions: FloatingChatSession[] = [];
  private activeSessionId: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    this.allowFileWrites = this.context.globalState.get<boolean>(
      ALLOW_WRITE_KEY,
      false
    );
    this.loadSessions();
    void this.loadFileOptions();
  }

  private loadSessions(): void {
    const stored = this.context.globalState.get<FloatingChatSession[]>(
      FLOATING_SESSION_STORE_KEY,
      []
    );
    this.sessions = Array.isArray(stored) ? stored : [];

    if (this.sessions.length === 0) {
      const session = this.createSession("Session 1");
      this.sessions.push(session);
    }

    const active = this.context.globalState.get<string | null>(
      FLOATING_SESSION_ACTIVE_KEY,
      null
    );
    if (active && this.sessions.some((s) => s.id === active)) {
      this.activeSessionId = active;
    } else {
      this.activeSessionId = this.sessions[0].id;
    }

    void this.persistSessions();
  }

  private createSession(title?: string): FloatingChatSession {
    const now = Date.now();
    return {
      id: this.generateId(),
      title: title ?? `Session ${this.sessions.length + 1}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  private getActiveSession(): FloatingChatSession {
    if (this.activeSessionId) {
      const found = this.sessions.find((s) => s.id === this.activeSessionId);
      if (found) return found;
    }
    const fallback = this.createSession("Session 1");
    this.sessions.unshift(fallback);
    this.activeSessionId = fallback.id;
    void this.persistSessions();
    return fallback;
  }

  private updateSessionMessages(
    updater: (messages: FloatingConversationEntry[]) => void
  ): void {
    const session = this.getActiveSession();
    updater(session.messages);
    this.trimMessages(session.messages);
    session.updatedAt = Date.now();
    void this.persistSessions();
  }

  private addSession(title?: string): void {
    const session = this.createSession(title);
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    void this.persistSessions();
  }

  private switchSession(id: string): void {
    const found = this.sessions.find((s) => s.id === id);
    if (!found) return;
    this.activeSessionId = id;
    found.updatedAt = Date.now();
    void this.persistSessions();
  }

  private renameSession(id: string, title: string): void {
    const found = this.sessions.find((s) => s.id === id);
    if (!found) return;
    const nextTitle = title.trim();
    if (!nextTitle) return;
    found.title = nextTitle;
    found.updatedAt = Date.now();
    void this.persistSessions();
  }

  private deleteSession(id: string): void {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;

    this.sessions.splice(idx, 1);

    if (this.sessions.length === 0) {
      const fallback = this.createSession("Session 1");
      this.sessions.push(fallback);
      this.activeSessionId = fallback.id;
    } else if (this.activeSessionId === id) {
      this.activeSessionId = this.sessions[0].id;
    }

    void this.persistSessions();
  }

  private clearActiveSession(): void {
    const session = this.getActiveSession();
    session.messages = [];
    session.updatedAt = Date.now();
    void this.persistSessions();
  }

  private persistSessions(): Promise<void> {
    this.sessions = this.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all([
      this.context.globalState.update(FLOATING_SESSION_STORE_KEY, this.sessions),
      this.context.globalState.update(FLOATING_SESSION_ACTIVE_KEY, this.activeSessionId),
    ]).then(() => undefined);
  }

  private trimMessages(messages: FloatingConversationEntry[]): void {
    const MAX = 60;
    if (messages.length > MAX) {
      messages.splice(0, messages.length - MAX);
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private async loadFileOptions(): Promise<void> {
    try {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,.svn,.hg,.DS_Store,.venv,.tox,.next,out,dist,build,tmp,temp}/**",
        120
      );
      this.fileOptions = uris
        .map((u) => vscode.workspace.asRelativePath(u, false))
        .filter((f) => f && !f.endsWith("/"));
    } catch {
      this.fileOptions = [];
    }
  }

  openPanel(): void {
    const config = vscode.workspace.getConfiguration("pyaid");
    this.pythonFocus = config.get("askPythonMode", true);
    this.ensurePanel();
    this.panel!.webview.html = this.renderChatHtml();
    this.evenEditorWidths();
  }

  async showExplanation(code?: string, context?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor && !code) {
      vscode.window.showWarningMessage("No code to explain");
      return;
    }

    if (!code && editor) {
      const selection = editor.selection;
      if (!selection.isEmpty) {
        code = editor.document.getText(selection).trim();
        context = "";
      } else {
        const extracted = this.contextExtractor.extract(
          editor.document,
          selection.active
        );
        code = extracted.code;
        context = extracted.context;
      }
    }

    if (!code || code.length === 0) {
      vscode.window.showWarningMessage("No code selected");
      return;
    }

    this.ensurePanel();
    this.panel!.reveal(vscode.ViewColumn.Beside);
    this.evenEditorWidths();

    const languageId = editor?.document.languageId ?? "plaintext";
    const fileLabel = editor?.document.fileName.split("/").pop() ?? "selection";
    const userPrompt = `Explain ${fileLabel} (${languageId})`;

    const userEntry: FloatingConversationEntry = {
      id: this.generateId(),
      role: "user",
      content: userPrompt,
      timestamp: Date.now(),
    };
    const placeholder: FloatingConversationEntry = {
      id: this.generateId(),
      role: "assistant",
      content: "Thinking...",
      timestamp: Date.now(),
      pending: true,
    };

    this.updateSessionMessages((messages) => {
      messages.push(userEntry, placeholder);
    });
    this.panel!.webview.html = this.renderChatHtml(true);

    let explanation = this.cacheService.get(code);
    if (!explanation) {
      try {
        explanation = await this.aiService.explain(code, languageId, context ?? "");
        this.cacheService.set(code, explanation);
      } catch (err) {
        explanation = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    this.updateSessionMessages((messages) => {
      const idx = messages.findIndex((m) => m.id === placeholder.id);
      if (idx >= 0) {
        messages[idx] = {
          ...placeholder,
          content: `${explanation}\n\nCode:\n\`\`\`${languageId}\n${code}\n\`\`\``,
          pending: false,
          timestamp: Date.now(),
        };
      }
    });

    this.panel!.webview.html = this.renderChatHtml();
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "pyaid.floatingPanel",
      "PyAid",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      null,
      this.disposables
    );

    this.iconUrl = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "pyaid.png"))
      .toString();
    this.cspSource = this.panel.webview.cspSource;

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "copy":
            if (typeof message.text === "string") {
              await vscode.env.clipboard.writeText(message.text);
              void vscode.window.showInformationMessage("Copied to clipboard");
            }
            break;
          case "ask":
            if (typeof message.text === "string") {
              await this.handleAsk(message.text, {
                includeSelection: Boolean(message.includeSelection),
                includeFile: Boolean(message.includeFile),
                targetPath: message.targetPath,
                writeMode: message.writeMode,
              });
            }
            break;
          case "clearSession":
            this.clearActiveSession();
            this.panel!.webview.html = this.renderChatHtml();
            break;
          case "newSession":
            this.addSession(
              typeof message.title === "string" ? message.title : undefined
            );
            this.panel!.webview.html = this.renderChatHtml();
            break;
          case "switchSession":
            if (typeof message.id === "string") {
              this.switchSession(message.id);
              this.panel!.webview.html = this.renderChatHtml();
            }
            break;
          case "renameSession":
            if (
              typeof message.id === "string" &&
              typeof message.title === "string"
            ) {
              this.renameSession(message.id, message.title);
              this.panel!.webview.html = this.renderChatHtml();
            }
            break;
          case "deleteSession":
            if (typeof message.id === "string") {
              this.deleteSession(message.id);
              this.panel!.webview.html = this.renderChatHtml();
            }
            break;
          case "toggleScope":
            await this.toggleScope();
            break;
          case "toggleWritePermission":
            await this.setAllowFileWrites(
              typeof message.allow === "boolean"
                ? message.allow
                : !this.allowFileWrites
            );
            break;
          case "explainSelection":
            await this.showExplanation();
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private async setAllowFileWrites(enabled: boolean): Promise<void> {
    this.allowFileWrites = enabled;
    await this.context.globalState.update(ALLOW_WRITE_KEY, enabled);
    if (this.panel) {
      this.panel.webview.html = this.renderChatHtml();
    }
  }

  private evenEditorWidths(): void {
    void vscode.commands.executeCommand("workbench.action.evenEditorWidths");
  }

  private renderChatHtml(showTyping = false): string {
    const active = this.getActiveSession();
    const sessionsHtml = this.sessions
      .map((session) => {
        const activeClass = session.id === this.activeSessionId ? "active" : "";
        const encodedTitle = encodeURIComponent(session.title);
        return `<div class="session-row ${activeClass}"><button class="session-item" data-session="${session.id}" data-title="${encodedTitle}"><span>${this.escapeHtml(
          session.title
        )}</span><small>${session.messages.length}</small></button><button class="session-delete" data-delete-session="${session.id}" aria-label="Delete session">X</button></div>`;
      })
      .join("");

    const messagesHtml = active.messages
      .map((message) => {
        const who = message.role === "user" ? "You" : "PyAid";
        const bubbleClass = message.role === "user" ? "user" : "assistant";
        const pending = message.pending ? " pending" : "";
        const content = this.markdownToHtml(message.content);
        const encoded = encodeURIComponent(message.content);
        return `<article class="msg ${bubbleClass}${pending}"><header><span>${who}</span><time>${new Date(
          message.timestamp
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header><div class="content">${content}</div><footer><button type="button" class="mini" data-copy="${encoded}">Copy</button></footer></article>`;
      })
      .join("");

    const typingHtml = showTyping
      ? `<article class="msg assistant pending"><header><span>PyAid</span><time>now</time></header><div class="content"><p>Thinking...</p></div></article>`
      : "";

    const optionsHtml = this.fileOptions
      .map((opt) => `<option value="${this.escapeHtml(opt)}"></option>`)
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-webview-resource: https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root {
      --bg: #0f1318;
      --panel: #151b22;
      --panel-2: #1b2430;
      --border: #2b3a4d;
      --text: #e6edf3;
      --muted: #98a6b8;
      --accent: #3fb950;
      --user: #113a5f;
      --assistant: #18222d;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: "Segoe UI", "SF Pro Text", sans-serif;
      color: var(--text);
      background:
        radial-gradient(120% 120% at 5% 0%, #1b2a3a 0%, transparent 42%),
        radial-gradient(120% 120% at 95% 100%, #123329 0%, transparent 46%),
        var(--bg);
    }
    .layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; }
    .rail {
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel) 90%, #0a0d11);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow: auto;
    }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: 0.2px; }
    .brand img { width: 18px; height: 18px; border-radius: 4px; }
    .rail-actions { display: flex; gap: 6px; }
    .session-list { display: flex; flex-direction: column; gap: 6px; }
    .session-row { display: flex; align-items: center; gap: 6px; }
    .session-row.active .session-item { border-color: var(--accent); background: color-mix(in srgb, var(--panel) 80%, var(--accent) 20%); }
    .session-item {
      flex: 1; text-align: left; border: 1px solid var(--border); background: var(--panel);
      color: var(--text); border-radius: 10px; padding: 8px 10px; cursor: pointer;
      display: flex; justify-content: space-between; align-items: center;
      min-width: 0;
    }
    .session-item small { color: var(--muted); }
    .session-delete {
      width: 28px; min-width: 28px; height: 28px; padding: 0;
      border-radius: 8px; border: 1px solid var(--border);
      background: #22161a; color: #f5c2c7; font-weight: 700;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .session-delete:hover { border-color: #e5534b; color: #ff938a; }
    .main { display: grid; grid-template-rows: auto 1fr auto; min-height: 0; }
    .topbar {
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: color-mix(in srgb, var(--panel-2) 90%, #0c1016);
      gap: 8px;
      flex-wrap: wrap;
    }
    .top-left { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .chip { border: 1px solid var(--border); color: var(--muted); border-radius: 999px; padding: 3px 8px; font-size: 12px; }
    .chat { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; min-height: 0; scroll-behavior: smooth; overscroll-behavior: contain; }
    .msg {
      max-width: min(860px, 92%);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 10px 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .msg.user { margin-left: auto; background: var(--user); }
    .msg.assistant { margin-right: auto; background: var(--assistant); }
    .msg.pending { opacity: 0.85; }
    .msg header { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .msg .content { white-space: pre-wrap; word-break: break-word; }
    .msg footer { margin-top: 8px; display: flex; justify-content: flex-end; }
    .code-block { border: 1px solid var(--border); border-radius: 10px; background: #0f1720; padding: 10px; overflow: auto; }
    .composer {
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--panel-2) 86%, #0c1016);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    textarea {
      width: 100%; min-height: 84px; resize: vertical;
      border: 1px solid var(--border); background: #0f1720; color: var(--text);
      border-radius: 10px; padding: 10px; font-family: "JetBrains Mono", "SF Mono", monospace;
    }
    button {
      border: 1px solid var(--border);
      background: #101923;
      color: var(--text);
      border-radius: 9px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: #175227; border-color: #2b8a3e; }
    button.mini { padding: 4px 8px; font-size: 12px; }
    .muted { color: var(--muted); font-size: 12px; }
    .empty { color: var(--muted); border: 1px dashed var(--border); border-radius: 12px; padding: 16px; }
    .write-controls { display: ${this.allowFileWrites ? "flex" : "none"}; }
    input, select {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      background: #0f1720;
      color: var(--text);
    }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .rail { border-right: 0; border-bottom: 1px solid var(--border); }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="rail">
      <div class="brand"><img src="${this.iconUrl}" alt="PyAid">PyAid</div>
      <div class="rail-actions">
        <input type="text" id="session-title" placeholder="Session name" value="${this.escapeHtml(active.title)}" style="flex:1; min-width: 0;">
        <button type="button" id="new-session">New</button>
        <button type="button" id="rename-session">Rename</button>
      </div>
      <div class="session-list">${sessionsHtml}</div>
      <div class="muted">Sessions are persisted across VS Code reloads.</div>
    </aside>

    <section class="main">
      <div class="topbar">
        <div class="top-left">
          <span class="chip">${this.escapeHtml(active.title)}</span>
          <button type="button" id="scope-toggle">${
            this.pythonFocus ? "Python Focus: On" : "Python Focus: Off"
          }</button>
          <button type="button" id="write-toggle">${
            this.allowFileWrites ? "Writes: On" : "Writes: Off"
          }</button>
          <button type="button" id="explain-selection">Explain Selection</button>
        </div>
        <button type="button" id="clear-session">Clear Session</button>
      </div>

      <div class="chat" id="chat">
        ${messagesHtml || '<div class="empty">Start a conversation. Ask a Python question, debugging task, or architecture question.</div>'}
        ${typingHtml}
      </div>

      <form id="ask-form" class="composer">
        <div class="row write-controls" id="write-controls">
          <label class="muted">Target file</label>
          <input list="file-options" type="text" id="target-file" placeholder="e.g. src/main.py" style="min-width:220px;" ${
            this.allowFileWrites ? "" : "disabled"
          }>
          <datalist id="file-options">${optionsHtml}</datalist>
          <label class="muted">Mode</label>
          <select id="write-mode" ${this.allowFileWrites ? "" : "disabled"}>
            <option value="append">Append</option>
            <option value="replace">Replace</option>
            <option value="remove">Remove PyAid blocks</option>
          </select>
        </div>
        <textarea id="ask-input" placeholder="Ask PyAid about Python, debugging, refactors, tests, or design decisions..."></textarea>
        <div class="row">
          <button type="submit" class="primary">Send</button>
          <span class="muted">Context includes active selection and current file when available.</span>
        </div>
      </form>
    </section>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const activeSessionId = ${JSON.stringify(this.activeSessionId)};
    const activeSessionTitle = ${JSON.stringify(active.title)};

    const chatEl = document.getElementById('chat');
    const scrollChatToBottom = () => {
      if (!chatEl) return;
      chatEl.scrollTop = chatEl.scrollHeight;
    };

    requestAnimationFrame(() => scrollChatToBottom());
    window.addEventListener('load', scrollChatToBottom);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => scrollChatToBottom());
    }

    document.querySelectorAll('[data-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-session');
        if (id) vscode.postMessage({ command: 'switchSession', id });
      });
    });

    document.querySelectorAll('[data-delete-session]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = btn.getAttribute('data-delete-session');
        if (id) vscode.postMessage({ command: 'deleteSession', id });
      });
    });

    const sessionTitleInput = document.getElementById('session-title');

    document.getElementById('new-session')?.addEventListener('click', () => {
      const title = sessionTitleInput?.value?.trim();
      vscode.postMessage({
        command: 'newSession',
        title: title && title.length > 0 ? title : undefined,
      });
      if (sessionTitleInput) sessionTitleInput.value = '';
    });

    document.getElementById('rename-session')?.addEventListener('click', () => {
      if (!activeSessionId) return;
      const title = sessionTitleInput?.value?.trim() || '';
      if (!title) return;
      vscode.postMessage({ command: 'renameSession', id: activeSessionId, title });
    });

    document.getElementById('clear-session')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'clearSession' });
    });

    document.getElementById('scope-toggle')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleScope' });
    });

    document.getElementById('write-toggle')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleWritePermission' });
    });

    document.getElementById('explain-selection')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'explainSelection' });
    });

    document.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.getAttribute('data-copy') || '';
        vscode.postMessage({ command: 'copy', text: decodeURIComponent(value) });
      });
    });

    const form = document.getElementById('ask-form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = document.getElementById('ask-input');
      const text = input.value || '';
      if (!text.trim()) return;
      const targetInput = document.getElementById('target-file');
      const modeSelect = document.getElementById('write-mode');
      vscode.postMessage({
        command: 'ask',
        text,
        includeSelection: true,
        includeFile: true,
        targetPath: targetInput ? targetInput.value || undefined : undefined,
        writeMode: modeSelect ? modeSelect.value || 'append' : 'append'
      });
      input.value = '';
    });
  </script>
</body>
</html>`;
  }

  private async handleAsk(
    question: string,
    opts: {
      includeSelection: boolean;
      includeFile: boolean;
      targetPath?: string;
      writeMode?: WriteMode;
    }
  ): Promise<void> {
    const trimmed = question?.trim();
    if (!trimmed) {
      void vscode.window.showWarningMessage("Enter a question to ask PyAid.");
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;

    const selectionText =
      opts.includeSelection && editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection).trim()
        : "";

    const contextInfo =
      opts.includeFile && doc
        ? (() => {
            const MAX_CHARS = 30_000;
            const full = doc.getText();
            const truncated = full.length > MAX_CHARS;
            return {
              languageId: doc.languageId,
              content: truncated ? full.slice(0, MAX_CHARS) : full,
              truncated,
            };
          })()
        : undefined;

    const augmentedQuestion =
      selectionText.length > 0
        ? `${trimmed}\n\nSelected code:\n${selectionText}`
        : trimmed;

    if (!this.panel) {
      this.ensurePanel();
    }

    const userEntry: FloatingConversationEntry = {
      id: this.generateId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    };
    const placeholder: FloatingConversationEntry = {
      id: this.generateId(),
      role: "assistant",
      content: "Thinking...",
      timestamp: Date.now(),
      pending: true,
    };

    this.updateSessionMessages((messages) => {
      messages.push(userEntry, placeholder);
    });
    this.panel!.webview.html = this.renderChatHtml(true);

    try {
      const historyContext = this.buildHistoryContext();
      const answer = await this.aiService.ask(
        `${historyContext}\nCurrent question: ${augmentedQuestion}`,
        contextInfo,
        undefined,
        this.pythonFocus
      );

      await this.maybeWriteAnswer(answer, opts);

      this.updateSessionMessages((messages) => {
        const idx = messages.findIndex((m) => m.id === placeholder.id);
        if (idx >= 0) {
          messages[idx] = {
            ...placeholder,
            content: answer,
            pending: false,
            timestamp: Date.now(),
          };
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateSessionMessages((messages) => {
        const idx = messages.findIndex((m) => m.id === placeholder.id);
        if (idx >= 0) {
          messages[idx] = {
            ...placeholder,
            content: `Error: ${message}`,
            pending: false,
            timestamp: Date.now(),
          };
        }
      });
    }

    this.panel!.webview.html = this.renderChatHtml();
  }

  private buildHistoryContext(): string {
    const active = this.getActiveSession();
    const recent = active.messages.filter((m) => !m.pending).slice(-8);
    const lines = recent.map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    );
    return lines.length ? `Previous conversation:\n${lines.join("\n")}\n` : "";
  }

  private extractCodeSnippet(answer: string): string | null {
    const fenced =
      answer.match(/```(?:[^\n`]*)\n([\s\S]*?)```/) ??
      answer.match(/```([\s\S]*?)```/);
    if (fenced && fenced[1]) return fenced[1].trim();

    const inline = answer.match(/`([^`]+)`/);
    if (inline && inline[1]) return inline[1].trim();

    return null;
  }

  private resolveTargetPath(provided?: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (provided && provided.trim().length > 0) {
      const p = provided.trim();
      if (path.isAbsolute(p)) return p;
      if (workspaceFolders && workspaceFolders.length > 0) {
        return path.join(workspaceFolders[0].uri.fsPath, p);
      }
      if (editor) {
        return path.join(path.dirname(editor.document.uri.fsPath), p);
      }
      return path.resolve(p);
    }

    if (editor) {
      return editor.document.uri.fsPath;
    }
    return undefined;
  }

  private async writeSnippetToEditor(
    snippet: string,
    mode: WriteMode
  ): Promise<boolean> {
    if (mode === "remove") return false;
    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (!editor || !doc) return false;

    const edit = new vscode.WorkspaceEdit();
    const uri = doc.uri;

    if (mode === "replace") {
      if (editor.selection && !editor.selection.isEmpty) {
        edit.replace(uri, editor.selection, snippet);
      } else {
        const lastLine = doc.lineCount - 1;
        const fullRange = new vscode.Range(
          new vscode.Position(0, 0),
          new vscode.Position(
            lastLine,
            doc.lineAt(Math.max(lastLine, 0)).text.length
          )
        );
        edit.replace(uri, fullRange, snippet);
      }
    } else {
      const insertPos =
        editor.selection?.end ??
        new vscode.Position(
          doc.lineCount,
          doc.lineAt(Math.max(doc.lineCount - 1, 0)).text.length
        );
      const toInsert = snippet.endsWith("\n") ? snippet : snippet + "\n";
      edit.insert(uri, insertPos, toInsert);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await doc.save().catch(() => {
        /* ignore */
      });
      void vscode.window.showInformationMessage("PyAid wrote to editor");
      return true;
    }
    return false;
  }

  private commentPrefix(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if ([".py", ".sh", ".rb", ".pl"].includes(ext)) return "#";
    if (
      [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".cjs",
        ".mjs",
        ".java",
        ".go",
        ".c",
        ".cc",
        ".cpp",
        ".h",
        ".hpp",
      ].includes(ext)
    )
      return "//";
    return "//";
  }

  private wrapWithMarkers(snippet: string, targetPath: string): string {
    const prefix = this.commentPrefix(targetPath);
    const start = `${prefix} PyAid:start`;
    const end = `${prefix} PyAid:end`;
    const body = snippet.trimEnd();
    return `${start}\n${body}\n${end}\n`;
  }

  private async maybeWriteAnswer(
    answer: string,
    options: { targetPath?: string; writeMode?: WriteMode }
  ): Promise<void> {
    if (!this.allowFileWrites) return;
    const mode = options.writeMode ?? "append";
    const targetPath = this.resolveTargetPath(options.targetPath);
    const snippet =
      mode === "remove" ? "" : this.extractCodeSnippet(answer) ?? answer;

    if (mode === "remove") {
      if (!targetPath) {
        void vscode.window.showWarningMessage(
          "PyAid: Choose a target file to remove PyAid code from."
        );
        return;
      }
      await removePyAidBlocks(targetPath).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`PyAid remove failed: ${msg}`);
      });
      return;
    }

    if (!snippet || snippet.trim().length === 0) {
      void vscode.window.showWarningMessage("PyAid: No code block found to write.");
      return;
    }

    const payload = targetPath
      ? this.wrapWithMarkers(snippet, targetPath)
      : snippet;

    if (targetPath) {
      if (mode === "replace") {
        await removePyAidBlocks(targetPath).catch(() => {});
      }
      const finalPayload =
        mode === "append"
          ? payload.endsWith("\n")
            ? payload
            : payload + "\n"
          : payload;
      await writeWithConsent(targetPath, finalPayload, mode, true).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`PyAid write failed: ${msg}`);
      });
      return;
    }

    await this.writeSnippetToEditor(snippet, mode);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private markdownToHtml(md: string): string {
    const codeBlocks: string[] = [];
    md = md.replace(/```([\s\S]*?)```/g, (_m, code) => {
      const idx = codeBlocks.push(
        `<pre class="code-block"><code>${this.escapeHtml(
          String(code).trim()
        )}</code></pre>`
      );
      return `__CODE_BLOCK_${idx - 1}__`;
    });

    let html = this.escapeHtml(md);
    html = html.replace(/^###\s+(.*)$/gm, "<h3>$1</h3>");
    html = html.replace(/^##\s+(.*)$/gm, "<h2>$1</h2>");
    html = html.replace(/^#\s+(.*)$/gm, "<h1>$1</h1>");
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
    html = html.replace(/^\*\s+(.*)$/gm, "<ul><li>$1</li></ul>");
    html = html.replace(/\n{2,}/g, "</p><p>");
    html = `<p>${html}</p>`;
    html = html.replace(
      /__CODE_BLOCK_(\d+)__/g,
      (_m, i) => codeBlocks[Number(i)] ?? ""
    );
    return html;
  }

  private async toggleScope(): Promise<void> {
    this.pythonFocus = !this.pythonFocus;
    await vscode.workspace
      .getConfiguration("pyaid")
      .update("askPythonMode", this.pythonFocus, vscode.ConfigurationTarget.Global);
    if (this.panel) {
      this.panel.webview.html = this.renderChatHtml();
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
