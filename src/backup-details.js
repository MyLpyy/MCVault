"use strict";

(() => {
    const $ = (id) => document.getElementById(id);

    const dialog = $("backup-dialog");
    const form = $("backup-detail-form");
    const fieldset = $("backup-detail-fields");
    const closeButton = $("close-backup-button");
    const saveButton = $("save-backup-detail-button");
    const feedback = $("backup-detail-feedback");

    const statusInput = $("backup-detail-status");
    const typeInput = $("backup-detail-type");
    const tagsInput = $("backup-detail-tags");
    const notesInput = $("backup-detail-notes");

    let currentBackup = null;
    let initialState = "";
    let busy = false;

    function message(text, isError = false) {
        feedback.textContent = text;
        feedback.classList.toggle("is-error", isError);
    }

    function setBusy(value) {
        busy = value;
        fieldset.disabled = value || !currentBackup;
        closeButton.disabled = value;

        saveButton.textContent = value
            ? "Opération en cours..."
            : "Enregistrer la fiche sauvegarde";
    }

    function currentChanges() {
        return {
            status: statusInput.value,
            type: typeInput.value,
            tags: tagsInput.value
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            notes: notesInput.value.trim()
        };
    }

    function isDirty() {
        return currentBackup !== null &&
            JSON.stringify(currentChanges()) !== initialState;
    }

    let discardPending = false;

    async function allowDiscard() {
        if (discardPending) return false;
        if (!isDirty()) return true;

        discardPending = true;

        try {
            const result = await window.mcvault.confirmDiscard("backup");
            return result.confirmed === true;
        } catch (error) {
            message(
                "Impossible d’afficher la confirmation. " +
                "Tes modifications sont conservées.",
                true
            );

            return false;
        } finally {
            discardPending = false;
        }
    }

    function formatDate(value) {
        const time = Date.parse(value);

        return Number.isFinite(time)
            ? new Date(time).toLocaleString("fr-FR", {
                dateStyle: "medium",
                timeStyle: "short"
            })
            : "Date inconnue";
    }

    function formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 0) {
            return "Taille inconnue";
        }

        if (bytes === 0) return "0 octet";

        const units = ["octets", "Kio", "Mio", "Gio", "Tio"];
        const unit = Math.min(
            Math.floor(Math.log(bytes) / Math.log(1024)),
            units.length - 1
        );

        return `${(bytes / (1024 ** unit)).toLocaleString("fr-FR", {
            maximumFractionDigits: unit === 0 ? 0 : 2
        })} ${units[unit]}`;
    }

    function fillEditableFields() {
        statusInput.value = currentBackup.status || "in_progress";

        typeInput.value = ["solo", "server"].includes(currentBackup.type)
            ? currentBackup.type
            : "";

        tagsInput.value = Array.isArray(currentBackup.tags)
            ? currentBackup.tags.join(", ")
            : "";

        notesInput.value = currentBackup.notes || "";
        initialState = JSON.stringify(currentChanges());
    }

    async function openBackup(backupId) {
        if (
            busy ||
            typeof backupId !== "string" ||
            !backupId
        ) return;

        if (dialog.open && !(await allowDiscard())) return;

        currentBackup = null;
        initialState = "";

        $("backup-dialog-title").textContent = "Chargement...";
        $("backup-parent-name").textContent = "";
        form.reset();

        for (const id of [
            "backup-detail-saved-at",
            "backup-detail-imported-at",
            "backup-detail-format",
            "backup-detail-size",
            "backup-detail-path"
        ]) {
            $(id).textContent = "";
        }

        if (!dialog.open) dialog.showModal();

        setBusy(true);
        message("Chargement de la sauvegarde...");

        try {
            const result = await window.mcvault.getLibrary();

            if (!result.success) {
                throw new Error(result.message);
            }

            currentBackup = result.library.backups.find(
                (backup) => backup.id === backupId
            ) || null;

            if (!currentBackup) {
                throw new Error(
                    "Cette sauvegarde n’est plus dans la bibliothèque."
                );
            }

            const modpack = result.library.modpacks.find(
                (item) => item.id === currentBackup.modpackId
            );

            $("backup-dialog-title").textContent = currentBackup.name;

            $("backup-parent-name").textContent =
                `Modpack : ${modpack?.name || "Inconnu"}`;

            $("backup-detail-saved-at").textContent =
                formatDate(currentBackup.savedAt);

            $("backup-detail-imported-at").textContent =
                formatDate(currentBackup.importedAt);

            $("backup-detail-format").textContent =
                currentBackup.format === "zip" ? "ZIP" : "Dossier";

            $("backup-detail-size").textContent =
                formatSize(currentBackup.sizeBytes);

            $("backup-detail-path").textContent = currentBackup.path;

            fillEditableFields();

            message(
                "Les modifications concernent uniquement cette sauvegarde, " +
                "pas le modpack ni les autres sauvegardes."
            );
        } catch (error) {
            currentBackup = null;
            $("backup-dialog-title").textContent = "Fiche indisponible";
            message(error.message, true);
        } finally {
            setBusy(false);
        }
    }

    closeButton.addEventListener("click", async () => {
        if (busy) return;

        if (await allowDiscard()) {
            dialog.close();
        }
    });

    dialog.addEventListener("cancel", async (event) => {
        event.preventDefault();

        if (busy) return;

        if (await allowDiscard()) {
            dialog.close();
        }
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (busy || !currentBackup || !form.reportValidity()) return;

        if (!isDirty()) {
            message("Aucune modification à enregistrer.");
            return;
        }

        setBusy(true);
        message("Enregistrement de la fiche sauvegarde...");

        try {
            const result = await window.mcvault.updateBackup(
                currentBackup.id,
                currentChanges(),
                currentBackup.updatedAt ?? null
            );

            if (!result.success) {
                throw new Error(result.message);
            }

            currentBackup = result.backup;
            fillEditableFields();

            message("Fiche sauvegarde enregistrée.");

            window.dispatchEvent(
                new Event("mcvault:library-updated")
            );
        } catch (error) {
            message(error.message, true);
        } finally {
            setBusy(false);
        }
    });

    $("backup-detail-explorer-button").addEventListener(
        "click",
        async () => {
            if (busy || !currentBackup) return;

            setBusy(true);

            try {
                const result = await window.mcvault.showBackupInExplorer(
                    currentBackup.id
                );

                if (!result.success) {
                    throw new Error(result.message);
                }

                message("Emplacement demandé dans l’Explorateur Windows.");
            } catch (error) {
                message(error.message, true);
            } finally {
                setBusy(false);
            }
        }
    );

    $("backup-view-modpack-button").addEventListener("click",
        async () => {
            
            if (busy || !currentBackup) return;
            if (!(await allowDiscard())) return;

            const modpackId = currentBackup.modpackId;

            dialog.close();

            window.dispatchEvent(
                new CustomEvent("mcvault:open-modpack", {
                    detail: { modpackId }
                })
            );
        });

    $("backup-detail-trash-button").addEventListener(
        "click",
        async () => {

            if (busy || !currentBackup) return;
            if (!(await allowDiscard())) return;

            setBusy(true);

            try {
                const result = await window.mcvault.moveBackupToTrash(
                    currentBackup.id
                );

                if (result.canceled) {
                    message("Mise à la corbeille annulée.");
                    return;
                }

                if (!result.success) {
                    throw new Error(result.message);
                }

                currentBackup = null;
                initialState = "";
                dialog.close();

                window.dispatchEvent(
                    new Event("mcvault:library-updated")
                );
            } catch (error) {
                message(error.message, true);
            } finally {
                setBusy(false);
            }
        }
    );

    window.addEventListener("mcvault:open-backup", (event) => {
        openBackup(event.detail?.backupId);
    });
})();