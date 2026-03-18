import * as vscode from "vscode";

const STATE_KEY = "ghia-ai.state";
const DEBOUNCE_MS = 500;

interface ExtensionState {
  enabled: boolean;
  hasShownWelcome: boolean;
}

const DEFAULT_STATE: ExtensionState = {
  enabled: true,
  hasShownWelcome: false,
};

/**
 * Holds extension enabled/disabled state and welcome visibility, and notifies
 * subscribers when enabled changes. Used by StatusBarManager to keep the status
 * bar icon in sync.
 */
export class StateManager {
  private _state: ExtensionState;
  private readonly _onDidChangeEnabled = new vscode.EventEmitter<boolean>();
  readonly onDidChangeEnabled: vscode.Event<boolean> =
    this._onDidChangeEnabled.event;

  private _setEnabledDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._state = this.loadState();
  }

  private loadState(): ExtensionState {
    const stored = this.context.globalState.get<ExtensionState>(STATE_KEY);
    if (stored && typeof stored.enabled === "boolean") {
      return {
        enabled: stored.enabled,
        hasShownWelcome: Boolean(stored.hasShownWelcome),
      };
    }
    return { ...DEFAULT_STATE };
  }

  getEnabled(): boolean {
    return this._state.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this._state.enabled === enabled) return;
    this._state = { ...this._state, enabled };

    if (this._setEnabledDebounceTimer !== undefined) {
      clearTimeout(this._setEnabledDebounceTimer);
    }
    this._setEnabledDebounceTimer = setTimeout(() => {
      this._setEnabledDebounceTimer = undefined;
      void this.persistStateAndNotify();
    }, DEBOUNCE_MS);
  }

  private async persistStateAndNotify(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, this._state);
    this._onDidChangeEnabled.fire(this._state.enabled);
  }

  hasShownWelcome(): boolean {
    return this._state.hasShownWelcome;
  }

  async markWelcomeShown(): Promise<void> {
    if (this._state.hasShownWelcome) return;
    this._state = { ...this._state, hasShownWelcome: true };
    await this.context.globalState.update(STATE_KEY, this._state);
  }

  dispose(): void {
    if (this._setEnabledDebounceTimer !== undefined) {
      void this.context.globalState.update(STATE_KEY, this._state);
      clearTimeout(this._setEnabledDebounceTimer);
      this._setEnabledDebounceTimer = undefined;
    }
    this._onDidChangeEnabled.dispose();
  }
}
