import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

type WriteMode = "append" | "replace" | "remove";

/**
 * True if the target path is inside any open workspace folder.
 * If no workspace is open, we allow writes (after user consent) so single-file
 * windows and custom paths still work.
 */
function isInsideWorkspace(target: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return true;

  return folders.some((f) => {
    const root = f.uri.fsPath;
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * Writes content to a file after an explicit user approval prompt.
 * Creates parent directories as needed. Rejects paths outside the workspace.
 */
export async function writeWithConsent(
  targetPath: string,
  content: string,
  mode: WriteMode = "append",
  allowWithoutPrompt = false
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const activeDir = vscode.window.activeTextEditor
    ? path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)
    : undefined;

  // Resolve relative paths against the first workspace folder when available,
  // otherwise fall back to the active file directory or process cwd.
  const baseDir = path.isAbsolute(targetPath)
    ? undefined
    : workspaceFolders[0]?.uri.fsPath ?? activeDir ?? process.cwd();

  const normalized = path.resolve(baseDir ?? process.cwd(), targetPath);
  if (!isInsideWorkspace(normalized)) {
    throw new Error(
      `Refused to write outside the workspace: ${normalized}. Choose a file inside the current workspace folders.`
    );
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(normalized)
  );
  const rel =
    workspaceFolder?.uri && vscode.workspace.asRelativePath(normalized);
  const label = rel ?? normalized;

  if (!allowWithoutPrompt) {
    const APPROVE = "Allow";
    const CANCEL = "Cancel";
    const choice = await vscode.window.showWarningMessage(
      `PyAid wants to ${mode} ${content.length} characters to "${label}".`,
      { modal: true },
      APPROVE,
      CANCEL
    );
    if (choice !== APPROVE) {
      throw new Error("User denied write permission.");
    }
  }

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(normalized), { recursive: true });

  if (mode === "replace") {
    await fs.writeFile(normalized, content, "utf8");
  } else if (mode === "append") {
    await fs.appendFile(normalized, content, "utf8");
  } else if (mode === "remove") {
    await fs.writeFile(normalized, content, "utf8");
  }
}

/**
 * Removes PyAid tagged blocks from a file.
 * Blocks are delimited by lines containing "PyAid:start" and "PyAid:end".
 */
export async function removePyAidBlocks(targetPath: string): Promise<void> {
  const normalized = path.resolve(targetPath);
  const content = await fs.readFile(normalized, "utf8").catch(() => "");
  const lines = content.split(/\r?\n/);
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.includes("PyAid:start")) {
      skipping = true;
      continue;
    }
    if (line.includes("PyAid:end")) {
      skipping = false;
      continue;
    }
    if (!skipping) result.push(line);
  }
  await fs.writeFile(normalized, result.join("\n"), "utf8");
}

export type { WriteMode };
