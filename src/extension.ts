import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

interface FileHistoryEntry {
  uri: vscode.Uri;
  timestamp: number;
  type: "file" | "directory";
}

class EmacsFindFile {
  private history: Map<string, FileHistoryEntry> = new Map();
  private currentPath: vscode.Uri | undefined;
  private quickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;

  constructor(private context: vscode.ExtensionContext) {
    this.loadHistory();
    this.setupWatchers();
  }

  private loadHistory() {
    const historyData = this.context.globalState.get<FileHistoryEntry[]>(
      "emacsFindFileHistory",
    );
    if (historyData) {
      historyData.forEach((entry) => {
        this.history.set(entry.uri.fsPath, entry);
      });
    }
  }

  private saveHistory() {
    const historyArray = Array.from(this.history.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100); // Keep last 100 entries
    this.context.globalState.update("emacsFindFileHistory", historyArray);
  }

  private setupWatchers() {
    // Watch for file opens to update history
    vscode.workspace.onDidOpenTextDocument((doc) => {
      this.updateHistory(doc.uri, "file");
    });
  }

  private updateHistory(uri: vscode.Uri, type: "file" | "directory") {
    this.history.set(uri.fsPath, {
      uri,
      timestamp: Date.now(),
      type,
    });
    this.saveHistory();
  }

  private getCurrentPath(): vscode.Uri {
    if (this.currentPath) {
      return this.currentPath;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && !activeEditor.document.isUntitled) {
      return vscode.Uri.file(path.dirname(activeEditor.document.fileName));
    }

    // Use first workspace folder as root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri;
    }

    // Fallback to home directory
    return vscode.Uri.file(require("os").homedir());
  }

  private async getDirectoryContents(
    uri: vscode.Uri,
  ): Promise<vscode.QuickPickItem[]> {
    const items: vscode.QuickPickItem[] = [];

    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);

      // Add parent directory (..) if not at root
      if (uri.fsPath !== path.dirname(uri.fsPath)) {
        items.push({
          label: "$(arrow-up) ..",
          description: "Go to parent directory",
          alwaysShow: true,
        });
      }

      // Sort: directories first, then files, with recent items at top
      const sortedEntries = entries.sort((a, b) => {
        const [aName, aType] = a;
        const [bName, bType] = b;

        // Directories first
        if (
          aType === vscode.FileType.Directory &&
          bType !== vscode.FileType.Directory
        ) {
          return -1;
        }
        if (
          bType === vscode.FileType.Directory &&
          aType !== vscode.FileType.Directory
        ) {
          return 1;
        }

        // Check history
        const aPath = path.join(uri.fsPath, aName);
        const bPath = path.join(uri.fsPath, bName);
        const aHistory = this.history.get(aPath);
        const bHistory = this.history.get(bPath);

        if (aHistory && !bHistory) return -1;
        if (bHistory && !aHistory) return 1;
        if (aHistory && bHistory) {
          return bHistory.timestamp - aHistory.timestamp;
        }

        // Alphabetical for non-history items
        return aName.localeCompare(bName);
      });

      // Add entries to quick pick
      for (const [name, type] of sortedEntries) {
        const fullPath = path.join(uri.fsPath, name);
        const historyEntry = this.history.get(fullPath);
        const isDirectory = type === vscode.FileType.Directory;

        items.push({
          label: `${isDirectory ? "$(folder)" : "$(file)"} ${name}`,
          description: isDirectory ? "Directory" : "File",
          detail: historyEntry
            ? `Last opened: ${new Date(historyEntry.timestamp).toLocaleString()}`
            : undefined,
          alwaysShow: true,
        });
      }
    } catch (error) {
      console.error("Error reading directory:", error);
    }

    return items;
  }

  private async handlePathInput(input: string): Promise<void> {
    const currentUri = this.getCurrentPath();
    let targetUri: vscode.Uri;

    // Handle relative paths
    if (
      input.startsWith("./") ||
      input.startsWith("../") ||
      !path.isAbsolute(input)
    ) {
      targetUri = vscode.Uri.file(path.resolve(currentUri.fsPath, input));
    } else {
      targetUri = vscode.Uri.file(input);
    }

    try {
      const stat = await vscode.workspace.fs.stat(targetUri);

      if (stat.type === vscode.FileType.Directory) {
        // Navigate to directory
        this.currentPath = targetUri;
        await this.showQuickPick();
      } else {
        // Open file
        await vscode.window.showTextDocument(targetUri);
        this.updateHistory(targetUri, "file");
        this.quickPick?.hide();
      }
    } catch (error: any) {
      // File doesn't exist - prompt for creation
      const shouldCreate = await vscode.window.showWarningMessage(
        `File "${targetUri.fsPath}" doesn't exist. Create it?`,
        "Create File",
        "Cancel",
      );

      if (shouldCreate === "Create File") {
        // Create parent directories if needed
        const dirPath = path.dirname(targetUri.fsPath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));

        // Create empty file
        await vscode.workspace.fs.writeFile(targetUri, new Uint8Array());

        // Open the new file
        await vscode.window.showTextDocument(targetUri);
        this.updateHistory(targetUri, "file");
        this.quickPick?.hide();
      }
    }
  }

  async showQuickPick(): Promise<void> {
    this.currentPath = this.getCurrentPath();

    this.quickPick = vscode.window.createQuickPick();
    this.quickPick.placeholder = `Find file in: ${this.currentPath.fsPath}`;
    this.quickPick.title = "Emacs Find File";

    // Load initial directory contents
    this.quickPick.items = await this.getDirectoryContents(this.currentPath);

    // Handle item selection
    this.quickPick.onDidAccept(async () => {
      const selection = this.quickPick?.selectedItems[0];
      if (!selection) {
        return;
      }

      const input = this.quickPick?.value.trim();
      if (input) {
        // User typed something - handle as path
        await this.handlePathInput(input);
        return;
      }

      // User selected an item from the list
      const label = selection.label;

      if (label.startsWith("$(arrow-up) ..")) {
        // Navigate up
        this.currentPath = vscode.Uri.file(
          path.dirname(this.currentPath!.fsPath),
        );
        this.quickPick!.items = await this.getDirectoryContents(
          this.currentPath,
        );
        this.quickPick!.placeholder = `Find file in: ${this.currentPath.fsPath}`;
        return;
      }

      // Extract filename from label (remove icon and space)
      const fileName = label.substring(label.indexOf(" ") + 1);
      const fullPath = path.join(this.currentPath!.fsPath, fileName);

      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));

        if (stat.type === vscode.FileType.Directory) {
          // Navigate into directory
          this.currentPath = vscode.Uri.file(fullPath);
          this.updateHistory(this.currentPath, "directory");
          this.quickPick!.items = await this.getDirectoryContents(
            this.currentPath,
          );
          this.quickPick!.placeholder = `Find file in: ${this.currentPath.fsPath}`;
          this.quickPick!.value = "";
        } else {
          // Open file
          await vscode.window.showTextDocument(vscode.Uri.file(fullPath));
          this.updateHistory(vscode.Uri.file(fullPath), "file");
          this.quickPick!.hide();
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Error accessing: ${fullPath}`);
      }
    });

    // Handle value changes (typing)
    this.quickPick.onDidChangeValue(async (value) => {
      if (value.includes("/") || value.includes("\\")) {
        // User is typing a path - we'll handle on accept
        this.quickPick!.items = [];
      } else if (value === "") {
        // Show directory contents when input is cleared
        this.quickPick!.items = await this.getDirectoryContents(
          this.currentPath!,
        );
      } else {
        // Filter current directory contents
        const allItems = await this.getDirectoryContents(this.currentPath!);
        this.quickPick!.items = allItems.filter((item) =>
          item.label.toLowerCase().includes(value.toLowerCase()),
        );
      }
    });

    this.quickPick.onDidHide(() => {
      this.quickPick?.dispose();
      this.quickPick = undefined;
      this.currentPath = undefined;
    });

    this.quickPick.show();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const emacsFindFile = new EmacsFindFile(context);

  const disposable = vscode.commands.registerCommand(
    "emacs-find-file.findFile",
    () => {
      emacsFindFile.showQuickPick();
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
