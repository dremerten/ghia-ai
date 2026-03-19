import * as vscode from "vscode";
import { AIService } from "../services/aiService";
import { CacheService } from "../services/cacheService";
import { ContextExtractor } from "../utils/contextExtractor";
import { writeWithConsent } from "../utils/fileWriter";

export const ALLOW_WRITE_KEY = "ghiaAI.allowFileWrites";

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
  public static readonly viewType = "ghia-ai.explanationPanel";

  private readonly aiService = new AIService();
  private readonly cacheService = new CacheService();
  private readonly contextExtractor = new ContextExtractor();

  private view?: vscode.WebviewView;
  private iconUrl = "";
  private history: HistoryEntry[] = [];
  private conversation: ConversationEntry[] = [];
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

    // Preload file options
    void this.loadFileOptions();
  }

  /**
   * Extracts the first fenced code block content from a markdown string.
   */
  private extractCodeSnippet(answer: string): string | null {
    const match = answer.match(/```[a-zA-Z0-9_-]*\\n([\\s\\S]*?)```/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return null;
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
        vscode.Uri.joinPath(this.extensionUri, "media", "ghia-ai.png")
      )
      .toString();

    const config = vscode.workspace.getConfiguration("ghiaAI");
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
            this.conversation = [];
            this.updateView();
            break;
          case "explainSelection":
            await this.explainCurrentSelection();
            break;
      case "ask":
        await this.handleAsk(message.question, {
          includeSelection: Boolean(message.includeSelection),
          includeFile: Boolean(message.includeFile),
        });
        break;
      case "toggleScope":
        await this.toggleScope();
        break;
      case "toggleWritePermission":
        this.setAllowFileWrites(Boolean(message.allow));
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
    this.conversation.push(
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
    this.trimConversation();

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
      writeMode?: "append" | "replace";
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

    this.conversation.push(userEntry, assistantPlaceholder);
    this.trimConversation();

    this.askInFlight = true;
    this.updateView();

    try {
      const answer = await this.aiService.ask(
        trimmed,
        contextInfo,
        undefined,
        this.pythonFocus
      );

      // Optional: write answer to file when allowed and target provided
      if (this.allowFileWrites && options.targetPath) {
        try {
          const snippet = this.extractCodeSnippet(answer) ?? answer;
          await writeWithConsent(
            options.targetPath,
            snippet,
            options.writeMode ?? "append",
            true
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`ghia-ai write failed: ${msg}`);
        }
      }
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
      this.view.webview.postMessage({
        type: "update",
        explanation: this.currentExplanation,
        history: this.history.slice(0, 10),
        conversation: this.conversation,
        contextHints: this.getContextHints(),
        busy: this.currentExplanation?.isLoading || this.askInFlight,
        pythonFocus: this.pythonFocus,
        allowFileWrites: this.allowFileWrites,
        fileOptions: this.fileOptions,
      });
    }
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
    const idx = this.conversation.findIndex((c) => c.id === id);
    if (idx >= 0) {
      this.conversation[idx] = replacement;
    }
  }

  private trimConversation(): void {
    const MAX_ENTRIES = 40;
    if (this.conversation.length > MAX_ENTRIES) {
      this.conversation = this.conversation.slice(-MAX_ENTRIES);
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>ghia-ai panel</title>
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
  </style>
</head>
<body>
  <div class="panel">
    <div class="header">
      <div class="title">
        <div class="title-row">
          <span class="pill">Panel</span>
          <h1><img src="${this.iconUrl}" alt="ghia-ai" style="width:18px;height:18px;border-radius:4px;"> ghia-ai</h1>
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
        <button class="btn ghost" onclick="clearHistory()" style="font-size:11px; padding:4px 8px;">Clear</button>
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
        <div class="chips">
          <label class="chip">
            <input type="checkbox" id="include-selection"> Selection
          </label>
          <label class="chip">
            <input type="checkbox" id="include-file" checked> Current file
          </label>
          <span class="hint" id="context-hint"></span>
        </div>
        <div class="chips" id="write-controls">
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
    let latestContextHints = { hasSelection: false, selectionLabel: null, hasFile: false, fileName: null };
    let latestConversation = [];
    let thinkTimer = null;
    let thinkingIndex = 0;
    const thinkingEmojis = ["🤔", "🌀", "💭", "✨", "⌛"];
    let allowWrites = false;
    let messageFileOptions = [];

    document.getElementById('composer').addEventListener('submit', (event) => {
      event.preventDefault();
      const question = document.getElementById('question').value;
      const includeSelection = document.getElementById('include-selection').checked;
      const includeFile = document.getElementById('include-file').checked;
      const targetPath = document.getElementById('target-file').value || undefined;
      const writeMode = document.getElementById('write-mode').value || "append";
      vscode.postMessage({ command: 'ask', question, includeSelection, includeFile, targetPath, writeMode });
      document.getElementById('question').value = '';
    });

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

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text ?? '';
      return div.innerHTML;
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
        <div class="explanation-text">\${escapeHtml(explanation.explanation)}</div>
        \${codePreview}
        <div class="actions">
          <button class="btn" onclick="copyExplanation()">📋 Copy</button>
          <button class="btn" onclick="refreshExplanation()">🔄 Refresh</button>
        </div>
      \`;
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
        const displayContent = entry.content;
        return \`
          <div class="bubble \${entry.role}">
            <div class="meta">\${meta}\${status}</div>
            <div class="content">\${escapeHtml(displayContent)}</div>
          </div>
        \`;
      }).join('');
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

    function renderContextHints(hints) {
      latestContextHints = hints || latestContextHints;
      const selectionBox = document.getElementById('include-selection');
      const fileBox = document.getElementById('include-file');
      const targetInput = document.getElementById('target-file');
      const modeSelect = document.getElementById('write-mode');
      const datalist = document.getElementById('file-options');
      selectionBox.disabled = !latestContextHints.hasSelection;
      if (!latestContextHints.hasSelection) selectionBox.checked = false;
      document.getElementById('context-hint').textContent = latestContextHints.selectionLabel || latestContextHints.fileName || '';
      document.getElementById('refresh-btn').style.display = 'inline-flex';
      fileBox.disabled = !latestContextHints.hasFile;
      if (!latestContextHints.hasFile) fileBox.checked = false;
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
      if (!btn) return;
      btn.textContent = enabled ? 'Allow writes: On' : 'Allow writes: Off';
      btn.classList.toggle('primary', enabled);
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        renderExplanation(message.explanation);
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
      .getConfiguration("ghiaAI")
      .update("askPythonMode", this.pythonFocus, vscode.ConfigurationTarget.Global);
    this.updateView();
  }

  private async setAllowFileWrites(enabled: boolean): Promise<void> {
    this.allowFileWrites = enabled;
    await this.context.globalState.update(ALLOW_WRITE_KEY, enabled);
    this.updateView();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Alternative: Floating Webview Panel.
 * Creates a webview panel that appears beside the editor (like "Learn More" does now).
 * Use this when you want a standalone panel rather than a sidebar view.
 */
export class FloatingPanelProvider implements vscode.Disposable {
  private readonly aiService = new AIService();
  private readonly cacheService = new CacheService();
  private readonly contextExtractor = new ContextExtractor();

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
   // In-panel chat history for context across questions
  private conversation: { role: "user" | "assistant"; content: string }[] = [];
  private pythonFocus = true;
  private allowFileWrites = false;
  private fileOptions: string[] = [];
  private iconUrl = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    this.allowFileWrites = this.context.globalState.get<boolean>(
      ALLOW_WRITE_KEY,
      false
    );
    void this.loadFileOptions();
  }

  /**
   * Opens an empty ghia-ai panel to the right, sized evenly with the editor.
   * Useful for pre-opening the space before asking a question.
   */
  openPanel(): void {
    const config = vscode.workspace.getConfiguration("ghiaAI");
    this.pythonFocus = config.get("askPythonMode", true);
    this.ensurePanel();
    this.panel!.webview.html = this.getWelcomeHtml();
    this.evenEditorWidths();
  }

  /**
   * Shows explanation in a floating webview panel beside the editor.
   */
  async showExplanation(code?: string, context?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor && !code) {
      vscode.window.showWarningMessage("No code to explain");
      return;
    }

    // Get code if not provided
    if (!code) {
      const document = editor!.document;
      const selection = editor!.selection;

      if (!selection.isEmpty) {
        code = document.getText(selection).trim();
        context = "";
      } else {
        const extracted = this.contextExtractor.extract(
          document,
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

    // Create or reveal panel
    this.ensurePanel();
    this.panel!.reveal(vscode.ViewColumn.Beside);
    this.evenEditorWidths();

    // Show loading state
    this.panel!.webview.html = this.getLoadingHtml(code);

    // Get explanation
    const languageId = editor?.document.languageId ?? "plaintext";
    let explanation = this.cacheService.get(code);

    if (!explanation) {
      try {
        explanation = await this.aiService.explain(
          code,
          languageId,
          context ?? ""
        );
        this.cacheService.set(code, explanation);
      } catch (err) {
        explanation = `Error: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }

    // Update with result
    this.panel!.webview.html = this.getResultHtml(code, explanation, languageId);
  }

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "ghia-ai.floatingPanel",
      "🧠 ghia-ai",
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
      .asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "media", "ghia-ai.png")
      )
      .toString();

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === "copy" && message.text) {
          await vscode.env.clipboard.writeText(message.text);
          vscode.window.showInformationMessage("Copied to clipboard");
        } else if (message.command === "ask" && typeof message.text === "string") {
          await this.handleAsk(message.text, {
            includeSelection: Boolean(message.includeSelection),
            includeFile: Boolean(message.includeFile),
            targetPath: message.targetPath,
            writeMode: message.writeMode,
          });
        } else if (message.command === "clear") {
          this.conversation = [];
          this.panel!.webview.html = this.renderChatHtml();
        } else if (message.command === "toggleScope") {
          await this.toggleScope();
        } else if (message.command === "toggleWritePermission") {
          await this.setAllowFileWrites(!this.allowFileWrites);
        }
      },
      null,
      this.disposables
    );
  }

  private evenEditorWidths(): void {
    void vscode.commands.executeCommand("workbench.action.evenEditorWidths");
  }

  private getWelcomeHtml(): string {
    const optionsHtml = this.fileOptions
      .map((opt) => `<option value="${this.escapeHtml(opt)}"></option>`)
      .join("");
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 1.5rem; line-height: 1.6; }
    h1 { margin: 0 0 0.25rem; }
    p { margin: 0 0 1rem; }
    code { background: var(--vscode-editorWidget-background); padding: 0.15rem 0.3rem; border-radius: 4px; }
    .chips { display: flex; gap: 8px; align-items: center; margin: 0 0 0.5rem; }
    .scope-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0.5rem 0; }
    .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--vscode-input-border); background: var(--vscode-editorWidget-background); font-size: 12px; }
    textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 8px; font-family: var(--vscode-editor-font-family); resize: vertical; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border); padding: 8px 12px; border-radius: 6px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .row { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    .btn { border: 1px solid var(--vscode-button-border); background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background)); color: var(--vscode-button-foreground); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
    .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn.ghost { background: var(--vscode-editorWidget-background); }
  </style>
</head>
<body>
  <h1><img src="${this.iconUrl}" alt="ghia-ai" style="width:18px;height:18px;border-radius:4px;"> ghia-ai</h1>
  <p>Ask a question or select code, then click Send.</p>
  <div class="scope-row">
    <button class="btn ghost" id="scope-toggle-inline" aria-pressed="${this.pythonFocus ? "true" : "false"}">
      ${this.pythonFocus ? "Python focus: On" : "Python focus: Off"}
    </button>
    <button class="btn ghost" id="write-toggle" aria-pressed="${this.allowFileWrites ? "true" : "false"}">
      ${this.allowFileWrites ? "Allow writes: On" : "Allow writes: Off"}
    </button>
    <span style="color: var(--vscode-descriptionForeground); font-size: 12px;">Python-heavy answers when on; general answers when off.</span>
  </div>
  <form id="ask-form">
    <div class="chips">
      <label class="chip"><input type="checkbox" id="include-selection" checked> Selection</label>
      <label class="chip"><input type="checkbox" id="include-file" checked> Current file</label>
      <label class="chip">Target file
        <input list="file-options" type="text" id="target-file" placeholder="e.g. start.py" style="width:200px;" ${this.allowFileWrites ? "" : "disabled"}>
        <datalist id="file-options">${optionsHtml}</datalist>
      </label>
      <label class="chip">Mode
        <select id="write-mode">
          <option value="append">Append</option>
          <option value="replace">Replace</option>
        </select>
      </label>
    </div>
    <textarea id="ask-input" rows="4" placeholder="How does this function work? What is causing this bug?"></textarea>
    <div class="row">
      <span style="color: var(--vscode-descriptionForeground); font-size: 12px;">Answers render here in this wide panel.</span>
      <button type="submit">Send</button>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('scope-toggle-inline')?.addEventListener('click', () => vscode.postMessage({ command: 'toggleScope' }));
    document.getElementById('write-toggle')?.addEventListener('click', () => vscode.postMessage({ command: 'toggleWritePermission' }));
    document.getElementById('ask-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = document.getElementById('ask-input').value;
      const includeSelection = document.getElementById('include-selection').checked;
      const includeFile = document.getElementById('include-file').checked;
      const targetPath = document.getElementById('target-file').value || undefined;
      const writeMode = document.getElementById('write-mode').value || "append";
      vscode.postMessage({ command: 'ask', text, includeSelection, includeFile, targetPath, writeMode });
    });
  </script>
</body>
</html>`;
  }

  private renderChatHtml(showTyping = false): string {
    const messagesHtml = this.conversation
      .map((m) => {
        const cls = m.role === "user" ? "bubble user" : "bubble ai";
        return `<div class="${cls}">${this.markdownToHtml(m.content)}</div>`;
      })
      .join("");

    const typingHtml = showTyping
      ? `<div class="typing" id="typing-text">🤔 thinking…</div>`
      : "";

    const optionsHtml = this.fileOptions
      .map((opt) => `<option value="${this.escapeHtml(opt)}"></option>`)
      .join("");

    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { margin:0; padding:16px; font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); }
    h1 { margin: 0 0 8px; display:flex; gap:8px; align-items:center; }
    .chat { display:flex; flex-direction:column; gap:10px; margin: 12px 0 16px; }
    .bubble { padding:10px 12px; border-radius:10px; border:1px solid var(--vscode-panel-border); }
    .bubble.user { background: var(--vscode-textBlockQuote-background); }
    .bubble.ai { background: var(--vscode-editorWidget-background); }
    .typing { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .composer { display:flex; flex-direction:column; gap:8px; }
    .chips { display:flex; gap:8px; flex-wrap:wrap; }
    .chip { display:inline-flex; gap:6px; align-items:center; padding:4px 8px; border-radius:999px; border:1px solid var(--vscode-input-border); background: var(--vscode-editorWidget-background); font-size:12px; }
    .scope-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
    .write-row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; align-items:center; }
    textarea { width:100%; box-sizing:border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:6px; padding:8px; font-family: var(--vscode-editor-font-family); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:1px solid var(--vscode-button-border); padding:8px 12px; border-radius:6px; cursor:pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .actions { display:flex; gap:8px; align-items:center; }
    datalist option { color: var(--vscode-foreground); }
  </style>
</head>
<body>
  <h1>🧠 ghia-ai</h1>
  <div class="chat" id="chat">${messagesHtml}${typingHtml}</div>
  <form id="ask-form" class="composer">
    <div class="scope-row">
      <button class="btn ghost" id="scope-toggle-inline" aria-pressed="${this.pythonFocus ? "true" : "false"}">
        ${this.pythonFocus ? "Python focus: On" : "Python focus: Off"}
      </button>
      <button class="btn ghost" id="write-toggle" aria-pressed="${this.allowFileWrites ? "true" : "false"}">
        ${this.allowFileWrites ? "Allow writes: On" : "Allow writes: Off"}
      </button>
      <span style="color: var(--vscode-descriptionForeground); font-size: 12px;">Python-heavy answers when on; general answers when off.</span>
    </div>
    <div class="chips">
      <label class="chip"><input type="checkbox" id="include-selection" checked> Selection</label>
      <label class="chip"><input type="checkbox" id="include-file" checked> Current file</label>
    </div>
    <div class="write-row">
      <label class="chip">Target file
        <input list="file-options" type="text" id="target-file" placeholder="start.py" style="width:200px;" ${this.allowFileWrites ? "" : "disabled"}>
        <datalist id="file-options">${optionsHtml}</datalist>
      </label>
      <label class="chip">Mode
        <select id="write-mode" ${this.allowFileWrites ? "" : "disabled"}>
          <option value="append">Append</option>
          <option value="replace">Replace</option>
        </select>
      </label>
      <span style="color: var(--vscode-descriptionForeground); font-size: 12px;">Enabled when writes are allowed.</span>
    </div>
    <textarea id="ask-input" rows="3" placeholder="Ask a follow-up or a new question"></textarea>
    <div class="actions">
      <button type="submit">Send</button>
      <button type="button" id="clear-btn">Clear</button>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();
    const thinkingEmojis = ["🤔", "🌀", "💭", "✨", "⌛"];
    let emojiIndex = 0;
    document.getElementById('scope-toggle-inline')?.addEventListener('click', () => vscode.postMessage({ command: 'toggleScope' }));
    document.getElementById('write-toggle')?.addEventListener('click', () => vscode.postMessage({ command: 'toggleWritePermission' }));
    const form = document.getElementById('ask-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = document.getElementById('ask-input').value;
      const includeSelection = document.getElementById('include-selection').checked;
      const includeFile = document.getElementById('include-file').checked;
      const targetPath = document.getElementById('target-file').value || undefined;
      const writeMode = document.getElementById('write-mode').value || "append";
      vscode.postMessage({ command: 'ask', text, includeSelection, includeFile, targetPath, writeMode });
      document.getElementById('ask-input').value = '';
    });
    document.getElementById('clear-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'clear' });
    });

    // Animate typing placeholder with rotating emojis while thinking
    const typingEl = document.getElementById('typing-text');
    if (typingEl) {
      setInterval(() => {
        emojiIndex = (emojiIndex + 1) % thinkingEmojis.length;
        typingEl.textContent = thinkingEmojis[emojiIndex] + ' thinking…';
      }, 800);
    }
  </script>
</body>
</html>`;
  }

  private async handleAsk(
    question: string,
    opts: { includeSelection: boolean; includeFile: boolean }
  ): Promise<void> {
    if (!question || !question.trim()) {
      vscode.window.showWarningMessage("Enter a question to ask ghia-ai.");
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;

    const selectionText =
      opts.includeSelection && editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection).trim()
        : "";

    const includeFile = opts.includeFile && doc;
    const contextInfo =
      includeFile && doc
        ? (() => {
            const MAX_CHARS = 30000;
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
        ? `${question.trim()}\n\nSelected code:\n${selectionText}`
        : question.trim();

    if (!this.panel) {
      this.ensurePanel();
    }

    // Append user message and a typing placeholder
    this.conversation.push({ role: "user", content: augmentedQuestion });
    this.conversation.push({ role: "assistant", content: "…thinking" });
    this.panel!.webview.html = this.renderChatHtml(true);

    try {
      const historyContext = this.buildHistoryContext();
      const answer = await this.aiService.ask(
        `${historyContext}\nCurrent question: ${augmentedQuestion}`,
        contextInfo,
        undefined,
        this.pythonFocus
      );
      // replace placeholder
      if (
        this.conversation.length > 0 &&
        this.conversation[this.conversation.length - 1].role === "assistant" &&
        this.conversation[this.conversation.length - 1].content.startsWith("…")
      ) {
        this.conversation.pop();
      }
      this.conversation.push({ role: "assistant", content: answer });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        this.conversation.length > 0 &&
        this.conversation[this.conversation.length - 1].role === "assistant" &&
        this.conversation[this.conversation.length - 1].content.startsWith("…")
      ) {
        this.conversation.pop();
      }
      this.conversation.push({
        role: "assistant",
        content: `Error: ${message}`,
      });
    }

    this.panel!.webview.html = this.renderChatHtml();
  }

  private buildHistoryContext(): string {
    const recent = this.conversation.slice(-6);
    const lines = recent.map(
      (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    );
    return lines.length ? `Previous conversation:\n${lines.join("\n")}\n` : "";
  }

  private randomEmoji(): string {
    const emojis = ["🤖", "✨", "⚡", "🧠", "🚀", "💡", "🌀", "🎯", "📚", "🧩"];
    return emojis[Math.floor(Math.random() * emojis.length)];
  }

  private getLoadingHtml(code: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .loading {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 20px 0;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--vscode-progressBar-background);
      border-top: 2px solid var(--vscode-textLink-foreground);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .code-preview {
      background: var(--vscode-textBlockQuote-background);
      padding: 12px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
    }
  </style>
</head>
<body>
  <h2>🧠 ghia-ai</h2>
  <div class="loading">
    <div class="spinner"></div>
    <span id="loading-text">Generating explanation...</span>
  </div>
  <h3>Code</h3>
  <pre class="code-preview">${this.escapeHtml(code)}</pre>

  <script>
    const emojis = ["🤖","✨","⚡","🧠","🚀","💡","🌀","🎯","📚","🧩"];
    const textEl = document.getElementById('loading-text');
    let i = 0;
    setInterval(() => {
      textEl.textContent = "Generating " + emojis[i % emojis.length];
      i++;
    }, 600);
  </script>
</body>
</html>`;
  }

  private getResultHtml(
    code: string,
    explanation: string,
    languageId: string
  ): string {
    // Pre-render markdown to clean HTML
    const rendered = this.markdownToHtml(explanation);
    const rawExplanationJson = JSON.stringify(explanation);

    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.6;
    }
    h2 {
      margin-top: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .explanation {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      padding: 16px;
      margin: 16px 0;
      border-radius: 0 4px 4px 0;
    }
    .explanation h2, .explanation h3, .explanation h4 { margin: 0.5em 0 0.25em; }
    .explanation p { margin: 0 0 0.6em; }
    .code-block {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
      border-radius: 6px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
      margin: 10px 0;
    }
    .code-preview {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 12px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre;
      max-height: 200px;
      overflow-y: auto;
    }
    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .meta {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <h2>🧠 ghia-ai</h2>
  
  <div class="explanation" id="explanation">${rendered}</div>
  
  <button class="btn" onclick="copyExplanation()">📋 Copy Explanation</button>
  
  <h3>Code</h3>
  <pre class="code-preview">${this.escapeHtml(code)}</pre>
  
  <p class="meta">Language: ${languageId}</p>
  
  <script>
    const vscode = acquireVsCodeApi();
    const rawExplanation = ${rawExplanationJson};
    
    function copyExplanation() {
      vscode.postMessage({ command: 'copy', text: rawExplanation });
    }
  </script>
</body>
</html>`;
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
    // Extract code blocks first
    md = md.replace(/```([\s\S]*?)```/g, (_m, code) => {
      const idx = codeBlocks.push(
        `<pre class="code-block"><code>${this.escapeHtml(
          String(code).trim()
        )}</code></pre>`
      );
      return `__CODE_BLOCK_${idx - 1}__`;
    });

    let html = this.escapeHtml(md);

    // Headings
    html = html.replace(/^###\s+(.*)$/gm, "<h3>$1</h3>");
    html = html.replace(/^##\s+(.*)$/gm, "<h2>$1</h2>");
    html = html.replace(/^#\s+(.*)$/gm, "<h1>$1</h1>");
    // Bold / italic
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
    // Lists (simple bullet)
    html = html.replace(/^\*\s+(.*)$/gm, "<ul><li>$1</li></ul>");
    // Paragraph breaks
    html = html.replace(/\n{2,}/g, "</p><p>");
    html = `<p>${html}</p>`;

    // Reinsert code blocks
    html = html.replace(/__CODE_BLOCK_(\d+)__/g, (_m, i) => codeBlocks[Number(i)] ?? "");
    return html;
  }

  /**
   * Toggles Python-focused answers for free-form questions in floating panel.
   */
  private async toggleScope(): Promise<void> {
    this.pythonFocus = !this.pythonFocus;
    await vscode.workspace
      .getConfiguration("ghiaAI")
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
