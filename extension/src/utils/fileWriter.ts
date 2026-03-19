import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

type WriteMode = "append" | "replace";

/** True if the target path is inside any open workspace folder. */
function isInsideWorkspace(target: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((f) => {
    const root = f.uri.fsPath;
    const rel = path.relative(root, target);
    return (
      rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
    );
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
  const normalized = path.resolve(targetPath);
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
      `ghia-ai wants to ${mode} ${content.length} characters to "${label}".`,
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
  } else {
    await fs.appendFile(normalized, content, "utf8");
  }
}
