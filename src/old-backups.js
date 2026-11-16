"use strict";

(() => {
    const $ = (id) => document.getElementById(id);

    const keepInput = $("old-backups-keep");
    const ageInput = $("old-backups-age");
    const analyzeButton = $("analyze-old-backups-button");
    const moreButton = $("old-backups-more-button");
    const feedback = $("old-backups-feedback");
    const results = $("old-backups-results");

    const DAY_MS = 24 * 60 * 60 * 1000;
    const PAGE_SIZE = 40;

    let busy = false;
    let revision = 0;
    let visibleLimit = PAGE_SIZE;
    let analysis = null;


    function element(tag, className, text) {
        const node = document.createElement(tag);

        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;

        return node;
    }

    function formatDate(value) {
        return new Date(value).toLocaleString("fr-FR", {
            dateStyle: "medium",
            timeStyle: "short"
        });
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

        const value = bytes / (1024 ** unit);

        return `${value.toLocaleString("fr-FR", {
            maximumFractionDigits: unit === 0 ? 0 : 2
        })} ${units[unit]}`;
    }

    function setBusy(value) {
        busy = value;

        analyzeButton.disabled = value;
        keepInput.disabled = value;
        ageInput.disabled = value;

        analyzeButton.textContent = value
            ? "Analyse en cours..."
            : "Rechercher les anciennes sauvegardes";
    }

    function clearResults(message) {
        analysis = null;
        visibleLimit = PAGE_SIZE;

        results.replaceChildren();
        moreButton.hidden = true;

        feedback.classList.remove("is-error");
        feedback.textContent = message;
    }

    function readSettings() {
        const keep = keepInput.valueAsNumber;
        const ageDays = ageInput.valueAsNumber;

        if (!Number.isInteger(keep) || keep < 1 || keep > 100) {
            throw new Error(
                "Le nombre d’imports récents doit être un entier de 1 à 100."
            );
        }

        if (
            !Number.isInteger(ageDays) ||
            ageDays < 0 ||
            ageDays > 36500
        ) {
            throw new Error(
                "L’ancienneté doit être un entier de 0 à 36 500 jours."
            );
        }

        return { keep, ageDays };
    }

    function buildAnalysis(library, settings) {
        const now = Date.now();
        const cutoff = now - settings.ageDays * DAY_MS;

        const modpacks = new Map(
            library.modpacks.map((modpack) => [modpack.id, modpack])
        );

        const buckets = new Map();

        let unsupported = 0;
        let missingSavedAt = 0;

        for (const backup of library.backups) {
            const modpack = modpacks.get(backup.modpackId);

            if (
                !modpack ||
                !["zip", "directory"].includes(backup.format)
            ) {
                unsupported++;
                continue;
            }

            const time = Date.parse(backup.savedAt || "");

            if (!Number.isFinite(time)) {
                missingSavedAt++;
                continue;
            }

            const key = JSON.stringify([
                backup.modpackId,
                backup.format
            ]);

            if (!buckets.has(key)) {
                buckets.set(key, {
                    modpackName: modpack.name,
                    format: backup.format,
                    backups: []
                });
            }

            buckets.get(key).backups.push({ backup, time });
        }

        const groups = [];

        for (const bucket of buckets.values()) {
            bucket.backups.sort(
                (a, b) =>
                    b.time - a.time ||
                    String(a.backup.id).localeCompare(String(b.backup.id))
            );

            if (bucket.backups.length <= settings.keep) continue;

            // Les ex aequo à cette date restent tous non signalés.
            const protectedBoundary =
                bucket.backups[settings.keep - 1].time;

            const candidates = bucket.backups.filter(
                (item) =>
                    item.time < protectedBoundary &&
                    item.time <= cutoff
            );

            if (candidates.length === 0) continue;

            // Présenter les candidats les plus anciens en premier.
            candidates.sort(
                (a, b) =>
                    a.time - b.time ||
                    String(a.backup.id).localeCompare(String(b.backup.id))
            );

            groups.push({
                modpackName: bucket.modpackName,
                format: bucket.format,
                latestTime: bucket.backups[0].time,
                candidates
            });
        }

        groups.sort(
            (a, b) =>
                a.modpackName.localeCompare(
                    b.modpackName,
                    "fr",
                    { numeric: true }
                ) ||
                a.format.localeCompare(b.format)
        );

        return {
            now,
            settings,
            total: library.backups.length,
            unsupported,
            missingSavedAt,
            groups,
            candidateCount: groups.reduce(
                (sum, group) => sum + group.candidates.length,
                0
            )
        };
    }

    function createBackupRow(item, analyzedAt) {
        const row = element("article", "cleanup-backup-row");
        const info = element("div", "cleanup-backup-info");

        const ageDays = Math.floor(
            (analyzedAt - item.time) / DAY_MS
        );

        info.append(
            element("h4", "", item.backup.name),
            element(
                "p",
                "",
                `Sauvegarde du ${formatDate(item.time)} · ` +
                `${ageDays} jour(s) · ` +
                `${formatSize(item.backup.sizeBytes)} indexés`
            )
        );

        const button = element(
            "button",
            "compact-button",
            "Afficher l’emplacement"
        );

        button.type = "button";

        button.addEventListener("click", async () => {
            button.disabled = true;

            try {
                const response =
                    await window.mcvault.showBackupInExplorer(item.backup.id);

                if (!response.success) {
                    throw new Error(response.message);
                }
            } catch (error) {
                feedback.textContent =
                    `Ouverture impossible : ${error.message}`;

                feedback.classList.add("is-error");
            } finally {
                button.disabled = false;
            }
        });

        row.append(info, button);

        return row;
    }

    function render() {
        if (!analysis) return;

        results.replaceChildren();

        const fragment = document.createDocumentFragment();
        let remaining = visibleLimit;
        let displayed = 0;

        for (const group of analysis.groups) {
            if (remaining <= 0) break;

            const items = group.candidates.slice(0, remaining);
            remaining -= items.length;
            displayed += items.length;

            const section = element(
                "section",
                "duplicate-group old-backup-group"
            );

            const heading = element("div", "section-heading");

            heading.append(
                element(
                    "h3",
                    "",
                    `${group.modpackName} — ` +
                    (group.format === "zip" ? "ZIP" : "Dossiers")
                ),
                element(
                    "span",
                    "subtle-badge",
                    `${group.candidates.length} signalement(s)`
                )
            );

            section.append(
                heading,
                element(
                    "p",
                    "duplicate-group-explanation",
                    `Import le plus récent de ce groupe : ` +
                    `${formatDate(group.latestTime)}.`
                )
            );

            for (const item of items) {
                section.append(createBackupRow(item, analysis.now));
            }

            fragment.append(section);
        }

        results.append(fragment);

        moreButton.hidden = displayed >= analysis.candidateCount;

        const exclusions = [];

        if (analysis.unsupported) {
            exclusions.push(
                `${analysis.unsupported} entrée(s) non prise(s) en charge`
            );
        }

        if (analysis.missingSavedAt) {
            exclusions.push(
                `${analysis.missingSavedAt} sauvegarde(s) sans date de sauvegarde choisie`
            );
        }

        feedback.classList.remove("is-error");

        feedback.textContent =
            `Analyse du ${formatDate(analysis.now)} : ` +
            `${analysis.candidateCount} sauvegarde(s) signalée(s), ` +
            `${displayed} affichée(s), sur ${analysis.total} indexée(s). ` +
            (
                analysis.candidateCount === 0
                    ? "Aucune sauvegarde ne remplit les critères. "
                    : "Aucune suppression effectuée. "
            ) +
            (
                exclusions.length
                    ? `Éléments exclus : ${exclusions.join(" ; ")}.`
                    : ""
            );
    }

    analyzeButton.addEventListener("click", async () => {
        if (busy) return;

        let settings;

        try {
            settings = readSettings();
        } catch (error) {
            clearResults(error.message);
            feedback.classList.add("is-error");
            return;
        }

        const currentRevision = ++revision;

        clearResults("Lecture de la bibliothèque...");
        setBusy(true);

        try {
            const response = await window.mcvault.getLibrary();

            if (currentRevision !== revision) return;

            if (!response.success) {
                throw new Error(response.message);
            }

            if (response.importNeedsReview) {
                throw new Error(
                    "Un import nécessite un contrôle. " +
                    "Résous son journal avant cette analyse."
                );
            }

            analysis = buildAnalysis(response.library, settings);
            visibleLimit = PAGE_SIZE;
            render();
        } catch (error) {
            if (currentRevision !== revision) return;

            clearResults(`Analyse impossible : ${error.message}`);
            feedback.classList.add("is-error");
        } finally {
            setBusy(false);
        }
    });

    moreButton.addEventListener("click", () => {
        visibleLimit += PAGE_SIZE;
        render();
    });

    for (const input of [keepInput, ageInput]) {
        input.addEventListener("input", () => {
            revision++;

            clearResults(
                "Les critères ont changé. Relance l’analyse."
            );
        });
    }

    window.addEventListener("mcvault:library-updated", () => {
        revision++;

        clearResults(
            "La bibliothèque a changé. Relance l’analyse."
        );
    });

    async function applySavedSettings() {
        try {
            const result = await window.mcvault.getSettings();

            if (!result.success) return;

            keepInput.value = result.settings.cleanup.keepRecent;
            ageInput.value = result.settings.cleanup.minimumAgeDays;

            revision++;
            clearResults(
                "Réglages chargés. Lance une nouvelle analyse si nécessaire."
            );
        } catch (error) {
            console.error("Chargement des réglages :", error);
        }
    }

    applySavedSettings();

    window.addEventListener("mcvault:settings-updated", () => {
        applySavedSettings();
    });

})();