import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import type * as FuseModule from "fuse.js" with { "resolution-mode": "import" };
type FuseConstructor = new <T>(
  list: readonly T[],
  options?: any
) => { search: (pattern: string) => Array<{ item: T }> };
let Fuse: FuseConstructor;

(async () => {
  // Dynamically import fuse.js to avoid import issues with CommonJS/ESM interop
  const module = await import("fuse.js");
  Fuse = (module.default ? module.default : module) as FuseConstructor;
})();

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
      "emacsFindFileHistory"
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

  private shouldIgnore(fileName: string): boolean {
    const ignorePatterns = [
      "node_modules",
      ".git",
      ".DS_Store",
      "*.log",
      "*.tmp",
    ];

    return ignorePatterns.some((pattern) => {
      if (pattern.startsWith("*")) {
        return fileName.endsWith(pattern.substring(1));
      }
      return fileName === pattern;
    });
  }

  private async getDirectoryContents(
    uri: vscode.Uri
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

      // Sort by recency first, then alphabetically
      const sortedEntries = entries.sort((a, b) => {
        const [aName, aType] = a;
        const [bName, bType] = b;

        // Skip ignored files
        if (this.shouldIgnore(aName)) {
          return 1;
        }
        if (this.shouldIgnore(bName)) {
          return -1;
        }

        // Check history - sort by recency regardless of type
        const aPath = path.join(uri.fsPath, aName);
        const bPath = path.join(uri.fsPath, bName);
        const aHistory = this.history.get(aPath);
        const bHistory = this.history.get(bPath);

        if (aHistory && !bHistory) {
          return -1;
        }
        if (bHistory && !aHistory) {
          return 1;
        }
        if (aHistory && bHistory) {
          return bHistory.timestamp - aHistory.timestamp;
        }

        // Alphabetical for non-history items
        return aName.localeCompare(bName);
      });

      // Add entries to quick pick
      for (const [name, type] of sortedEntries) {
        // Skip ignored files
        if (this.shouldIgnore(name)) {
          continue;
        }

        const fullPath = path.join(uri.fsPath, name);
        const historyEntry = this.history.get(fullPath);
        const isDirectory = type === vscode.FileType.Directory;

        items.push({
          label: `${isDirectory ? "$(folder)" : "$(file)"} ${name}`,
          description: isDirectory ? "Directory" : "File",
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
        "Cancel"
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
      const input = this.quickPick?.value.trim();

      // If there's a selection, prioritize it over typed input
      // Only use typed input if there's no selection or if it contains path separators
      if (selection && (!input || (!input.includes("/") && !input.includes("\\")))) {
        // User selected an item from the list (possibly after filtering)
      const label = selection.label;

      if (label.startsWith("$(arrow-up) ..")) {
        // Navigate up
        this.currentPath = vscode.Uri.file(
          path.dirname(this.currentPath!.fsPath)
        );
        this.quickPick!.items = await this.getDirectoryContents(
          this.currentPath
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
            this.currentPath
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
      } else if (input) {
        // No selection but user typed something - handle as path
        await this.handlePathInput(input);
      }
    });

    // Handle value changes (typing)
    this.quickPick.onDidChangeValue(async (value) => {
      if (value.includes("/") || value.includes("\\")) {
        return;
      }

      const allItems = await this.getDirectoryContents(this.currentPath!);

      if (value) {
        const fuse = new Fuse(allItems, {
          keys: ["label", "description"],
          threshold: 0.4,
        });
        this.quickPick!.items = fuse.search(value).map((result) => result.item);
      } else {
        this.quickPick!.items = allItems;
      }
    });

    // Add preview in onDidChangeSelection
    this.quickPick.onDidChangeSelection(async (selection) => {
      if (selection[0] && !selection[0].label.includes("$(arrow-up)")) {
        const fileName = selection[0].label.substring(
          selection[0].label.indexOf(" ") + 1
        );
        const fullPath = path.join(this.currentPath!.fsPath, fileName);

        try {
          const stat = await vscode.workspace.fs.stat(
            vscode.Uri.file(fullPath)
          );
          if (stat.type === vscode.FileType.File) {
            // Preview file content
            const content = await vscode.workspace.fs.readFile(
              vscode.Uri.file(fullPath)
            );
            const preview = content.toString().substring(0, 200);
            selection[0].detail = `Preview: ${preview}...`;
          }
        } catch (error) {
          // File doesn't exist yet
        }
      }
    });

    this.quickPick.onDidHide(() => {
      this.quickPick?.dispose();
      this.quickPick = undefined;
      this.currentPath = undefined;
    });

    this.quickPick.show();
  }

  async showSwitchEditorQuickPick(): Promise<void> {
    const itemToUri = new Map<vscode.QuickPickItem, vscode.Uri>();
    const allTabs: { tab: vscode.Tab; uri: vscode.Uri }[] = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri) {
          allTabs.push({ tab, uri: tab.input.uri });
        }
      }
    }

    if (allTabs.length === 0) {
      vscode.window.showInformationMessage("No open editors.");
      return;
    }

    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const order = allTabs.slice();
    if (activeTab && activeTab.input instanceof vscode.TabInputText) {
      const activeUri = activeTab.input.uri;
      const idx = order.findIndex((e) => e.uri.toString() === activeUri.toString());
      if (idx > 0) {
        const [active] = order.splice(idx, 1);
        order.unshift(active);
      }
    }

    const allEditorItems: { item: vscode.QuickPickItem; uri: vscode.Uri }[] = order.map(
      ({ uri }) => {
        const label = path.basename(uri.fsPath) || uri.path || "Untitled";
        const item: vscode.QuickPickItem = {
          label: `$(file) ${label}`,
          description: uri.fsPath,
          alwaysShow: true,
        };
        itemToUri.set(item, uri);
        return { item, uri };
      }
    );

    const switchPick = vscode.window.createQuickPick();
    switchPick.placeholder = "Switch to open editor…";
    switchPick.title = "Emacs: Switch to Open Editor";
    switchPick.items = allEditorItems.map((e) => e.item);

    switchPick.onDidChangeValue((value) => {
      if (value) {
        const fuse = new Fuse(allEditorItems, {
          keys: ["item.label", "item.description"],
          threshold: 0.4,
        });
        switchPick.items = fuse.search(value).map((r) => r.item.item);
      } else {
        switchPick.items = allEditorItems.map((e) => e.item);
      }
    });

    switchPick.onDidAccept(() => {
      const selection = switchPick.selectedItems[0];
      if (!selection) {
        return;
      }
      const uri = itemToUri.get(selection);
      if (uri) {
        vscode.window.showTextDocument(uri);
      }
      switchPick.hide();
    });

    switchPick.onDidHide(() => switchPick.dispose());
    switchPick.show();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const emacsFindFile = new EmacsFindFile(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("emacs-find-file.findFile", () => {
      emacsFindFile.showQuickPick();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "emacs-find-file.switchToOpenEditor",
      () => {
        emacsFindFile.showSwitchEditorQuickPick();
      }
    )
  );
}

export function deactivate() {}
