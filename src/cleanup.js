"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const dialog = $("cleanup-dialog");
  const closeButton = $("close-cleanup-button");
  const scanButton = $("scan-duplicates-button");
  const progressArea = $("cleanup-progress-area");
  const feedback = $("cleanup-feedback");
  const groupsContainer = $("duplicate-groups");

  const skippedDetails = $("cleanup-skipped");
  const skippedTitle = $("cleanup-skipped-title");
  const skippedList = $("cleanup-skipped-list");

  let busy = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);

    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;

    return node;
  }

  function formatSize(bytes) {
    if (!bytes) return "0 octet";

    const units = ["octets", "Kio", "Mio", "Gio", "Tio"];

    const unit = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );

    return `${(bytes / (1024 ** unit)).toLocaleString("fr-FR", {
      maximumFractionDigits: unit === 0 ? 0 : 2
    })} ${units[unit]}`;
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

  function setBusy(value) {
    busy = value;
    scanButton.disabled = value;
    closeButton.disabled = value;
    progressArea.hidden = !value;

    scanButton.textContent = value
      ? "Analyse en cours..."
      : "Rechercher les doublons potentiels";
  }

  function createBackupRow(backup) {
    const row = element("article", "cleanup-backup-row");

    const info = element("div", "cleanup-backup-info");

    info.append(
      element("h4", "", backup.name),
      element(
        "p",
        "",
        `${formatDate(backup.importedAt)} · ${formatSize(backup.sizeBytes)}`
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
        const result = await window.mcvault.showBackupInExplorer(backup.id);

        if (!result.success) {
          feedback.textContent = result.message;
          feedback.classList.add("is-error");
        }
      } catch (error) {
        console.error("Ouverture depuis le nettoyage :", error);

        feedback.textContent = "Impossible d’ouvrir cet emplacement.";
        feedback.classList.add("is-error");
      } finally {
        button.disabled = false;
      }
    });

    row.append(info, button);

    return row;
  }

  function renderResults(result) {
    groupsContainer.replaceChildren();
    skippedList.replaceChildren();

    const fragment = document.createDocumentFragment();

    result.groups.forEach((group, index) => {
      const section = element("section", "duplicate-group");

      const header = element("div", "section-heading");

      header.append(
        element(
          "h3",
          "",
          `${group.modpackName} — groupe ${index + 1}`
        ),
        element(
          "span",
          "subtle-badge",
          `${group.backups.length} sauvegardes`
        )
      );

      section.append(header);

      const explanation = group.format === "zip"
        ? "Archives ZIP de même taille. Leurs contenus peuvent être différents."
        : "Dossiers avec la même arborescence et les mêmes tailles de fichiers. " +
          "Leurs contenus peuvent être différents.";

      section.append(
        element("p", "duplicate-group-explanation", explanation)
      );

      if (group.empty) {
        section.append(
          element(
            "p",
            "duplicate-group-warning",
            "Attention : dossiers sans fichier ou archives de taille nulle. " +
            "Ne les considère pas comme des sauvegardes valides."
          )
        );
      }

      for (const backup of group.backups) {
        section.append(createBackupRow(backup));
      }

      fragment.append(section);
    });

    groupsContainer.append(fragment);

    skippedDetails.hidden = result.skipped.length === 0;
    skippedDetails.open = false;

    skippedTitle.textContent =
      `${result.skipped.length} sauvegarde(s) non analysée(s)`;

    for (const item of result.skipped) {
      const row = element("div", "cleanup-skipped-row");

      row.append(
        element("h4", "", item.name),
        element("p", "", item.reason)
      );

      skippedList.append(row);
    }

    const candidates = result.groups.reduce(
      (sum, group) => sum + group.backups.length,
      0
    );

    feedback.classList.remove("is-error");

    feedback.textContent =
      `Analyse du ${formatDate(result.scannedAt)} : ` +
      `${result.analyzed} / ${result.total} sauvegarde(s) analysée(s). ` +
      `${result.groups.length} groupe(s) potentiel(s), ` +
      `${candidates} sauvegarde(s) concernée(s). ` +
      (
        result.skipped.length
          ? "Analyse partielle : consulte les éléments non analysés."
          : result.groups.length === 0
            ? "Aucun rapprochement trouvé selon ces critères."
            : "Aucune suppression effectuée."
      );
  }

  scanButton.addEventListener("click", async () => {
    if (busy) return;

    setBusy(true);

    groupsContainer.replaceChildren();
    skippedList.replaceChildren();
    skippedDetails.hidden = true;

    feedback.classList.remove("is-error");

    feedback.textContent =
      "Analyse locale en cours. Les fichiers de sauvegarde ne sont pas modifiés.";

    try {
      const response = await window.mcvault.scanPotentialDuplicates();

      if (!response.success) {
        throw new Error(response.message);
      }

      renderResults(response.result);
    } catch (error) {
      feedback.textContent = `Analyse impossible : ${error.message}`;
      feedback.classList.add("is-error");
    } finally {
      setBusy(false);
    }
  });

  $("open-cleanup-button").addEventListener("click", () => {
    if (!dialog.open) {
      dialog.showModal();
    }
  });

  closeButton.addEventListener("click", () => {
    if (!busy) dialog.close();
  });

  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });

  window.addEventListener("mcvault:library-updated", () => {
    if (busy) return;

    groupsContainer.replaceChildren();
    skippedList.replaceChildren();
    skippedDetails.hidden = true;

    feedback.classList.remove("is-error");

    feedback.textContent =
      "La bibliothèque a changé. Lance une nouvelle analyse.";
  });
})();