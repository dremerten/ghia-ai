import * as vscode from "vscode";
import { StateManager } from "./stateManager";
import { MenuManager } from "./menuManager";

/** Priority for right side of status bar; higher values sit further right. */
const STATUS_BAR_PRIORITY = 100;

const TOOLTIP_ENABLED = "ghia-ai - Click to configure";
const TOOLTIP_DISABLED = "ghia-ai (disabled) - Click to enable";

/**
 * Manages the ghia-ai status bar item: icon (eye/eye-closed), tooltip, click-to-menu,
 * and subscription to StateManager so the icon reflects enabled/disabled state.
 */
export class StatusBarManager {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly stateManager: StateManager,
    private readonly menuManager: MenuManager
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY
    );
    this.updateIcon(this.stateManager.getEnabled());

    this.subscriptions.push(
      this.stateManager.onDidChangeEnabled((enabled) =>
        this.updateIcon(enabled)
      )
    );
  }

  /**
   * Registers the click handler that opens the menu. Call once during activation.
   * Returns a disposable that unregisters the command.
   */
  registerClickHandler(context: vscode.ExtensionContext): vscode.Disposable {
    const disposable = vscode.commands.registerCommand(
      "ghia-ai.statusBarClick",
      () => {
        this.menuManager.showMainMenu();
      }
    );
    context.subscriptions.push(disposable);
    this.statusBarItem.command = "ghia-ai.statusBarClick";
    this.statusBarItem.tooltip = this.stateManager.getEnabled()
      ? TOOLTIP_ENABLED
      : TOOLTIP_DISABLED;
    return disposable;
  }

  /**
   * Switches icon and tooltip between enabled (eye open) and disabled (eye closed).
   */
  updateIcon(enabled: boolean): void {
    this.statusBarItem.text = enabled ? "$(eye)" : "$(eye-closed)";
    this.statusBarItem.tooltip = enabled ? TOOLTIP_ENABLED : TOOLTIP_DISABLED;
    this.statusBarItem.show();
  }

  show(): void {
    this.statusBarItem.show();
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
    this.statusBarItem.dispose();
  }
}
