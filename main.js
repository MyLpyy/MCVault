"use strict";

const {
    app,
    BrowserWindow,
    ipcMain,
    dialog,
    shell
} = require("electron");

const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const {
    prepareImport,
    executeImport
} = require("./services/import-service");

const {
    showVaultConfirmation,
    showVaultMessageBox
} = require("./services/confirmation-dialog");

const {
    findPotentialDuplicates
} = require("./services/duplicate-service");

// Nom et emplacement explicites pour conserver un chemin stable.
app.setName("MCVault");

const appRoot = path.join(app.getPath("appData"), "MCVault");
app.setPath("userData", appRoot);

const dataPath = path.join(appRoot, "data");
const configPath = path.join(dataPath, "config.json");
const libraryPath = path.join(dataPath, "library.json");
const trashPath = path.join(appRoot, "corbeille");
const indexPath = path.join(__dirname, "src", "index.html");
const indexUrl = pathToFileURL(indexPath).href;

let mainWindow = null;
let config = null;
let pendingStorageRoot = null;
let storageBusy = false;
let selectedImportSource = null;
let importBusy = false;
let libraryWriteBusy = false;
let cleanupBusy = false;
const DEFAULT_SETTINGS = {
    cleanup: {
        keepRecent: 3,
        minimumAgeDays: 30
    }
};

function describeError(error) {
    switch (error.code) {
        case "EACCES":
        case "EPERM":
            return "Accès refusé. Choisis un dossier dans lequel tu peux écrire.";

        case "ENOSPC":
            return "Le disque ne dispose pas de suffisamment d’espace libre.";

        case "ENOENT":
            return "Le dossier ou le disque est introuvable ou indisponible.";

        case "ENOTDIR":
            return "Un élément du chemin est un fichier au lieu d’un dossier.";

        case "EBUSY":
            return "Le dossier ou le disque est actuellement utilisé.";

        default:
            return error.message || "Une erreur inattendue est survenue.";
    }
}

function validateSender(event) {
    if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame ||
        event.senderFrame.url !== indexUrl
    ) {
        throw new Error("Demande non autorisée.");
    }
}

function getAppInfo() {
    return {
        appName: app.getName(),
        appVersion: app.getVersion(),
        dataPath,
        configPath,
        defaultStorageRoot: appRoot,
        storageRoot: config.storageRoot,
        storageConfigured: config.storageConfigured === true
    };
}

function notifyAppState() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("app:state", {
            importBusy,
            libraryWriteBusy,
            cleanupBusy,
            storageBusy
        });
    }
}

function normalizeSettings(value) {
    const settings = value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};

    const cleanup = settings.cleanup && typeof settings.cleanup === "object"
        ? settings.cleanup
        : {};

    const keepRecent = Number(cleanup.keepRecent);
    const minimumAgeDays = Number(cleanup.minimumAgeDays);

    return {
        cleanup: {
            keepRecent: Number.isInteger(keepRecent) &&
                keepRecent >= 1 &&
                keepRecent <= 100
                ? keepRecent
                : DEFAULT_SETTINGS.cleanup.keepRecent,

            minimumAgeDays: Number.isInteger(minimumAgeDays) &&
                minimumAgeDays >= 0 &&
                minimumAgeDays <= 36500
                ? minimumAgeDays
                : DEFAULT_SETTINGS.cleanup.minimumAgeDays
        }
    };
}

// Écriture dans un fichier temporaire, puis remplacement de config.json.
// Si le remplacement échoue, l'ancien fichier n'est pas supprimé.
async function saveConfig(nextConfig) {
    const temporaryPath = path.join(
        dataPath,
        `.config-${randomUUID()}.tmp`
    );

    try {
        await fs.writeFile(
            temporaryPath,
            JSON.stringify(nextConfig, null, 2),
            {
                encoding: "utf8",
                flag: "wx"
            }
        );

        await fs.rename(temporaryPath, configPath);
    } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => { });
    }
}

async function initializeData() {
    await fs.mkdir(dataPath, { recursive: true });
    await fs.mkdir(trashPath, { recursive: true });

    try {
        const content = await fs.readFile(configPath, "utf8");
        config = JSON.parse(content);

        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new Error("Le fichier config.json ne contient pas un objet valide.");
        }

        // Compatibilité avec le config.json créé pendant l’étape 1.
        // Un ancien chemin n'est pas considéré comme un choix confirmé.
        if (config.storageConfigured !== true) {
            config.storageConfigured = false;
        } else if (
            typeof config.storageRoot !== "string" ||
            !path.isAbsolute(config.storageRoot)
        ) {
            throw new Error(
                "Le chemin de stockage enregistré dans config.json est invalide."
            );
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }

        config = {
            version: 1,
            storageConfigured: false,
            storageRoot: null,
            createdAt: new Date().toISOString()
        };

        await saveConfig(config);
    }
    config.settings = normalizeSettings(config.settings);

    // Ne remplace jamais une bibliothèque déjà présente.
    try {
        await fs.writeFile(
            libraryPath,
            JSON.stringify(
                {
                    version: 1,
                    modpacks: [],
                    backups: []
                },
                null,
                2
            ),
            {
                encoding: "utf8",
                flag: "wx"
            }
        );
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }
    }
}

async function verifyWritableDirectory(directory) {
    const stats = await fs.stat(directory);

    if (!stats.isDirectory()) {
        throw new Error("Le chemin choisi n’est pas un dossier.");
    }

    // Un vrai test d'écriture est plus utile qu'un simple contrôle
    // préalable des permissions.
    const probePath = path.join(
        directory,
        `.mcvault-write-test-${randomUUID()}.tmp`
    );

    let probeCreated = false;

    try {
        await fs.writeFile(probePath, "MCVault", {
            encoding: "utf8",
            flag: "wx"
        });

        probeCreated = true;
    } finally {
        if (probeCreated) {
            await fs.unlink(probePath);
        }
    }
}

async function initializeStorageDirectory(root) {
    await fs.mkdir(root, { recursive: true });
    await verifyWritableDirectory(root);

    for (const name of ["backups", "screenshots"]) {
        const directory = path.join(root, name);

        await fs.mkdir(directory, { recursive: true });
        await verifyWritableDirectory(directory);
    }
}

async function readLibrary() {
    const content = await fs.readFile(libraryPath, "utf8");
    const library = JSON.parse(content);

    if (
        !library ||
        !Array.isArray(library.modpacks) ||
        !Array.isArray(library.backups)
    ) {
        throw new Error("La structure de library.json est invalide.");
    }

    const modpackIds = new Set();
    const backupIds = new Set();

    for (const modpack of library.modpacks) {
        if (
            !modpack ||
            typeof modpack.id !== "string" ||
            typeof modpack.name !== "string" ||
            modpackIds.has(modpack.id)
        ) {
            throw new Error("Un modpack de library.json est invalide ou dupliqué.");
        }

        modpackIds.add(modpack.id);
    }

    for (const backup of library.backups) {
        if (
            !backup ||
            typeof backup.id !== "string" ||
            typeof backup.name !== "string" ||
            typeof backup.path !== "string" ||
            !modpackIds.has(backup.modpackId) ||
            backupIds.has(backup.id) ||
            !Number.isFinite(backup.sizeBytes) ||
            backup.sizeBytes < 0
        ) {
            throw new Error("Une sauvegarde de library.json est invalide.");
        }

        backupIds.add(backup.id);
    }

    return library;
}

function isStrictlyInside(parent, child) {
    const relative = path.relative(parent, child);

    return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function validateText(value, label, maxLength) {
    if (typeof value !== "string") {
        throw new Error(`${label} invalide.`);
    }

    const text = value.trim();

    if (text.length > maxLength) {
        throw new Error(
            `${label} trop long : ${maxLength} caractères maximum.`
        );
    }

    return text;
}

function validateModpackChanges(changes) {
    if (!changes || typeof changes !== "object") {
        throw new Error("Informations de modpack invalides.");
    }

    const statuses = new Set([
        "in_progress",
        "paused",
        "completed",
        "abandoned"
    ]);

    if (!statuses.has(changes.status)) {
        throw new Error("Statut invalide.");
    }

    const minecraftVersion = validateText(
        changes.minecraftVersion,
        "Version de Minecraft",
        50
    );

    const loader = validateText(changes.loader, "Loader", 50);
    const notes = validateText(changes.notes, "Notes", 20000);

    if (!Array.isArray(changes.tags) || changes.tags.length > 30) {
        throw new Error("30 tags maximum sont autorisés.");
    }

    const tags = [];
    const seenTags = new Set();

    for (const value of changes.tags) {
        const tag = validateText(value, "Tag", 40);

        if (!tag) continue;

        const key = tag.toLocaleLowerCase("fr-FR");

        if (!seenTags.has(key)) {
            tags.push(tag);
            seenTags.add(key);
        }
    }

    if (!Array.isArray(changes.links) || changes.links.length > 20) {
        throw new Error("20 liens maximum sont autorisés.");
    }

    const links = [];

    for (const value of changes.links) {
        const link = validateText(value, "Lien", 2000);

        if (!link) continue;

        let parsed;

        try {
            parsed = new URL(link);
        } catch {
            throw new Error(`Lien invalide : ${link}`);
        }

        if (
            !["https:", "http:"].includes(parsed.protocol) ||
            parsed.username ||
            parsed.password
        ) {
            throw new Error(
                "Les liens doivent être des adresses HTTP ou HTTPS sans identifiants."
            );
        }

        if (!links.includes(link)) links.push(link);
    }

    return {
        status: changes.status,
        minecraftVersion,
        loader,
        tags,
        notes,
        links
    };
}

async function saveLibraryFile(library) {
    const { randomUUID } = require("node:crypto");

    const temporaryPath = path.join(
        dataPath,
        `.library-${randomUUID()}.tmp`
    );

    try {
        await fs.writeFile(
            temporaryPath,
            JSON.stringify(library, null, 2),
            {
                encoding: "utf8",
                flag: "wx"
            }
        );

        await fs.rename(temporaryPath, libraryPath);
    } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => { });
    }
}

async function movePathToTrash(sourcePath, trashItemPath) {
    try {
        await fs.rename(sourcePath, trashItemPath);
        return;
    } catch (error) {
        if (error.code !== "EXDEV") {
            throw error;
        }
    }

    // Source et corbeille sur des disques différents :
    // copie, vérification, puis suppression de la source.
    await fs.cp(sourcePath, trashItemPath, {
        recursive: true,
        force: false,
        errorOnExist: true
    });

    const sourceStats = await fs.stat(sourcePath);
    const trashStats = await fs.stat(trashItemPath);

    const isDirectory =
        sourceStats.isDirectory() && trashStats.isDirectory();

    const isFile =
        sourceStats.isFile() && trashStats.isFile();

    if (!isDirectory && !isFile) {
        throw new Error(
            "La vérification du déplacement vers la corbeille a échoué."
        );
    }

    await fs.rm(sourcePath, {
        recursive: true,
        force: false
    });
}

function registerHandlers() {

    ipcMain.handle(
        "backup:update",
        async (event, backupId, changes, expectedUpdatedAt) => {
            validateSender(event);

            if (
                typeof backupId !== "string" ||
                !backupId ||
                !changes ||
                typeof changes !== "object" ||
                Array.isArray(changes)
            ) {
                return {
                    success: false,
                    message: "Informations de sauvegarde invalides."
                };
            }

            if (
                importBusy ||
                libraryWriteBusy ||
                cleanupBusy ||
                storageBusy
            ) {
                return {
                    success: false,
                    message:
                        "Une opération est déjà en cours. " +
                        "Attends sa fin avant d’enregistrer la fiche."
                };
            }

            libraryWriteBusy = true;
            notifyAppState();

            try {
                const statuses = new Set([
                    "in_progress",
                    "paused",
                    "completed",
                    "abandoned"
                ]);

                if (!statuses.has(changes.status)) {
                    throw new Error("Statut de sauvegarde invalide.");
                }

                if (!["solo", "server"].includes(changes.type)) {
                    throw new Error(
                        "Choisis un type de partie valide pour cette sauvegarde."
                    );
                }

                const notes = validateText(
                    changes.notes,
                    "Notes de la sauvegarde",
                    20000
                );

                if (
                    !Array.isArray(changes.tags) ||
                    changes.tags.length > 30
                ) {
                    throw new Error("30 tags maximum sont autorisés.");
                }

                const tags = [];
                const seenTags = new Set();

                for (const value of changes.tags) {
                    const tag = validateText(value, "Tag", 40);

                    if (!tag) continue;

                    const key = tag.toLocaleLowerCase("fr-FR");

                    if (!seenTags.has(key)) {
                        tags.push(tag);
                        seenTags.add(key);
                    }
                }

                try {
                    await fs.access(
                        path.join(dataPath, "import-journal.json")
                    );

                    return {
                        success: false,
                        message:
                            "Un import nécessite un contrôle. " +
                            "Résous son journal avant de modifier la fiche."
                    };
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }

                const library = await readLibrary();

                const backup = library.backups.find(
                    (item) => item.id === backupId
                );

                if (!backup) {
                    throw new Error(
                        "Cette sauvegarde n’est plus dans la bibliothèque."
                    );
                }

                if (
                    (backup.updatedAt ?? null) !== expectedUpdatedAt
                ) {
                    return {
                        success: false,
                        conflict: true,
                        message:
                            "Cette sauvegarde a changé depuis l’ouverture " +
                            "de sa fiche. Ferme-la puis rouvre-la."
                    };
                }

                Object.assign(backup, {
                    status: changes.status,
                    type: changes.type,
                    notes,
                    tags,
                    updatedAt: new Date().toISOString()
                });

                await saveLibraryFile(library);

                return {
                    success: true,
                    backup
                };
            } catch (error) {
                return {
                    success: false,
                    message: describeError(error)
                };
            } finally {
                libraryWriteBusy = false;
                notifyAppState();
            }
        }
    );

    ipcMain.handle("app:get-info", (event) => {
        validateSender(event);
        return getAppInfo();
    });

    ipcMain.handle("ui:confirm-discard", async (event, kind) => {
        validateSender(event);

        const descriptions = {
            backup: "la fiche sauvegarde",
            modpack: "la fiche du modpack"
        };

        if (!Object.hasOwn(descriptions, kind)) {
            return { confirmed: false };
        }

        const result = await showVaultConfirmation(
            mainWindow,
            {
                title: "Modifications non enregistrées",
                message: "Abandonner les modifications ?",
                detail:
                    `Les modifications de ${descriptions[kind]} ` +
                    "n’ont pas été enregistrées.\n\n" +
                    "Si tu continues, elles seront perdues.",
                confirmLabel: "Abandonner",
                cancelLabel: "Revenir à la fiche",
                tone: "danger",
                height: 360
            }
        );

        return {
            confirmed: result.response === 0
        };
    });

    ipcMain.handle("storage:choose", async (event) => {
        validateSender(event);

        if (config.storageConfigured) {
            return {
                success: false,
                message: "Le stockage est déjà configuré."
            };
        }

        if (storageBusy) {
            return {
                success: false,
                message: "Une opération de configuration est déjà en cours."
            };
        }

        storageBusy = true;

        try {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: "Choisir le dossier de stockage MCVault",
                buttonLabel: "Choisir ce dossier",
                defaultPath: pendingStorageRoot || appRoot,
                properties: ["openDirectory"]
            });

            if (result.canceled || !result.filePaths[0]) {
                return {
                    success: false,
                    canceled: true
                };
            }

            const selectedPath = path.resolve(result.filePaths[0]);

            // Pas d'écriture ni de création à cette étape.
            const stats = await fs.stat(selectedPath);

            if (!stats.isDirectory()) {
                throw new Error("Le chemin sélectionné n’est pas un dossier.");
            }

            pendingStorageRoot = selectedPath;

            return {
                success: true,
                storageRoot: selectedPath
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        } finally {
            storageBusy = false;
        }
    });

    ipcMain.handle("storage:confirm", async (event) => {
        validateSender(event);

        if (config.storageConfigured) {
            return {
                success: false,
                message: "Le stockage est déjà configuré."
            };
        }

        if (storageBusy) {
            return {
                success: false,
                message: "Une opération de configuration est déjà en cours."
            };
        }

        storageBusy = true;

        // Le chemin vient du sélecteur du processus principal,
        // jamais d'un chemin arbitraire fourni par la page.
        const chosenRoot = pendingStorageRoot || appRoot;

        try {
            const confirmation = await showVaultMessageBox(mainWindow, {
                type: "question",
                title: "Confirmer le dossier de stockage",
                message: "Utiliser ce dossier pour les futures sauvegardes ?",
                detail:
                    `${chosenRoot}\n\n` +
                    "MCVault créera les sous-dossiers backups et screenshots " +
                    "et vérifiera qu’il peut y écrire.\n\n" +
                    "Aucune sauvegarde existante ne sera déplacée.",
                buttons: ["Confirmer", "Annuler"],
                defaultId: 0,
                cancelId: 1,
                noLink: true
            });

            if (confirmation.response !== 0) {
                return {
                    success: false,
                    canceled: true
                };
            }

            await initializeStorageDirectory(chosenRoot);

            const nextConfig = {
                ...config,
                version: 1,
                storageConfigured: true,
                storageRoot: chosenRoot,
                updatedAt: new Date().toISOString()
            };

            await saveConfig(nextConfig);

            // Mise à jour en mémoire uniquement après enregistrement réussi.
            config = nextConfig;
            pendingStorageRoot = null;

            return {
                success: true,
                info: getAppInfo()
            };
        } catch (error) {
            return {
                success: false,
                message:
                    `${describeError(error)} ` +
                    "La configuration n’a pas été validée. " +
                    "Des dossiers vides peuvent avoir été créés ; " +
                    "aucune sauvegarde n’a été déplacée."
            };
        } finally {
            storageBusy = false;
        }
    });

    ipcMain.handle("import:open-picker", async (event, sourceType) => {
        validateSender(event);

        if (importBusy) {
            return {
                success: false,
                message: "Un import est déjà en cours."
            };
        }

        if (!config.storageConfigured) {
            return {
                success: false,
                message: "Choisis d’abord le dossier de stockage."
            };
        }

        if (!["directory", "zip"].includes(sourceType)) {
            return {
                success: false,
                message: "Type de source invalide."
            };
        }

        try {
            const options = {
                title: sourceType === "directory"
                    ? "Choisir un dossier de sauvegarde"
                    : "Choisir une archive ZIP",
                buttonLabel: "Sélectionner",
                properties: sourceType === "directory"
                    ? ["openDirectory"]
                    : ["openFile"]
            };

            if (sourceType === "zip") {
                options.filters = [
                    {
                        name: "Archives ZIP",
                        extensions: ["zip"]
                    }
                ];
            }

            const result = await dialog.showOpenDialog(mainWindow, options);

            if (result.canceled || !result.filePaths[0]) {
                return {
                    success: false,
                    canceled: true
                };
            }

            const selectedPath = path.resolve(result.filePaths[0]);
            const stats = await fs.lstat(selectedPath);

            if (stats.isSymbolicLink()) {
                return {
                    success: false,
                    message: "Sélectionne la source réelle, pas un lien symbolique."
                };
            }

            if (sourceType === "directory" && !stats.isDirectory()) {
                return {
                    success: false,
                    message: "La source sélectionnée n’est pas un dossier."
                };
            }

            if (
                sourceType === "zip" &&
                (!stats.isFile() || path.extname(selectedPath).toLowerCase() !== ".zip")
            ) {
                return {
                    success: false,
                    message: "La source doit être un fichier portant l’extension .zip."
                };
            }

            const storagePath = path.resolve(config.storageRoot);

            // Évite de sélectionner la bibliothèque ou l'un de ses
            // dossiers comme source d'un nouvel import.
            const relativeToStorage = path.relative(storagePath, selectedPath);

            const isInsideStorage =
                relativeToStorage === "" ||
                (
                    !relativeToStorage.startsWith(`..${path.sep}`) &&
                    relativeToStorage !== ".." &&
                    !path.isAbsolute(relativeToStorage)
                );

            if (isInsideStorage) {
                return {
                    success: false,
                    message:
                        "Cette source est déjà dans le dossier de stockage MCVault. " +
                        "Choisis une sauvegarde située en dehors de la bibliothèque."
                };
            }

            // Refuse aussi un dossier source qui contiendrait la bibliothèque.
            if (sourceType === "directory") {
                const relativeToSource = path.relative(selectedPath, storagePath);

                const containsStorage =
                    relativeToSource === "" ||
                    (
                        !relativeToSource.startsWith(`..${path.sep}`) &&
                        relativeToSource !== ".." &&
                        !path.isAbsolute(relativeToSource)
                    );

                if (containsStorage) {
                    return {
                        success: false,
                        message:
                            "La source contient le dossier de stockage MCVault. " +
                            "Choisis uniquement le dossier de la sauvegarde."
                    };
                }
            }

            const sourceName = path.basename(selectedPath);

            selectedImportSource = {
                path: selectedPath,
                type: sourceType
            };

            return {
                success: true,
                source: {
                    path: selectedPath,
                    name: sourceName,
                    suggestedName: sourceType === "zip"
                        ? path.basename(selectedPath, path.extname(selectedPath))
                        : sourceName,
                    type: sourceType,
                    sizeBytes: sourceType === "zip" ? stats.size : null
                },
                storageRoot: storagePath
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        }
    });

    ipcMain.handle("import:execute", async (event, metadata) => {
        validateSender(event);

        if (importBusy || libraryWriteBusy || cleanupBusy) {
            return {
                success: false,
                message:
                    "Une opération modifie déjà la bibliothèque. Réessaie dans un instant."
            };
        }

        if (!config.storageConfigured || !selectedImportSource) {
            return {
                success: false,
                message: "Sélectionne une source avant de lancer l’import."
            };
        }

        if (!metadata || typeof metadata !== "object") {
            return {
                success: false,
                message: "Informations d’import invalides."
            };
        }

        importBusy = true;
        notifyAppState();

        const notify = (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("import:progress", progress);
            }
        };

        try {
            notify({
                message: "Analyse de la source...",
                percent: null
            });

            const plan = await prepareImport({
                source: selectedImportSource,
                storageRoot: config.storageRoot,
                dataPath,
                metadata
            });

            const confirmation = await showVaultMessageBox(mainWindow, {
                type: "warning",
                title: "Confirmer le déplacement",
                message: "Déplacer cette sauvegarde dans MCVault ?",
                detail:
                    `Source :\n${plan.sourcePath}\n\n` +
                    `Destination :\n${plan.finalPayload}\n\n` +
                    "La source disparaîtra de son emplacement actuel une fois " +
                    "le déplacement terminé.\n\n" +
                    "Entre disques, la suppression de la source interviendra " +
                    "seulement après la copie, sa vérification et l’indexation.\n\n" +
                    "Ferme Minecraft, le launcher et les programmes utilisant la source.",
                buttons: ["Déplacer la sauvegarde", "Annuler"],
                defaultId: 1,
                cancelId: 1,
                noLink: true
            });

            if (confirmation.response !== 0) {
                return {
                    success: false,
                    canceled: true
                };
            }

            const result = await executeImport(plan, notify);

            if (result.success || result.committed) {
                selectedImportSource = null;
            }

            return result;
        } catch (error) {
            return {
                success: false,
                message: error.friendlyMessage || describeError(error),
                detail: error.detail || error.message,
                journalPath: error.journalPath || null
            };
        } finally {
            importBusy = false;
            notifyAppState();
        }
    });

    ipcMain.handle("library:get", async (event) => {
        validateSender(event);

        try {
            const library = await readLibrary();

            let importNeedsReview = false;

            try {
                await fs.access(path.join(dataPath, "import-journal.json"));
                importNeedsReview = true;
            } catch (error) {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            }

            return {
                success: true,
                library,
                importNeedsReview
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        }
    });

    ipcMain.handle("library:show-backup", async (event, backupId) => {
        validateSender(event);

        if (typeof backupId !== "string" || !backupId) {
            return {
                success: false,
                message: "Identifiant de sauvegarde invalide."
            };
        }

        if (!config.storageConfigured) {
            return {
                success: false,
                message: "Le stockage n’est pas configuré."
            };
        }

        try {
            const library = await readLibrary();
            const backup = library.backups.find((item) => item.id === backupId);

            if (!backup) {
                throw new Error("La sauvegarde n’est plus présente dans l’index.");
            }

            const target = await fs.realpath(backup.path);

            const storageRoots = Array.isArray(config.storageRoots)
                ? config.storageRoots.filter(
                    (root) => typeof root === "string" && root
                )
                : [];

            const authorizedRoots = [
                config.storageRoot,
                ...storageRoots
            ].filter((root) => typeof root === "string" && root);

            let isAuthorized = false;

            for (const root of authorizedRoots) {
                const backupRoot = await fs.realpath(
                    path.join(root, "backups")
                );

                if (isStrictlyInside(backupRoot, target)) {
                    isAuthorized = true;
                    break;
                }
            }

            if (!isAuthorized) {
                throw new Error(
                    "Le chemin de cette sauvegarde n’appartient à aucun dossier de stockage connu."
                );
            }

            const stats = await fs.stat(target);

            if (!stats.isDirectory() && !stats.isFile()) {
                throw new Error("L’emplacement n’est pas un fichier ou un dossier.");
            }

            shell.showItemInFolder(target);

            return { success: true };
        } catch (error) {
            return {
                success: false,
                message:
                    "Impossible d’afficher cette sauvegarde. " +
                    describeError(error)
            };
        }
    });

    ipcMain.handle(
        "modpack:update",
        async (event, modpackId, changes, expectedUpdatedAt) => {
            validateSender(event);

            if (typeof modpackId !== "string" || !modpackId) {
                return {
                    success: false,
                    message: "Identifiant de modpack invalide."
                };
            }

            if (importBusy || libraryWriteBusy || cleanupBusy) {
                return {
                    success: false,
                    message:
                        "Une opération modifie déjà la bibliothèque. Réessaie après sa fin."
                };
            }

            libraryWriteBusy = true;
            notifyAppState();

            try {
                const validated = validateModpackChanges(changes);

                // En cas d'import non résolu, on évite de modifier l'index.
                try {
                    await fs.access(path.join(dataPath, "import-journal.json"));

                    return {
                        success: false,
                        message:
                            "Un import nécessite un contrôle. Résous son journal " +
                            "avant de modifier la bibliothèque."
                    };
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }

                const library = await readLibrary();

                const modpack = library.modpacks.find(
                    (item) => item.id === modpackId
                );

                if (!modpack) {
                    throw new Error("Ce modpack n’est plus présent dans la bibliothèque.");
                }

                if ((modpack.updatedAt ?? null) !== expectedUpdatedAt) {
                    return {
                        success: false,
                        conflict: true,
                        message:
                            "Cette fiche a changé depuis son ouverture. " +
                            "Ferme-la puis rouvre-la avant de réessayer."
                    };
                }

                Object.assign(modpack, validated, {
                    updatedAt: new Date().toISOString()
                });

                await saveLibraryFile(library);

                return {
                    success: true,
                    modpack
                };
            } catch (error) {
                return {
                    success: false,
                    message: describeError(error)
                };
            } finally {
                libraryWriteBusy = false;
                notifyAppState();
            }
        }
    );

    ipcMain.handle("cleanup:scan-duplicates", async (event) => {
        validateSender(event);

        if (!config.storageConfigured) {
            return {
                success: false,
                message: "Le stockage n’est pas configuré."
            };
        }

        if (importBusy || libraryWriteBusy || cleanupBusy) {
            return {
                success: false,
                message:
                    "Une opération est déjà en cours. Attends sa fin avant l’analyse."
            };
        }

        cleanupBusy = true;
        notifyAppState();

        try {
            try {
                await fs.access(path.join(dataPath, "import-journal.json"));

                return {
                    success: false,
                    message:
                        "Un import nécessite un contrôle. Résous son journal " +
                        "avant de lancer une analyse."
                };
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }

            const library = await readLibrary();

            const result = await findPotentialDuplicates(
                library,
                config.storageRoot
            );

            return {
                success: true,
                result
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        } finally {
            cleanupBusy = false;
            notifyAppState();
        }
    });

    ipcMain.handle("settings:get", (event) => {
        validateSender(event);

        return {
            success: true,
            settings: normalizeSettings(config.settings),
            info: getAppInfo()
        };
    });

    ipcMain.handle("settings:update-cleanup", async (event, settings) => {
        validateSender(event);

        if (importBusy || libraryWriteBusy || cleanupBusy || storageBusy) {
            return {
                success: false,
                message:
                    "Une opération est déjà en cours. Attends sa fin avant de modifier les paramètres."
            };
        }

        try {
            await fs.access(path.join(dataPath, "import-journal.json"));

            return {
                success: false,
                message:
                    "Un import nécessite un contrôle. Résous son journal avant de modifier les paramètres."
            };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }

        const normalized = normalizeSettings(settings);

        config.settings = normalized;
        await saveConfig(config);
        notifyAppState();

        return {
            success: true,
            settings: normalized,
            info: getAppInfo()
        };
    });

    ipcMain.handle("settings:choose-storage", async (event) => {
        validateSender(event);

        if (!config.storageConfigured) {
            return {
                success: false,
                message: "Le stockage initial n’est pas encore configuré."
            };
        }

        if (
            storageBusy ||
            importBusy ||
            libraryWriteBusy ||
            cleanupBusy
        ) {
            return {
                success: false,
                message:
                    "Une opération est déjà en cours. Attends sa fin avant de changer le stockage."
            };
        }

        storageBusy = true;

        try {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: "Choisir un nouveau dossier de stockage",
                defaultPath: config.storageRoot,
                properties: [
                    "openDirectory",
                    "createDirectory",
                    "dontAddToRecent"
                ]
            });

            if (result.canceled || !result.filePaths?.length) {
                return { canceled: true };
            }

            const selectedPath = result.filePaths[0];
            const stats = await fs.stat(selectedPath);

            if (!stats.isDirectory()) {
                throw new Error("Le chemin sélectionné n’est pas un dossier.");
            }

            pendingStorageRoot = selectedPath;

            return {
                success: true,
                storageRoot: selectedPath
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        } finally {
            storageBusy = false;
        }
    });

    ipcMain.handle("settings:apply-storage", async (event) => {
        validateSender(event);

        if (!config.storageConfigured) {
            return {
                success: false,
                message: "Le stockage initial n’est pas encore configuré."
            };
        }

        if (
            storageBusy ||
            importBusy ||
            libraryWriteBusy ||
            cleanupBusy
        ) {
            return {
                success: false,
                message:
                    "Une opération est déjà en cours. Attends sa fin avant de changer le stockage."
            };
        }

        if (!pendingStorageRoot) {
            return {
                success: false,
                message: "Choisis d’abord un nouveau dossier de stockage."
            };
        }

        storageBusy = true;
        notifyAppState();

        try {
            const currentRoot = await fs.realpath(config.storageRoot);
            const nextRoot = await fs.realpath(pendingStorageRoot);

            if (currentRoot === nextRoot) {
                pendingStorageRoot = null;

                return {
                    success: false,
                    message: "Ce dossier est déjà le dossier de stockage actuel."
                };
            }

            const relativeCurrentToNext = path.relative(currentRoot, nextRoot);
            const relativeNextToCurrent = path.relative(nextRoot, currentRoot);

            const isInside = (value) =>
                value !== "" &&
                value !== ".." &&
                !value.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(value);

            if (isInside(relativeCurrentToNext) || isInside(relativeNextToCurrent)) {
                throw new Error(
                    "Le nouveau dossier ne doit pas être contenu dans l’ancien, ni contenir l’ancien."
                );
            }

            const storageConfirmation = await showVaultConfirmation(
                mainWindow,
                {
                    title: "Dossier de stockage",
                    message: "Utiliser ce nouveau dossier ?",
                    detail:
                        `Dossier actuel :\n${currentRoot}\n\n` +
                        `Nouveau dossier :\n${nextRoot}\n\n` +
                        "Seuls les futurs imports utiliseront ce dossier. " +
                        "Les sauvegardes déjà indexées ne seront pas déplacées " +
                        "et resteront accessibles.",
                    confirmLabel: "Utiliser ce dossier",
                    cancelLabel: "Annuler",
                    tone: "neutral",
                    height: 480
                }
            );

            if (storageConfirmation.response !== 0) {
                return {
                    success: false,
                    canceled: true
                };
            }

            await fs.mkdir(path.join(nextRoot, "backups"), { recursive: true });
            await fs.mkdir(path.join(nextRoot, "screenshots"), { recursive: true });

            const previousRoots = Array.isArray(config.storageRoots)
                ? config.storageRoots.filter(
                    (root) => typeof root === "string" && root
                )
                : [];

            if (!previousRoots.includes(currentRoot)) {
                previousRoots.push(currentRoot);
            }

            config.storageRoot = nextRoot;
            config.storageRoots = previousRoots;
            config.storageConfigured = true;

            await saveConfig(config);

            pendingStorageRoot = null;

            return {
                success: true,
                info: getAppInfo()
            };
        } catch (error) {
            pendingStorageRoot = null;

            return {
                success: false,
                message:
                    `${describeError(error)} Aucune sauvegarde existante n’a été déplacée.`
            };
        } finally {
            storageBusy = false;
            notifyAppState();
        }
    });

    ipcMain.handle("backup:move-to-trash", async (event, backupId) => {
        validateSender(event);

        if (typeof backupId !== "string" || !backupId) {
            return {
                success: false,
                message: "Identifiant de sauvegarde invalide."
            };
        }

        if (importBusy || libraryWriteBusy || cleanupBusy || storageBusy) {
            return {
                success: false,
                message:
                    "Une opération est déjà en cours. Attends sa fin avant de mettre une sauvegarde à la corbeille."
            };
        }

        libraryWriteBusy = true;

        try {
            const confirmation = await showVaultConfirmation(
                mainWindow,
                {
                    title: "Corbeille MCVault",
                    message: "Retirer cette sauvegarde ?",
                    detail:
                        "Elle sera déplacée dans la corbeille MCVault, retirée " +
                        "de la bibliothèque, de la fiche du modpack et de l’historique.\n\n" +
                        "Elle ne sera pas supprimée définitivement.",
                    confirmLabel: "Mettre à la corbeille",
                    cancelLabel: "Annuler"
                }
            );

            if (confirmation.response !== 0) {
                return {
                    success: false,
                    canceled: true
                };
            }

            const library = await readLibrary();

            const backup = library.backups.find(
                (item) => item.id === backupId
            );

            if (!backup) {
                throw new Error(
                    "Cette sauvegarde n’est plus présente dans la bibliothèque."
                );
            }

            const modpack = library.modpacks.find(
                (item) => item.id === backup.modpackId
            );

            const sourcePath = backup.containerPath || backup.path;
            const target = await fs.realpath(sourcePath);

            const authorizedRoots = [
                config.storageRoot,
                ...(Array.isArray(config.storageRoots)
                    ? config.storageRoots
                    : [])
            ].filter((root) => typeof root === "string" && root);

            let isAuthorized = false;

            for (const root of authorizedRoots) {
                const backupRoot = await fs.realpath(
                    path.join(root, "backups")
                );

                if (isStrictlyInside(backupRoot, target)) {
                    isAuthorized = true;
                    break;
                }
            }

            if (!isAuthorized) {
                throw new Error(
                    "Cette sauvegarde n’appartient à aucun dossier de stockage connu."
                );
            }

            const trashItemPath = path.join(trashPath, backup.id);

            if (await fs.access(trashItemPath).then(() => true).catch(() => false)) {
                throw new Error(
                    "Un élément portant le même identifiant est déjà présent dans la corbeille."
                );
            }

            const metadata = {
                backupId: backup.id,
                backupName: backup.name,
                modpackName: modpack ? modpack.name : "Modpack inconnu",
                format: backup.format,
                sizeBytes: backup.sizeBytes,
                originalPath: target,
                deletedAt: new Date().toISOString()
            };

            await fs.mkdir(trashItemPath, { recursive: true });

            const metadataPath = path.join(
                trashItemPath,
                "mcvault-trash.json"
            );

            await fs.writeFile(
                metadataPath,
                JSON.stringify(metadata, null, 2),
                {
                    encoding: "utf8",
                    flag: "wx"
                }
            );

            const movedPath = path.join(
                trashItemPath,
                path.basename(target)
            );

            await movePathToTrash(target, movedPath);

            library.backups = library.backups.filter(
                (item) => item.id !== backupId
            );

            await saveLibraryFile(library);

            return {
                success: true,
                message: "Sauvegarde déplacée dans la corbeille MCVault."
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        } finally {
            libraryWriteBusy = false;
            notifyAppState();
        }
    });

    ipcMain.handle("trash:list", async (event) => {
        validateSender(event);

        try {
            await fs.mkdir(trashPath, { recursive: true });

            const entries = await fs.readdir(trashPath, {
                withFileTypes: true
            });

            const items = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;

                const itemPath = path.join(trashPath, entry.name);
                const metadataPath = path.join(
                    itemPath,
                    "mcvault-trash.json"
                );

                let metadata = null;

                try {
                    metadata = JSON.parse(
                        await fs.readFile(metadataPath, "utf8")
                    );
                } catch {
                    metadata = null;
                }

                items.push({
                    id: entry.name,
                    path: itemPath,
                    name: metadata?.backupName || entry.name,
                    modpackName: metadata?.modpackName || "Inconnu",
                    deletedAt: metadata?.deletedAt || null,
                    sizeBytes: metadata?.sizeBytes || 0
                });
            }

            items.sort((a, b) => {
                const timeA = Date.parse(a.deletedAt || "") || 0;
                const timeB = Date.parse(b.deletedAt || "") || 0;

                return timeB - timeA;
            });

            return {
                success: true,
                items
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        }
    });

    ipcMain.handle("trash:empty", async (event) => {
        validateSender(event);

        if (importBusy || libraryWriteBusy || cleanupBusy || storageBusy) {
            return {
                success: false,
                message:
                    "Une opération est déjà en cours. Attends sa fin avant de vider la corbeille."
            };
        }

        try {
            const entries = await fs.readdir(trashPath, {
                withFileTypes: true
            });

            const items = entries.filter((entry) => entry.isDirectory());

            if (!items.length) {
                return {
                    success: true,
                    deletedCount: 0,
                    message: "La corbeille est déjà vide."
                };
            }

            const confirmation = await showVaultMessageBox(mainWindow, {
                type: "warning",
                title: "Vider la corbeille MCVault",
                message: "Supprimer définitivement toutes les sauvegardes de la corbeille ?",
                detail:
                    `${items.length} élément(s) seront supprimés définitivement.\n\n` +
                    "Cette action est irréversible.",
                buttons: ["Supprimer définitivement", "Annuler"],
                defaultId: 1,
                cancelId: 1,
                noLink: true
            });

            if (confirmation.response !== 0) {
                return {
                    success: false,
                    canceled: true
                };
            }

            for (const entry of items) {
                await fs.rm(path.join(trashPath, entry.name), {
                    recursive: true,
                    force: false
                });
            }

            return {
                success: true,
                deletedCount: items.length,
                message: "Corbeille vidée."
            };
        } catch (error) {
            return {
                success: false,
                message: describeError(error)
            };
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        minWidth: 1000,
        minHeight: 650,
        backgroundColor: "#0b1120",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({
        action: "deny"
    }));

    mainWindow.webContents.on("will-navigate", (event) => {
        event.preventDefault();
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.on("close", (event) => {
        if (!importBusy) {
            return;
        }

        event.preventDefault();

        dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "Import en cours",
            message: "Attends la fin de l’import avant de fermer MCVault.",
            buttons: ["Compris"]
        });
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    mainWindow.loadFile(indexPath);
}

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) {
            return;
        }

        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }

        mainWindow.focus();
    });

    app.whenReady()
        .then(async () => {
            await initializeData();
            registerHandlers();
            createWindow();
        })
        .catch((error) => {
            console.error(error);

            dialog.showErrorBox(
                "MCVault — Initialisation impossible",
                `${describeError(error)}\n\n` +
                "Les fichiers de configuration existants n’ont pas été " +
                "réinitialisés automatiquement."
            );

            app.quit();
        });

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0 && config) {
            createWindow();
        }
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            app.quit();
        }
    });
}