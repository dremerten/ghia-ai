import * as vscode from "vscode";
import { PyAidHoverProvider } from "./providers/hoverProvider";
import { StateManager } from "./managers/stateManager";
import { MenuManager } from "./managers/menuManager";
import { StatusBarManager } from "./managers/statusBarManager";
import { PrototypeManager } from "./managers/prototypeManager";
import { AIService } from "./services/aiService";
import { writeWithConsent } from "./utils/fileWriter";
import { ExplainDecorationProvider } from "./providers/explainDecorationProvider";

const ALLOW_WRITE_KEY = "pyaid.allowFileWrites";
import {
  activateExperiments,
  deactivateExperiments,
  showExperimentMenu,
  clearExperiments,
  logExperimentStatus,
  runExperiment,
  ExperimentMode,
} from "./experimental/experimentExtension";

const HOVER_SELECTOR = [{ scheme: "file" }, { scheme: "untitled" }];

let stateManager: StateManager | undefined;
let menuManager: MenuManager | undefined;
let statusBarManager: StatusBarManager | undefined;
let prototypeManager: PrototypeManager | undefined;
let hoverRegistrationDisposable: vscode.Disposable | undefined;
let explainDecorationProvider: ExplainDecorationProvider | undefined;
const aiService = new AIService();
let askStatusBar: vscode.StatusBarItem | undefined;
let panelStatusBar: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const hoverProvider = new PyAidHoverProvider();
  const sm = new StateManager(context);
  const mm = new MenuManager(sm, context);
  const sbm = new StatusBarManager(sm, mm);
  explainDecorationProvider = new ExplainDecorationProvider(context);

  stateManager = sm;
  menuManager = mm;
  statusBarManager = sbm;

  context.subscriptions.push(sm, mm, sbm, hoverProvider, explainDecorationProvider);

  function registerHover(): vscode.Disposable {
    return vscode.languages.registerHoverProvider(
      HOVER_SELECTOR,
      hoverProvider
    );
  }

  if (sm.getEnabled()) {
    hoverRegistrationDisposable = registerHover();
    context.subscriptions.push(hoverRegistrationDisposable);
  }

  const stateChangeSubscription = sm.onDidChangeEnabled((enabled) => {
    if (enabled) {
      if (!hoverRegistrationDisposable) {
        hoverRegistrationDisposable = registerHover();
        context.subscriptions.push(hoverRegistrationDisposable);
      }
    } else {
      if (hoverRegistrationDisposable) {
        hoverRegistrationDisposable.dispose();
        hoverRegistrationDisposable = undefined;
      }
    }
  });
  context.subscriptions.push(stateChangeSubscription);

  sbm.registerClickHandler(context);
  sbm.show();

  const commandDisposable = vscode.commands.registerCommand(
    "pyaid.explainCode",
    (codeOrArgs?: string | [string, string], ctx?: string) => {
      // Command URIs pass a single JSON array [code, context]; normalize to (code, context).
      let code: string | undefined;
      let context: string | undefined;
      if (
        Array.isArray(codeOrArgs) &&
        codeOrArgs.length >= 2 &&
        typeof codeOrArgs[0] === "string"
      ) {
        code = codeOrArgs[0];
        context = typeof codeOrArgs[1] === "string" ? codeOrArgs[1] : "";
      } else {
        code = typeof codeOrArgs === "string" ? codeOrArgs : undefined;
        context = ctx;
      }
      void vscode.commands
        .executeCommand("pyaid.explainFloating", code, context)
        .then(undefined, () => hoverProvider.explainCode(code, context));
    }
  );
  context.subscriptions.push(commandDisposable);

  const retryHoverCommandDisposable = vscode.commands.registerCommand(
    "pyaid.retryHoverExplanation",
    (code?: string, context?: string) => {
      hoverProvider.retryExplanation(code ?? "", context ?? "");
    }
  );
  context.subscriptions.push(retryHoverCommandDisposable);

  const welcomeSubscription = vscode.workspace.onDidOpenTextDocument(() => {
    if (sm.hasShownWelcome()) return;
    const message =
      "👋 Welcome to PyAid! Click the icon in the status bar to configure your local Ollama model and get started.";
    void vscode.window
      .showInformationMessage(message, "Configure Now")
      .then((selection) => {
        void sm.markWelcomeShown();
        if (selection === "Configure Now") {
          mm.showMainMenu();
        }
      });
  });
  context.subscriptions.push(welcomeSubscription);

  const askCommand = vscode.commands.registerCommand(
    "pyaid.askAI",
    async () => {
      const question = await vscode.window.showInputBox({
        prompt: "Ask your local model a question",
        placeHolder: "Explain random.sample() with examples",
      });
      if (!question) return;

      // If the user references the current file, include its content (capped for safety).
      const includeFile =
        /\b(current file|this file|in this file|here)\b/i.test(question);
      const editor = vscode.window.activeTextEditor;
      const doc = editor?.document;
      const MAX_CHARS = 30000;
      let contextInfo:
        | { languageId?: string; content?: string; truncated?: boolean }
        | undefined;
      if (includeFile && doc) {
        const full = doc.getText();
        const truncated = full.length > MAX_CHARS;
        const content = truncated ? full.slice(0, MAX_CHARS) : full;
        contextInfo = {
          languageId: doc.languageId,
          content,
          truncated,
        };
      }

      try {
        const answer = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "PyAid",
            cancellable: false,
          },
          () => aiService.ask(question, contextInfo)
        );
        showAnswerPanel(answer, `PyAid: ${question}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`PyAid: ${msg}`);
      }
    }
  );
  context.subscriptions.push(askCommand);

  // Write-to-file command with explicit user consent
  const writeCommand = vscode.commands.registerCommand(
    "pyaid.writeToFile",
    async (
      filePath?: string,
      content?: string,
      mode: "append" | "replace" = "append"
    ) => {
      try {
        const targetPath =
          typeof filePath === "string" && filePath.trim().length > 0
            ? filePath.trim()
            : await vscode.window
                .showInputBox({
                  prompt: "Path to write (absolute or workspace-relative)",
                  value:
                    vscode.window.activeTextEditor?.document.uri.fsPath ?? "",
                })
                .then((v) => v?.trim());
        if (!targetPath) return;

        const text =
          typeof content === "string" && content.trim().length > 0
            ? content
            : await vscode.window.showInputBox({
                prompt: "Content to write",
                placeHolder: "Paste or type the text to write",
                ignoreFocusOut: true,
                validateInput: (val) =>
                  val.length === 0 ? "Content cannot be empty" : undefined,
              });
        if (!text) return;

        const allowWrites =
          context.globalState.get<boolean>(ALLOW_WRITE_KEY, false) ?? false;
        await writeWithConsent(targetPath, text, mode, allowWrites);
        void vscode.window.showInformationMessage(
          `PyAid wrote to ${targetPath}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`PyAid: ${msg}`);
      }
    }
  );
  context.subscriptions.push(writeCommand);

  // Status bar button to open Ask dialog quickly
  askStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    90
  );
  askStatusBar.text = "$(comment-discussion) Ask AI";
  askStatusBar.tooltip = "Ask your local model (Python 3 examples)";
  askStatusBar.command = "pyaid.askAI";
  askStatusBar.show();
  context.subscriptions.push(askStatusBar);

  // Quick access to open the side panel
  panelStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    88
  );
  panelStatusBar.text = "$(layout-sidebar-right) PyAid";
  panelStatusBar.tooltip = "Open the PyAid side panel";
  panelStatusBar.command = "pyaid.openPanel";
  panelStatusBar.show();
  context.subscriptions.push(panelStatusBar);

  // Only activate experiments UI (status bar) when explicitly enabled via configuration
  // This prevents the experimental status bar from showing to production users
  const config = vscode.workspace.getConfiguration("pyaid");
  const experimentsEnabled = config.get<boolean>("enableExperiments", false);
  if (experimentsEnabled) {
    activateExperiments(context);
  }

  // Always register experiment commands so they don't cause "command not found" errors
  // Handlers check config at runtime and show info message if experiments are disabled
  const experimentDisabledMessage =
    'Experiments are disabled. Enable them in settings: "pyaid.enableExperiments": true';

  function isExperimentsEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("pyaid")
      .get<boolean>("enableExperiments", false);
  }

  const experimentMenuCommand = vscode.commands.registerCommand(
    "pyaid.experiment.menu",
    () => {
      if (!isExperimentsEnabled()) {
        void vscode.window.showInformationMessage(experimentDisabledMessage);
        return;
      }
      void showExperimentMenu();
    }
  );

  const experimentStopCommand = vscode.commands.registerCommand(
    "pyaid.experiment.stop",
    () => {
      if (!isExperimentsEnabled()) {
        void vscode.window.showInformationMessage(experimentDisabledMessage);
        return;
      }
      clearExperiments();
      void vscode.window.showInformationMessage("🧪 Experiment stopped.");
    }
  );

  const experimentStatusCommand = vscode.commands.registerCommand(
    "pyaid.experiment.status",
    () => {
      if (!isExperimentsEnabled()) {
        void vscode.window.showInformationMessage(experimentDisabledMessage);
        return;
      }
      logExperimentStatus();
    }
  );

  // Register shortcut commands for each experiment mode
  const experimentModes: ExperimentMode[] = [
    "null-returning",
    "always-return",
    "conditional",
    "multi-provider",
    "registration-order-high-first",
    "registration-order-high-last",
    "registration-order-first-second-high",
    "async",
    "undefined",
    "empty-content",
  ];

  const experimentRunCommands = experimentModes.map((mode) =>
    vscode.commands.registerCommand(
      `pyaid.experiment.run.${mode}`,
      () => {
        if (!isExperimentsEnabled()) {
          void vscode.window.showInformationMessage(experimentDisabledMessage);
          return;
        }
        runExperiment(mode);
      }
    )
  );

  context.subscriptions.push(
    experimentMenuCommand,
    experimentStopCommand,
    experimentStatusCommand,
    ...experimentRunCommands
  );

  // Always register prototype UI (Side Panel/Floating)
  // Users can still pick their preferred mode via settings or the mode selector.
  prototypeManager = new PrototypeManager(context);
  context.subscriptions.push(prototypeManager);

  // One-click command to focus the PyAid side panel
  const openPanelCommand = vscode.commands.registerCommand(
    "pyaid.openPanel",
    async () => {
      await vscode.commands.executeCommand("pyaid.openWidePanel");
    }
  );
  context.subscriptions.push(openPanelCommand);
}

export function deactivate(): void {
  deactivateExperiments();
  if (hoverRegistrationDisposable) {
    hoverRegistrationDisposable.dispose();
    hoverRegistrationDisposable = undefined;
  }
  prototypeManager?.dispose();
  prototypeManager = undefined;
  statusBarManager?.dispose();
  statusBarManager = undefined;
  menuManager?.dispose();
  menuManager = undefined;
  stateManager?.dispose();
  stateManager = undefined;
  askStatusBar?.dispose();
  askStatusBar = undefined;
  panelStatusBar?.dispose();
  panelStatusBar = undefined;
}

function showAnswerPanel(markdown: string, title: string): void {
  const panel = vscode.window.createWebviewPanel(
    "pyaidAnswer",
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 1rem; line-height: 1.6; }
    pre, code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  </style>
</head>
<body>
  <div>${markdownToHtml(markdown)}</div>
</body>
</html>`;
  panel.webview.html = html;
}

function markdownToHtml(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<pre style="white-space: pre-wrap; word-break: break-word;">${escaped}</pre>`;
}
