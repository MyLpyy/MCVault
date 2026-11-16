"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const list = $("backup-list");
  const emptyState = $("library-empty-state");
  const emptyTitle = $("library-empty-title");
  const emptyDescription = $("library-empty-description");
  const feedback = $("library-feedback");
  const refreshButton = $("refresh-library-button");
  const loadMoreButton = $("load-more-button");

  const search = $("search-input");
  const statusFilter = $("status-filter");
  const sortSelect = $("sort-select");
  const modpackFilter = $("modpack-filter");
  const typeFilter = $("type-filter");
  const dateFilter = $("date-filter");
  const sizeFilter = $("size-filter");

  const STATUS_LABELS = {
    in_progress: "En cours",
    paused: "En pause",
    completed: "Terminé",
    abandoned: "Abandonné"
  };

  const PAGE_SIZE = 40;

  let library = { modpacks: [], backups: [] };
  let rows = [];
  let visibleLimit = PAGE_SIZE;
  let requestId = 0;
  let importNeedsReview = false;

  function formatSize(bytes) {
    const units = ["octets", "Kio", "Mio", "Gio", "Tio"];

    if (bytes === 0) return "0 octet";

    const unit = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );

    const value = bytes / (1024 ** unit);

    return `${value.toLocaleString("fr-FR", {
      maximumFractionDigits: unit === 0 ? 0 : 2
    })} ${units[unit]}`;
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr-FR");
  }

  function timestamp(value) {
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : 0;
  }

  function formatDate(value) {
    const time = timestamp(value);

    return time
      ? new Date(time).toLocaleString("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short"
      })
      : "Date inconnue";
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;

    return element;
  }

  function rebuildRows() {
    const modpacks = new Map(
      library.modpacks.map((modpack) => [modpack.id, modpack])
    );

    rows = library.backups.map((backup) => {
      const modpack = modpacks.get(backup.modpackId);

      return {
        backup,
        modpack,
        searchable: normalizeText(`${backup.name} ${modpack.name}`)
      };
    });
  }

  function updateCounters() {
    $("modpack-count").textContent = library.modpacks.length;
    $("backup-count").textContent = library.backups.length;
    $("nav-backup-count").textContent = library.backups.length;

    const bytes = library.backups.reduce(
      (total, backup) => total + backup.sizeBytes,
      0
    );

    $("indexed-size").textContent = formatSize(bytes);
  }

  function updateModpackOptions() {
    const previousValue = modpackFilter.value;

    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "Tous les modpacks";

    modpackFilter.replaceChildren(allOption);

    const sorted = [...library.modpacks].sort((a, b) =>
      a.name.localeCompare(b.name, "fr", { numeric: true })
    );

    for (const modpack of sorted) {
      const option = document.createElement("option");
      option.value = modpack.id;
      option.textContent = modpack.name;
      modpackFilter.append(option);
    }

    const stillExists = library.modpacks.some(
      (modpack) => modpack.id === previousValue
    );

    modpackFilter.value = stillExists ? previousValue : "all";
  }

  function getFilteredRows() {
    const query = normalizeText(search.value.trim());

    const minimumDate = dateFilter.value
      ? new Date(`${dateFilter.value}T00:00:00`).getTime()
      : null;

    const sizeText = sizeFilter.value.trim();
    const sizeMiB = Number(sizeText);

    const maximumBytes =
      sizeText !== "" && Number.isFinite(sizeMiB) && sizeMiB >= 0
        ? sizeMiB * 1024 * 1024
        : null;

    const filtered = rows.filter(({ backup, modpack, searchable }) => {
      if (query && !searchable.includes(query)) return false;

      if (
        statusFilter.value !== "all" &&
        (backup.status || "in_progress") !== statusFilter.value
      ) {
        return false;
      }

      if (
        modpackFilter.value !== "all" &&
        modpack.id !== modpackFilter.value
      ) return false;

      if (
        typeFilter.value !== "all" &&
        backup.type !== typeFilter.value
      ) return false;

      if (
        minimumDate !== null &&
        timestamp(backup.savedAt) < minimumDate
      ) return false;

      if (
        maximumBytes !== null &&
        backup.sizeBytes > maximumBytes
      ) return false;

      return true;
    });

    filtered.sort((a, b) => {
      switch (sortSelect.value) {
        case "oldest":
          return timestamp(a.backup.savedAt) -
            timestamp(b.backup.savedAt);

        case "name":
          return a.backup.name.localeCompare(
            b.backup.name,
            "fr",
            { numeric: true }
          );

        case "size":
          return b.backup.sizeBytes - a.backup.sizeBytes;

        default:
          return timestamp(b.backup.savedAt) -
            timestamp(a.backup.savedAt);
      }
    });

    return filtered;
  }

  function createCard({ backup, modpack }) {
    const card = createElement("article", "backup-card");

    const header = createElement("div", "backup-card-heading");

    const titleBlock = createElement("div", "backup-card-titles");
    titleBlock.append(
      createElement("p", "backup-modpack", modpack.name),
      createElement("h3", "backup-name", backup.name)
    );

    const format = backup.format === "zip" ? "ZIP" : "DOSSIER";

    header.append(
      titleBlock,
      createElement("span", "subtle-badge", format)
    );

    const badges = createElement("div", "backup-badges");
    const backupStatus = backup.status || "in_progress";

    const knownStatus = Object.hasOwn(
      STATUS_LABELS,
      backupStatus
    );

    const statusBadge = createElement(
      "span",
      "backup-status",
      knownStatus
        ? STATUS_LABELS[backupStatus]
        : "Statut non renseigné"
    );

    statusBadge.dataset.status = knownStatus
      ? backupStatus
      : "unknown";

    const typeLabel = backup.type === "server"
      ? "Serveur"
      : backup.type === "solo"
        ? "Solo"
        : "Type non renseigné";

    badges.append(
      statusBadge,
      createElement("span", "backup-type", typeLabel)
    );

    const details = createElement("dl", "backup-details");

    details.append(
      createElement("dt", "", "Sauvegarde du"),
      createElement("dd", "", formatDate(backup.savedAt)),
      createElement("dt", "", "Importée le"),
      createElement("dd", "", formatDate(backup.importedAt)),
      createElement("dt", "", "Taille indexée"),
      createElement("dd", "", formatSize(backup.sizeBytes))
    );

    const location = createElement("p", "backup-location", backup.path);
    location.title = backup.path;

    const openButton = createElement(
      "button",
      "secondary-button backup-open-button",
      "Afficher dans l’Explorateur"
    );

    openButton.type = "button";

    openButton.addEventListener("click", async () => {
      openButton.disabled = true;
      openButton.textContent = "Ouverture...";

      try {
        const result = await window.mcvault.showBackupInExplorer(backup.id);

        if (!result.success) {
          feedback.textContent = result.message;
          feedback.classList.add("is-error");
        }
      } catch (error) {
        console.error("Ouverture de la sauvegarde :", error);

        feedback.textContent =
          "Impossible de communiquer avec le module d’ouverture.";

        feedback.classList.add("is-error");
      } finally {
        openButton.disabled = false;
        openButton.textContent = "Afficher dans l’Explorateur";
      }
    });

    const profileButton = createElement(
      "button",
      "secondary-button backup-profile-button",
      "Fiche sauvegarde"
    );

    profileButton.type = "button";

    profileButton.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("mcvault:open-backup", {
          detail: { backupId: backup.id }
        })
      );
    });

    card.append(
      header,
      badges,
      details,
      location,
      profileButton,
      openButton
    );

    return card;
  }

  function render() {
    const filtered = getFilteredRows();
    const displayed = filtered.slice(0, visibleLimit);

    const fragment = document.createDocumentFragment();

    for (const row of displayed) {
      fragment.append(createCard(row));
    }

    list.replaceChildren(fragment);
    emptyState.hidden = filtered.length !== 0;
    loadMoreButton.hidden = displayed.length >= filtered.length;

    $("library-count").textContent =
      `${filtered.length} / ${library.backups.length} sauvegarde(s)`;

    if (library.backups.length === 0) {
      emptyTitle.textContent = "Ta bibliothèque commence ici.";
      emptyDescription.textContent =
        "Importe une sauvegarde pour la retrouver dans cette liste.";
    } else {
      emptyTitle.textContent = "Aucune sauvegarde ne correspond.";
      emptyDescription.textContent =
        "Modifie la recherche ou les filtres pour retrouver tes sauvegardes.";
    }

    feedback.classList.remove("is-error");

    feedback.textContent = importNeedsReview
      ? "Un journal d’import est présent : une opération nécessite un contrôle."
      : `${displayed.length} sauvegarde(s) affichée(s). ` +
      "Les tailles correspondent aux valeurs enregistrées à l’import.";
  }

  async function refreshLibrary() {
    const currentRequest = ++requestId;

    refreshButton.disabled = true;
    refreshButton.textContent = "Chargement...";

    try {
      const result = await window.mcvault.getLibrary();

      if (currentRequest !== requestId) return;

      if (!result.success) {
        throw new Error(result.message);
      }

      library = result.library;
      importNeedsReview = result.importNeedsReview;

      rebuildRows();
      updateCounters();
      updateModpackOptions();

      visibleLimit = PAGE_SIZE;
      render();
    } catch (error) {
      if (currentRequest !== requestId) return;

      feedback.textContent =
        `Impossible de charger la bibliothèque : ${error.message}`;

      feedback.classList.add("is-error");
      $("library-count").textContent = "Lecture impossible";
    } finally {
      if (currentRequest === requestId) {
        refreshButton.disabled = false;
        refreshButton.textContent = "Actualiser";
      }
    }
  }

  function filtersChanged() {
    visibleLimit = PAGE_SIZE;
    render();
  }

  search.addEventListener("input", filtersChanged);
  sizeFilter.addEventListener("input", filtersChanged);

  for (const control of [
    statusFilter,
    sortSelect,
    modpackFilter,
    typeFilter,
    dateFilter
  ]) {
    control.addEventListener("change", filtersChanged);
  }

  loadMoreButton.addEventListener("click", () => {
    visibleLimit += PAGE_SIZE;
    render();
  });

  refreshButton.addEventListener("click", refreshLibrary);

  window.addEventListener("mcvault:library-updated", refreshLibrary);

  refreshLibrary();
})();