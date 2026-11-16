"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mcvault", {
    getAppInfo: () => ipcRenderer.invoke("app:get-info"),

    getLibrary: () =>
        ipcRenderer.invoke("library:get"),

    onAppState: (callback) => {
        const listener = (_event, state) => {
            callback(state);
        };

        ipcRenderer.on("app:state", listener);

        return () => {
            ipcRenderer.removeListener("app:state", listener);
        };
    },

    updateModpack: (modpackId, changes, expectedUpdatedAt) =>
        ipcRenderer.invoke(
            "modpack:update",
            modpackId,
            changes,
            expectedUpdatedAt
        ),

    updateBackup: (backupId, changes, expectedUpdatedAt) =>
        ipcRenderer.invoke(
            "backup:update",
            backupId,
            changes,
            expectedUpdatedAt
        ),

    confirmDiscard: (kind) =>
        ipcRenderer.invoke("ui:confirm-discard", kind),

    scanPotentialDuplicates: () =>
        ipcRenderer.invoke("cleanup:scan-duplicates"),

    showBackupInExplorer: (backupId) =>
        ipcRenderer.invoke("library:show-backup", backupId),

    chooseStorageDirectory: () =>
        ipcRenderer.invoke("storage:choose"),

    confirmStorageDirectory: () =>
        ipcRenderer.invoke("storage:confirm"),

    openImportPicker: (sourceType) =>
        ipcRenderer.invoke("import:open-picker", sourceType),

    executeImport: (metadata) =>
        ipcRenderer.invoke("import:execute", metadata),

    onImportProgress: (callback) => {
        const listener = (_event, progress) => {
            callback(progress);
        };

        ipcRenderer.on("import:progress", listener);

        return () => {
            ipcRenderer.removeListener("import:progress", listener);
        };
    },

    moveBackupToTrash: (backupId) =>
        ipcRenderer.invoke("backup:move-to-trash", backupId),

    listTrash: () =>
        ipcRenderer.invoke("trash:list"),

    emptyTrash: () =>
        ipcRenderer.invoke("trash:empty"),

    getSettings: () =>
        ipcRenderer.invoke("settings:get"),

    updateCleanupSettings: (settings) =>
        ipcRenderer.invoke(
            "settings:update-cleanup",
            settings
        ),

    chooseSettingsStorage: () =>
        ipcRenderer.invoke("settings:choose-storage"),

    applySettingsStorage: () =>
        ipcRenderer.invoke("settings:apply-storage")

});