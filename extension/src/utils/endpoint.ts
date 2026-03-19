import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * Reads an Ollama endpoint from a `.ghia-ai-endpoint` file if present.
 * Returns the first non-empty trimmed line, or null when not found.
 */
export function readEndpointFromFile(): string | null {
  const candidatePaths: string[] = [];

  // 1) Workspace roots (supports multi-root, prefer the first)
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    candidatePaths.push(path.join(folder.uri.fsPath, ".ghia-ai-endpoint"));
  }

  // 2) Extension folder when opened directly
  candidatePaths.push(path.join(__dirname, "..", ".ghia-ai-endpoint"));

  // 3) Repository root when workspace root is the extension subfolder
  candidatePaths.push(path.join(__dirname, "..", "..", ".ghia-ai-endpoint"));

  for (const candidate of candidatePaths) {
    try {
      const content = fs.readFileSync(candidate, "utf8");
      const line = content.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (line) return line.trim();
    } catch {
      // ignore missing/inaccessible files and keep searching
    }
  }

  return null;
}
