import * as vscode from "vscode";
import {
  PeekExplanationProvider,
  QuickPeekProvider,
  InlinePeekProvider,
} from "../providers/peekViewProvider";
import {
  SidePanelProvider,
  FloatingPanelProvider,
} from "../providers/sidePanelProvider";

/**
 * Available UI modes for displaying AI explanations.
 * Each mode provides a different UX trade-off.
 */
export type UIMode =
  | "hover" // Original hover provider (merged with other hovers)
  | "peek" // Peek definition-style overlay
  | "quickpeek" // Quick pick modal for fast explanations
  | "inlinepeek" // Inline decoration below code
  | "sidepanel" // Persistent sidebar webview
  | "floatingpanel"; // Floating webview beside editor

/**
 * Configuration for the prototype manager.
 */
interface PrototypeConfig {
  activeMode: UIMode;
  enableHover: boolean;
  enableSidePanel: boolean;
}

/**
 * Manages UI prototypes and allows switching between different display modes.
 *
 * This manager coordinates all the alternative UI approaches:
 * - Peek View Provider: Definition-style peek overlay
 * - Side Panel Provider: Persistent webview sidebar
 * - Floating Panel: Webview panel beside editor
 *
 * Users can switch between modes via commands or configuration.
 */
export class PrototypeManager implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];

  // Provider instances
  private peekProvider: PeekExplanationProvider | null = null;
  private quickPeekProvider: QuickPeekProvider | null = null;
  private inlinePeekProvider: InlinePeekProvider | null = null;
  private sidePanelProvider: SidePanelProvider | null = null;
  private floatingPanelProvider: FloatingPanelProvider | null = null;

  // Registration disposables (for toggling providers)
  // Current active mode
  private currentMode: UIMode = "hover";

  // Status bar item for showing current mode
  private statusBarItem: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Enable Side Panel visibility by setting the context key
    // This makes the "when": "ghiaAI.prototype.sidePanelEnabled" condition true
    void vscode.commands.executeCommand(
      "setContext",
      "ghiaAI.prototype.sidePanelEnabled",
      true
    );

    // Create status bar item
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    this.statusBarItem.command = "ghia-ai.prototype.selectMode";
    this.disposables.push(this.statusBarItem);

    // Initialize providers
    this.initializeProviders();

    // Register commands
    this.registerCommands();

    // Load initial mode from configuration
    this.loadConfiguration();

    // Listen for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ghiaAI.prototype")) {
          this.loadConfiguration();
        }
      })
    );
  }

  /**
   * Initializes all provider instances.
   */
  private initializeProviders(): void {
    this.peekProvider = new PeekExplanationProvider();
    this.quickPeekProvider = new QuickPeekProvider();
    this.inlinePeekProvider = new InlinePeekProvider();
    this.sidePanelProvider = new SidePanelProvider(
      this.context.extensionUri,
      this.context
    );
    this.floatingPanelProvider = new FloatingPanelProvider(
      this.context.extensionUri,
      this.context
    );

    // Register side panel view (always available)
    const sidePanelRegistration = vscode.window.registerWebviewViewProvider(
      SidePanelProvider.viewType,
      this.sidePanelProvider
    );
    this.disposables.push(sidePanelRegistration);

    // Track disposables
    this.disposables.push(
      this.peekProvider,
      this.quickPeekProvider,
      this.inlinePeekProvider,
      this.sidePanelProvider,
      this.floatingPanelProvider
    );
  }

  /**
   * Registers all commands for the prototype manager.
   */
  private registerCommands(): void {
    const commands = [
      // Mode selection
      vscode.commands.registerCommand("ghia-ai.prototype.selectMode", () =>
        this.showModeSelector()
      ),
      vscode.commands.registerCommand(
        "ghia-ai.prototype.setMode",
        (mode: UIMode) => this.setMode(mode)
      ),

      // Peek explanation command (opens in VS Code peek view)
      vscode.commands.registerCommand("ghia-ai.peekExplanation", () =>
        this.peekProvider?.showPeekExplanation()
      ),

      // Quick peek command
      vscode.commands.registerCommand("ghia-ai.quickPeek", () =>
        this.quickPeekProvider?.showQuickPeek()
      ),

      // Inline peek command
      vscode.commands.registerCommand("ghia-ai.inlinePeek", () =>
        this.inlinePeekProvider?.showInlinePeek()
      ),

      // Side panel command
      vscode.commands.registerCommand("ghia-ai.explainInPanel", () =>
        this.sidePanelProvider?.explainCurrentSelection()
      ),

      // Floating panel command
      vscode.commands.registerCommand(
        "ghia-ai.explainFloating",
        (code?: string, context?: string) =>
          this.floatingPanelProvider?.showExplanation(code, context)
      ),
      vscode.commands.registerCommand("ghia-ai.openWidePanel", () =>
        this.floatingPanelProvider?.openPanel()
      ),

    ];

    this.disposables.push(...commands);
  }

  /**
   * Loads configuration and applies the active mode.
   * Only reads config - does not write back to avoid recursive change events.
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration("ghiaAI.prototype");
    const mode = config.get<UIMode>("mode", "hover");
    // Apply mode without persisting - loadConfiguration is for reading only
    this.applyMode(mode);
  }

  /**
   * Shows a quick pick to select the UI mode.
   */
  async showModeSelector(): Promise<void> {
    const items: (vscode.QuickPickItem & { mode: UIMode })[] = [
      {
        label: "$(comment-discussion) Hover",
        description: "Original hover tooltips (merged with VS Code)",
        detail:
          "Shows explanations in native VS Code hover. May conflict with other hovers.",
        mode: "hover",
        picked: this.currentMode === "hover",
      },
      {
        label: "$(eye) Peek View",
        description: "Peek definition-style overlay",
        detail:
          "Opens explanation in VS Code's peek view. Use Go to Definition shortcut.",
        mode: "peek",
        picked: this.currentMode === "peek",
      },
      {
        label: "$(zap) Quick Peek",
        description: "Fast modal explanation",
        detail:
          "Shows explanation in a quick pick modal. Fast and keyboard-friendly.",
        mode: "quickpeek",
        picked: this.currentMode === "quickpeek",
      },
      {
        label: "$(lightbulb) Inline Peek",
        description: "Inline decoration below code",
        detail: "Shows explanation as inline text below the hovered line.",
        mode: "inlinepeek",
        picked: this.currentMode === "inlinepeek",
      },
      {
        label: "$(layout-sidebar-right) Side Panel",
        description: "Persistent sidebar webview",
        detail:
          "Rich UI in the sidebar with history. Best for detailed exploration.",
        mode: "sidepanel",
        picked: this.currentMode === "sidepanel",
      },
      {
        label: "$(window) Floating Panel",
        description: "Webview panel beside editor",
        detail: "Opens explanation in a panel next to your code.",
        mode: "floatingpanel",
        picked: this.currentMode === "floatingpanel",
      },
    ];

    const selection = await vscode.window.showQuickPick(items, {
      title: "🧠 ghia-ai - Select UI Mode",
      placeHolder: `Current mode: ${this.currentMode}`,
    });

    if (selection) {
      await this.setMode(selection.mode);
      vscode.window.showInformationMessage(
        `ghia-ai mode set to: ${selection.label.replace(/\$\([^)]+\)\s*/, "")}`
      );
    }
  }

  /**
   * Sets the active UI mode and persists to configuration.
   * Call this for user-initiated mode changes only.
   */
  async setMode(mode: UIMode): Promise<void> {
    // Guard: skip config update if mode hasn't changed
    const config = vscode.workspace.getConfiguration("ghiaAI.prototype");
    const storedMode = config.get<UIMode>("mode");

    // Apply the mode (UI changes)
    this.applyMode(mode);

    // Only persist if mode actually changed
    if (storedMode !== mode) {
      // Use Global target to avoid workspace config churn
      await config.update("mode", mode, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * Applies the UI mode without persisting to configuration.
   * Used internally for both loading config and user-initiated changes.
   */
  private applyMode(mode: UIMode): void {
    // Clean up current registrations
    this.cleanupRegistrations();

    this.currentMode = mode;

    switch (mode) {
      case "hover":
        this.updateStatusBar("$(comment-discussion)", "Hover Mode");
        break;

      case "peek":
        this.enablePeekMode();
        this.updateStatusBar("$(eye)", "Peek Mode");
        break;

      case "quickpeek":
        this.updateStatusBar("$(zap)", "Quick Peek Mode");
        break;

      case "inlinepeek":
        this.updateStatusBar("$(lightbulb)", "Inline Peek Mode");
        break;

      case "sidepanel":
        this.updateStatusBar("$(layout-sidebar-right)", "Side Panel Mode");
        vscode.commands.executeCommand("ghia-ai.explanationPanel.focus");
        break;

      case "floatingpanel":
        this.updateStatusBar("$(window)", "Floating Panel Mode");
        break;
    }
  }

  /**
   * Enables Peek mode.
   * Peek is now command-based (ghia-ai.peekExplanation) to avoid
   * intercepting Go to Definition. No provider registration needed.
   */
  private enablePeekMode(): void {
    // Peek mode is command-based - no definition provider registration
    // Users invoke via the ghia-ai.peekExplanation command
  }

  /**
   * Cleans up all provider registrations.
   */
  private cleanupRegistrations(): void {
  }

  /**
   * Updates the status bar item.
   */
  private updateStatusBar(icon: string, tooltip: string): void {
    this.statusBarItem.text = `${icon} AI Mode`;
    this.statusBarItem.tooltip = `ghia-ai: ${tooltip}\nClick to change mode`;
    this.statusBarItem.show();
  }

  /**
   * Gets the current active mode.
   */
  getMode(): UIMode {
    return this.currentMode;
  }

  /**
   * Triggers explanation based on current mode.
   */
  async explain(): Promise<void> {
    switch (this.currentMode) {
      case "quickpeek":
        await this.quickPeekProvider?.showQuickPeek();
        break;
      case "inlinepeek":
        await this.inlinePeekProvider?.showInlinePeek();
        break;
      case "sidepanel":
        await this.sidePanelProvider?.explainCurrentSelection();
        break;
      case "floatingpanel":
        await this.floatingPanelProvider?.showExplanation();
        break;
      default:
        vscode.window.showInformationMessage(
          `In ${this.currentMode} mode, hover or run a ghia-ai command to see explanations.`
        );
    }
  }

  dispose(): void {
    this.cleanupRegistrations();
    this.disposables.forEach((d) => d.dispose());
  }
}
