import * as vscode from "vscode";
import { StateManager } from "./stateManager";
import { readEndpointFromFile } from "../utils/endpoint";

const CONFIG_NS = "PyAid";
const ACTION_PREFIX = "action:";

const DEFAULT_MODEL = "llama3";
const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const OLLAMA_MODELS = ["llama3", "llama3.2", "codellama", "mistral", "phi3"];

type MenuAction = "toggle" | "openSettings" | "showModelMenu";

interface ActionableQuickPickItem extends vscode.QuickPickItem {
  readonly action?: MenuAction;
}

interface MenuConfig {
  model: string;
  ollamaEndpoint: string;
}

/**
 * Status-bar menu focused on local Ollama.
 */
export class MenuManager {
  private quickPick: vscode.QuickPick<ActionableQuickPickItem> | undefined;
  private submenuQuickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;
  private configWatcherDisposable: vscode.Disposable | undefined;

  constructor(
    private readonly stateManager: StateManager,
    private readonly context: vscode.ExtensionContext
  ) {
    this.configWatcherDisposable = vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (
          e.affectsConfiguration("PyAid") &&
          this.quickPick &&
          (this.quickPick as { visible?: boolean }).visible
        ) {
          this.quickPick.items = this.buildItems();
        }
      }
    );
    context.subscriptions.push(this.configWatcherDisposable);
  }

  private getConfig(): MenuConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_NS);
    const modelFromConfig = config.get("model");
    const inspect = config.inspect<string>("ollamaEndpoint");
    const hasUserEndpoint = Boolean(
      inspect?.globalValue ?? inspect?.workspaceValue ?? inspect?.workspaceFolderValue
    );
    const endpointFromConfig = hasUserEndpoint ? config.get("ollamaEndpoint") : undefined;
    const fileEndpoint = readEndpointFromFile();
    const envEndpoint = process.env.GHIA_AI_OLLAMA_ENDPOINT;
    const model =
      typeof modelFromConfig === "string" && modelFromConfig.trim()
        ? modelFromConfig
        : DEFAULT_MODEL;

    const resolvedEndpoint =
      (typeof endpointFromConfig === "string" && endpointFromConfig.trim()
        ? endpointFromConfig.trim()
        : undefined) ??
      (typeof envEndpoint === "string" && envEndpoint.trim()
        ? envEndpoint.trim()
        : undefined) ??
      fileEndpoint ??
      DEFAULT_ENDPOINT;
    return {
      model,
      // Default to local Ollama; users can override in settings if remote.
      ollamaEndpoint: resolvedEndpoint,
    };
  }

  /**
   * Checks Ollama connectivity via HTTP GET to /api/tags. Returns true if
   * the endpoint responds successfully.
   */
  async checkOllamaConnectivity(): Promise<boolean> {
    const { ollamaEndpoint } = this.getConfig();
    const url = `${ollamaEndpoint.replace(/\/$/, "")}/api/tags`;
    try {
      const res = await fetch(url, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Builds the main menu items: Control (toggle with checkmark) and
   * Configuration (Open Settings), with separators.
   */
  private buildItems(): ActionableQuickPickItem[] {
    const enabled = this.stateManager.getEnabled();
    const toggleLabel = enabled
      ? "$(check) PyAid enabled"
      : "PyAid disabled";
    const toggleDescription = enabled
      ? "Click to disable hover explanations"
      : "Click to enable hover explanations";

    return [
      {
        label: "Control",
        kind: vscode.QuickPickItemKind.Separator,
      },
      {
        label: toggleLabel,
        description: toggleDescription,
        detail: `${ACTION_PREFIX}toggle`,
        action: "toggle",
      },
      {
        label: "Configuration",
        kind: vscode.QuickPickItemKind.Separator,
      },
      {
        label: "$(symbol-misc) Change model",
        description: "Model served by your local Ollama",
        detail: `${ACTION_PREFIX}showModelMenu`,
        action: "showModelMenu",
      },
      {
        label: "$(settings-gear) Open Settings",
        description: "Configure model and Ollama endpoint",
        detail: `${ACTION_PREFIX}openSettings`,
        action: "openSettings",
      },
    ];
  }

  private getAction(item: ActionableQuickPickItem): MenuAction | undefined {
    return (
      item.action ??
      (item.detail?.startsWith(ACTION_PREFIX)
        ? (item.detail.slice(ACTION_PREFIX.length) as MenuAction)
        : undefined)
    );
  }

  private async runAction(action: MenuAction): Promise<void> {
    if (action === "toggle") {
      await this.stateManager.setEnabled(!this.stateManager.getEnabled());
    } else if (action === "openSettings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        CONFIG_NS
      );
    } else if (action === "showModelMenu") {
      this.quickPick?.hide();
      this.showModelMenu();
    }
  }

  /**
   * Shows model selection menu for Ollama. Checkmark indicates current model.
   */
  showModelMenu(): void {
    const config = this.getConfig();
    const items: vscode.QuickPickItem[] = OLLAMA_MODELS.map((model) => ({
      label: config.model === model ? `$(check) ${model}` : model,
      detail: model,
    }));

    if (!this.submenuQuickPick) {
      this.submenuQuickPick =
        vscode.window.createQuickPick<vscode.QuickPickItem>();
      this.submenuQuickPick.canSelectMany = false;
      this.submenuQuickPick.onDidHide(() => {
        this.submenuQuickPick!.selectedItems = [];
      });
      this.context.subscriptions.push(this.submenuQuickPick);
    }

    this.submenuQuickPick.title = "Select Ollama model";
    this.submenuQuickPick.placeholder = "Model served by Ollama";
    this.submenuQuickPick.items = items;
    this.submenuQuickPick.selectedItems = [];
    this.submenuQuickPick.show();

    const acceptDisposable = this.submenuQuickPick.onDidAccept(() => {
      const selected = this.submenuQuickPick!.selectedItems[0];
      if (!selected?.detail) return;
      const model = selected.detail;
      const configTarget = vscode.ConfigurationTarget.Global;
      void vscode.workspace
        .getConfiguration(CONFIG_NS)
        .update("model", model, configTarget);
      this.submenuQuickPick!.hide();
    });

    const hideDisposable = this.submenuQuickPick.onDidHide(() => {
      acceptDisposable.dispose();
      hideDisposable.dispose();
      this.showMainMenu();
    });
  }

  /**
   * Shows the main menu using createQuickPick. Menu stays open after each
   * accept so the user can perform multiple actions; config changes refresh
   * items in real time.
   */
  showMainMenu(): void {
    if (!this.quickPick) {
      this.quickPick = vscode.window.createQuickPick<ActionableQuickPickItem>();
      this.quickPick.title = "PyAid";
      this.quickPick.placeholder = "Choose an action (multiple allowed)";
      this.quickPick.matchOnDescription = true;
      this.quickPick.canSelectMany = true;

      this.quickPick.onDidAccept(() => {
        const selected = this.quickPick!.selectedItems;
        const actions = new Set<MenuAction>();
        for (const item of selected) {
          const action = this.getAction(item);
          if (action) actions.add(action);
        }
        void (async () => {
          for (const action of actions) {
            await this.runAction(action);
          }
          this.quickPick!.selectedItems = [];
          this.quickPick!.items = this.buildItems();
        })();
      });

      this.quickPick.onDidHide(() => {
        this.quickPick!.selectedItems = [];
      });
    }

    this.quickPick.items = this.buildItems();
    this.quickPick.selectedItems = [];
    this.quickPick.show();
  }

  /**
   * Alias for status bar click handler. Opens the main menu.
   */
  show(): void {
    this.showMainMenu();
  }

  dispose(): void {
    this.configWatcherDisposable?.dispose();
    this.submenuQuickPick?.dispose();
    this.submenuQuickPick = undefined;
    this.quickPick?.dispose();
    this.quickPick = undefined;
  }
}
