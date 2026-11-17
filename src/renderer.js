"use strict";

const importButton = document.getElementById("import-button");
const importFeedback = document.getElementById("import-feedback");

const appVersion = document.getElementById("app-version");
const technicalVersion = document.getElementById("technical-version");
const dataPath = document.getElementById("data-path");
const storageRoot = document.getElementById("storage-root");

const storageDialog = document.getElementById("storage-dialog");
const selectedStoragePath = document.getElementById(
    "selected-storage-path"
);

const chooseStorageButton = document.getElementById(
    "choose-storage-button"
);

const confirmStorageButton = document.getElementById(
    "confirm-storage-button"
);

const storageFeedback = document.getElementById("storage-feedback");

let storagePending = false;
let storageConfigured = false;

function showFeedback(message, isNotice = false) {
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.textContent = message;

    importFeedback.replaceChildren(dot, text);
    importFeedback.classList.toggle("is-notice", isNotice);
}

function showStorageFeedback(message, isError = false) {
    storageFeedback.textContent = message;
    storageFeedback.classList.toggle("is-error", isError);
}

function setStorageBusy(busy) {
    storagePending = busy;

    chooseStorageButton.disabled = busy;
    confirmStorageButton.disabled = busy;

    confirmStorageButton.textContent = busy
        ? "Configuration en cours..."
        : "Confirmer ce dossier";

    confirmStorageButton.setAttribute("aria-busy", String(busy));
}

function applyAppInfo(info) {
    storageConfigured = info.storageConfigured === true;

    appVersion.textContent = `v${info.appVersion}`;
    technicalVersion.textContent = info.appVersion;
    dataPath.textContent = info.dataPath;

    storageRoot.textContent = storageConfigured
        ? info.storageRoot
        : "Non configuré";

    importButton.disabled = !storageConfigured;

    if (!storageConfigured) {
        selectedStoragePath.textContent = info.defaultStorageRoot;

        if (!storageDialog.open) {
            storageDialog.showModal();
        }
    } else {
        if (storageDialog.open) {
            storageDialog.close();
        }

        showFeedback(
            "Dossier de stockage configuré. Tu peux importer une sauvegarde.",
            true
        );
    }
}

const importDialog = document.getElementById("import-dialog");
const closeImportButton = document.getElementById("close-import-button");
const chooseFolderButton = document.getElementById("choose-folder-button");
const chooseZipButton = document.getElementById("choose-zip-button");

const importSourcePath = document.getElementById("import-source-path");
const importSourceDetails = document.getElementById("import-source-details");

const importForm = document.getElementById("import-form");
const importModpack = document.getElementById("import-modpack");
const importBackupName = document.getElementById("import-backup-name");
const importBackupDate = document.getElementById("import-backup-date");

const importDestinationPreview = document.getElementById(
    "import-destination-preview"
);

const importDialogFeedback = document.getElementById(
    "import-dialog-feedback"
);

const importDebugArea = document.getElementById(
    "import-debug-area"
);

const importDebugDetails = document.getElementById(
    "import-debug-details"
);

const toggleImportDebugButton = document.getElementById(
    "toggle-import-debug-button"
);

const copyImportDebugButton = document.getElementById(
    "copy-import-debug-button"
);

let importDebugText = "";

let preparedSource = null;
let preparedStorageRoot = null;
let sourcePickerBusy = false;

let transferBusy = false;
let sourceConsumed = false;

const startImportButton = document.getElementById("start-import-button");
const transferProgressArea = document.getElementById("transfer-progress-area");
const transferProgressLabel = document.getElementById("transfer-progress-label");
const transferProgress = document.getElementById("transfer-progress");

const importPlayType = document.getElementById("import-play-type");
const importStatus = document.getElementById("import-status");

function setTransferBusy(busy) {
    transferBusy = busy;

    chooseFolderButton.disabled = busy;
    chooseZipButton.disabled = busy;
    closeImportButton.disabled = busy;

    importModpack.disabled = busy;
    importBackupName.disabled = busy;
    importBackupDate.disabled = busy;
    importPlayType.disabled = busy;
    importStatus.disabled = busy;

    startImportButton.disabled = busy || sourceConsumed;

    startImportButton.textContent = busy
        ? "Import en cours..."
        : "Déplacer et importer la sauvegarde";
}

window.mcvault.onImportProgress((progress) => {
    transferProgressArea.hidden = false;
    transferProgressLabel.textContent = progress.message;

    if (typeof progress.percent === "number") {
        transferProgress.value = progress.percent;
    } else {
        transferProgress.removeAttribute("value");
    }
});

function showImportDialogFeedback(
    message,
    isError = false,
    debugText = ""
) {
    importDialogFeedback.textContent = message;
    importDialogFeedback.classList.toggle("is-error", isError);

    importDebugText = debugText;

    if (debugText) {
        importDebugDetails.textContent = debugText;
        importDebugArea.hidden = false;
    } else {
        importDebugDetails.textContent = "";
        importDebugArea.hidden = true;
    }
}

function previewFolderName(value) {
    return value
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/g, "");
}

function updateImportPreview() {
    const modpack = previewFolderName(importModpack.value);
    const backupName = previewFolderName(importBackupName.value);

    if (!preparedSource || !preparedStorageRoot || !modpack || !backupName) {
        importDestinationPreview.textContent =
            "Sélectionne une source et renseigne le modpack et la sauvegarde.";

        return;
    }

    const now = new Date();

    const date = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0")
    ].join("-");

    const root = preparedStorageRoot.replace(/[\\/]+$/, "");

    const destinationFolder =
        `${root}\\backups\\${modpack}\\${date}_${backupName}`;

    importDestinationPreview.textContent =
        preparedSource.type === "zip"
            ? `${destinationFolder}\\${preparedSource.name}`
            : destinationFolder;
}

async function selectImportSource(sourceType) {
    if (sourcePickerBusy || transferBusy) {
        return;
    }

    sourcePickerBusy = true;
    chooseFolderButton.disabled = true;
    chooseZipButton.disabled = true;
    closeImportButton.disabled = true;

    try {
        const result = await window.mcvault.openImportPicker(sourceType);

        if (result.canceled) {
            showImportDialogFeedback(
                "Sélection annulée. La source précédente, s’il y en avait une, reste sélectionnée."
            );

            return;
        }

        if (!result.success) {
            showImportDialogFeedback(
                result.message || "Impossible de sélectionner cette source.",
                true
            );

            return;
        }

        preparedSource = result.source;
        preparedStorageRoot = result.storageRoot;

        sourceConsumed = false;
        startImportButton.disabled = false;
        transferProgressArea.hidden = true;

        importSourcePath.textContent = preparedSource.path;

        if (preparedSource.type === "zip") {
            const sizeMiB = preparedSource.sizeBytes / (1024 * 1024);

            importSourceDetails.textContent =
                `Archive ZIP — ${sizeMiB.toLocaleString("fr-FR", {
                    maximumFractionDigits: 2
                })} Mio. L’archive sera conservée sans extraction.`;
        } else {
            importSourceDetails.textContent =
                "Dossier sélectionné. Sa taille et son contenu seront contrôlés avant le transfert.";
        }

        if (!importBackupName.value.trim()) {
            importBackupName.value = preparedSource.suggestedName;
        }

        updateImportPreview();

        showImportDialogFeedback(
            "Source sélectionnée. Vérifie les informations avant de confirmer le déplacement."
        );
    } catch (error) {
        console.error("Sélection de la sauvegarde :", error);

        showImportDialogFeedback(
            "Impossible de préparer cette sélection.",
            true
        );
    } finally {
        sourcePickerBusy = false;
        chooseFolderButton.disabled = false;
        chooseZipButton.disabled = false;
        closeImportButton.disabled = false;
    }
}

chooseFolderButton.addEventListener("click", () => {
    selectImportSource("directory");
});

chooseZipButton.addEventListener("click", () => {
    selectImportSource("zip");
});

closeImportButton.addEventListener("click", () => {
    if (!transferBusy && !sourcePickerBusy) {
        importDialog.close();
    }
});

importDialog.addEventListener("cancel", (event) => {
    if (sourcePickerBusy || transferBusy) {
        event.preventDefault();
    }
});

importModpack.addEventListener("input", updateImportPreview);
importBackupName.addEventListener("input", updateImportPreview);

importForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (transferBusy || sourcePickerBusy) {
        return;
    }

    if (!preparedSource || sourceConsumed) {
        showImportDialogFeedback(
            "Sélectionne une source avant de continuer.",
            true
        );

        return;
    }

    if (!importForm.reportValidity()) {
        return;
    }

    setTransferBusy(true);

    transferProgressArea.hidden = false;
    transferProgress.removeAttribute("value");
    transferProgressLabel.textContent = "Préparation de l’import...";

    showImportDialogFeedback(
        "Analyse de la source, puis demande de confirmation."
    );

    try {
        const result = await window.mcvault.executeImport({
            modpackName: importModpack.value.trim(),
            backupName: importBackupName.value.trim(),
            savedAt: importBackupDate.value,
            playType: importPlayType.value,
            status: importStatus.value
        });

        if (result.canceled) {
            transferProgressArea.hidden = true;

            showImportDialogFeedback(
                "Import annulé avant le déplacement. La source n’a pas été déplacée."
            );

            return;
        }

        if (result.success) {
            sourceConsumed = true;
            preparedSource = null;

            transferProgress.value = 100;
            transferProgressLabel.textContent = "Import terminé.";

            showFeedback(
                "Sauvegarde déplacée et indexée avec succès.",
                true
            );

            window.dispatchEvent(new Event("mcvault:library-updated"));

            importDialog.close();

            return;
        }

        if (result.committed) {
            sourceConsumed = true;
            preparedSource = null;

            window.dispatchEvent(new Event("mcvault:library-updated"));
        }

        transferProgressLabel.textContent = "Contrôle nécessaire.";

        showImportDialogFeedback(
            result.message || "L’import n’a pas pu être terminé.",
            true,
            result.detail || ""
        );
    } catch (error) {
        console.error("Transfert de sauvegarde :", error);

        transferProgressLabel.textContent = "État de l’import à vérifier.";

        showImportDialogFeedback(
            "La communication a été interrompue. Vérifie le journal d’import " +
            "avant de relancer une opération.",
            true,
            error.stack || error.message
        );
    } finally {
        setTransferBusy(false);
    }
});

async function initializeApp() {
    importButton.disabled = true;

    try {
        if (!window.mcvault) {
            throw new Error("L’API MCVault n’est pas disponible.");
        }

        const info = await window.mcvault.getAppInfo();
        applyAppInfo(info);
    } catch (error) {
        console.error("Initialisation MCVault :", error);

        technicalVersion.textContent = "Indisponible";
        dataPath.textContent = "Impossible de lire les informations.";

        showFeedback(
            "Impossible de lire la configuration. Ferme puis relance MCVault.",
            true
        );
    }
}

// Le choix initial doit être terminé avant d'utiliser la bibliothèque.
// L'utilisateur peut toujours fermer normalement la fenêtre Windows.
storageDialog.addEventListener("cancel", (event) => {
    if (!storageConfigured) {
        event.preventDefault();

        showStorageFeedback(
            "Confirme un dossier pour continuer, ou ferme la fenêtre pour quitter."
        );
    }
});

chooseStorageButton.addEventListener("click", async () => {
    if (storagePending) {
        return;
    }

    setStorageBusy(true);

    try {
        const result = await window.mcvault.chooseStorageDirectory();

        if (result.canceled) {
            showStorageFeedback(
                "Sélection annulée. Le dossier affiché reste inchangé."
            );
            return;
        }

        if (!result.success) {
            showStorageFeedback(
                result.message || "Impossible de sélectionner ce dossier.",
                true
            );
            return;
        }

        selectedStoragePath.textContent = result.storageRoot;

        showStorageFeedback(
            "Dossier sélectionné. Clique sur « Confirmer ce dossier » pour l’enregistrer."
        );
    } catch (error) {
        console.error("Sélection du stockage :", error);

        showStorageFeedback(
            "Impossible d’ouvrir le sélecteur de dossiers.",
            true
        );
    } finally {
        setStorageBusy(false);
    }
});

confirmStorageButton.addEventListener("click", async () => {
    if (storagePending) {
        return;
    }

    setStorageBusy(true);

    showStorageFeedback(
        "Confirme le chemin dans la fenêtre Windows pour continuer."
    );

    try {
        const result = await window.mcvault.confirmStorageDirectory();

        if (result.canceled) {
            showStorageFeedback(
                "Confirmation annulée. Aucun nouveau choix n’a été enregistré."
            );
            return;
        }

        if (!result.success) {
            showStorageFeedback(
                result.message || "La configuration n’a pas pu être enregistrée.",
                true
            );
            return;
        }

        applyAppInfo(result.info);
    } catch (error) {
        console.error("Configuration du stockage :", error);

        showStorageFeedback(
            "Impossible de terminer la configuration. Tu peux réessayer.",
            true
        );
    } finally {
        setStorageBusy(false);
    }
});

importButton.addEventListener("click", () => {
    if (!storageConfigured || importDialog.open) {
        return;
    }

    importDialog.showModal();
});

const globalActivity = document.getElementById("global-activity");
const globalActivityText = document.getElementById(
    "global-activity-text"
);

window.mcvault.onAppState((state) => {
    const scanDuplicatesButton = document.getElementById(
        "scan-duplicates-button"
    );

    const analyzeOldBackupsButton = document.getElementById(
        "analyze-old-backups-button"
    );

    const saveModpackButton = document.getElementById(
        "save-modpack-button"
    );

    const chooseSettingsStorageButton = document.getElementById(
        "choose-settings-storage-button"
    );

    const applySettingsStorageButton = document.getElementById(
        "apply-settings-storage-button"
    );

    const saveSettingsButton = document.getElementById(
        "save-settings-button"
    );

    function setGlobalActionButtons(busy) {
        importButton.disabled = busy || !storageConfigured;

        scanDuplicatesButton.disabled = busy;
        analyzeOldBackupsButton.disabled = busy;
        saveModpackButton.disabled = busy;

        chooseSettingsStorageButton.disabled = busy;
        applySettingsStorageButton.disabled = busy;
        saveSettingsButton.disabled = busy;
    }

    window.mcvault.onAppState((state) => {
        const isBusy =
            state.importBusy ||
            state.libraryWriteBusy ||
            state.cleanupBusy ||
            state.storageBusy;

        setGlobalActionButtons(isBusy);

        if (!isBusy) {
            globalActivity.hidden = true;
            globalActivityText.textContent = "Opération en cours...";
            return;
        }

        let message = "Opération en cours...";

        if (state.importBusy) {
            message = "Import de sauvegarde en cours...";
        } else if (state.libraryWriteBusy) {
            message = "Enregistrement de la fiche en cours...";
        } else if (state.cleanupBusy) {
            message = "Analyse du nettoyage en cours...";
        } else if (state.storageBusy) {
            message = "Modification du stockage en cours...";
        }

        globalActivityText.textContent = message;
        globalActivity.hidden = false;
    });
});

toggleImportDebugButton.addEventListener("click", () => {
    importDebugDetails.hidden = !importDebugDetails.hidden;

    toggleImportDebugButton.textContent = importDebugDetails.hidden
        ? "Détails techniques"
        : "Masquer les détails";
});

copyImportDebugButton.addEventListener("click", async () => {
    const text = [
        "MCVault — diagnostic d’import :",
        `'${importDebugText}'`
    ]
        .filter(Boolean)
        .join("\n\n");

    try {
        await navigator.clipboard.writeText(text);

        copyImportDebugButton.textContent = "Copié";
    } catch (error) {
        copyImportDebugButton.textContent = "Copie impossible";
    } finally {
        setTimeout(() => {
            copyImportDebugButton.textContent = "Copier le diagnostic";
        }, 1800);
    }
});

initializeApp();