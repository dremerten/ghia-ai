import * as vscode from "vscode";
import { ContextExtractor } from "../utils/contextExtractor";

type Lang = "python" | "javascript" | "typescript";

/**
 * Lightweight, non-CodeLens decoration that adds an "Explain this code" label above function definitions.
 * Clicking the hover link triggers PyAid to explain the detected function.
 */
export class ExplainDecorationProvider implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];
  private readonly extractor = new ContextExtractor();
  private links: vscode.DocumentLink[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        contentText: "Explain this function/method definition",
        color: new vscode.ThemeColor("textLink.foreground"),
        margin: "0 8px 0 0",
        fontWeight: "600",
        textDecoration: "underline",
        cursor: "pointer",
        border: "1px solid transparent",
      },
    });

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshActive()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshActive()),
      vscode.workspace.onDidOpenTextDocument(() => this.refreshActive()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document === e.document) {
          this.refreshActive();
        }
      }),
      vscode.commands.registerCommand(
        "pyaid.explainFunctionAt",
        async (...args: any[]) => {
          const raw = Array.isArray(args[0]) ? args[0] : args;
          const payload =
            typeof raw === "string"
              ? JSON.parse(decodeURIComponent(raw))
              : raw;
          const [uriStr, line] = payload ?? [];
          if (typeof uriStr !== "string" || typeof line !== "number") return;
          await this.explainAt(vscode.Uri.parse(uriStr), line);
        }
      ),
      vscode.languages.registerDocumentLinkProvider(
        [
          { scheme: "file", language: "python" },
          { scheme: "file", language: "javascript" },
          { scheme: "file", language: "typescript" },
        ],
        {
          provideDocumentLinks: (document) => this.provideLinks(document),
        }
      )
    );

    this.refreshActive();
    setTimeout(() => this.refreshActive(), 250);
  }

  private refreshActive(): void {
    this.links = [];
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const lang = this.mapLanguage(doc.languageId);
    if (!lang) {
      editor.setDecorations(this.decoration, []);
      return;
    }

    const ranges: vscode.DecorationOptions[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      if (!this.isFunctionLine(doc.lineAt(i).text, lang)) continue;

      const args = encodeURIComponent(JSON.stringify([doc.uri.toString(), i]));
      const md = new vscode.MarkdownString(
        `[Explain this function/method definition](command:pyaid.explainFunctionAt?${args})`
      );
      md.isTrusted = true;

      const decorationLine = i > 0 ? i - 1 : 0;
      const spacerRange = new vscode.Range(decorationLine, 0, decorationLine, 0);
      ranges.push({
        range: spacerRange,
        hoverMessage: md,
      });

      const target = vscode.Uri.parse(`command:pyaid.explainFunctionAt?${args}`);
      this.links.push(
        new vscode.DocumentLink(
          new vscode.Range(i, 0, i, doc.lineAt(i).text.length),
          target
        )
      );
    }

    editor.setDecorations(this.decoration, ranges);
  }

  private mapLanguage(languageId: string): Lang | null {
    if (languageId === "python") return "python";
    if (languageId === "javascript" || languageId === "typescript") {
      return languageId;
    }
    return null;
  }

  private provideLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const lang = this.mapLanguage(document.languageId);
    if (!lang) return [];
    return this.links;
  }

  private isFunctionLine(line: string, lang: Lang): boolean {
    const trimmed = line.trim();

    if (lang === "python") {
      return /^(?:async\s+def|def)\s+[A-Za-z_]\w*\s*\(.*\)\s*(?:->\s*[^:]+)?\s*:\s*$/.test(
        trimmed
      );
    }

    if (/^(export\s+)?(async\s+)?function\s+\w+\s*\(/.test(trimmed)) {
      return true;
    }

    if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*\(.*\)\s*=>/.test(trimmed)) {
      return true;
    }

    if (
      /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*[A-Za-z_$]\w*\s*\(.*\)\s*(?::\s*[^=]+)?\s*\{?$/.test(
        trimmed
      )
    ) {
      if (/^(if|for|while|switch|catch)\b/.test(trimmed)) return false;
      return true;
    }

    return false;
  }

  private async explainAt(uri: vscode.Uri, line: number): Promise<void> {
    const active = vscode.window.activeTextEditor;
    const useActive = active && active.document.uri.toString() === uri.toString();
    const doc = useActive
      ? active!.document
      : await vscode.workspace.openTextDocument(uri);
    const editor = useActive
      ? active!
      : await vscode.window.showTextDocument(doc, { preview: false });

    const code = this.extractFunctionBlock(doc, line);
    if (!code) {
      void vscode.window.showWarningMessage(
        "PyAid: Could not find function body to explain."
      );
      return;
    }

    const context = this.extractor.extract(doc, new vscode.Position(line, 0)).context;
    const selection = new vscode.Selection(line, 0, line, 0);
    editor.selection = selection;
    await vscode.commands.executeCommand("pyaid.explainCode", [code, context]);
  }

  private extractFunctionBlock(
    doc: vscode.TextDocument,
    startLine: number
  ): string | null {
    const lang = this.mapLanguage(doc.languageId);
    if (!lang) return null;
    const startText = doc.lineAt(startLine).text;

    if (lang === "python") {
      const indent = startText.match(/^\s*/)?.[0].length ?? 0;
      let end = startLine + 1;
      while (end < doc.lineCount) {
        const lineText = doc.lineAt(end).text;
        if (lineText.trim().length === 0) break;
        const currentIndent = lineText.match(/^\s*/)?.[0].length ?? 0;
        if (currentIndent <= indent && !/^\s*#/.test(lineText)) break;
        end++;
      }
      return doc.getText(new vscode.Range(startLine, 0, end, 0)).trim();
    }

    let brace = 0;
    let end = startLine;
    let foundBrace = false;
    while (end < doc.lineCount) {
      const lineText = doc.lineAt(end).text;
      for (const ch of lineText) {
        if (ch === "{") {
          brace++;
          foundBrace = true;
        } else if (ch === "}") {
          brace--;
        }
      }
      if (foundBrace && brace <= 0) {
        end++;
        break;
      }
      end++;
    }
    return doc.getText(new vscode.Range(startLine, 0, end, 0)).trim();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.decoration.dispose();
  }
}
