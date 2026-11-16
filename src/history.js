"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const dialog = $("history-dialog");
  const timeline = $("history-timeline");
  const feedback = $("history-feedback");
  const empty = $("history-empty");
  const emptyDescription = $("history-empty-description");

  const search = $("history-search");
  const modpackFilter = $("history-modpack");
  const formatFilter = $("history-format");
  const orderFilter = $("history-order");
  const dateFrom = $("history-date-from");
  const dateTo = $("history-date-to");

  const refreshButton = $("history-refresh-button");
  const moreButton = $("history-more-button");

  const PAGE_SIZE = 40;

  const dayFormatter = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "full"
  });

  const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
    timeStyle: "short"
  });

  let rows = [];
  let totalImports = 0;
  let visibleLimit = PAGE_SIZE;
  let requestId = 0;
  let needsReview = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);

    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;

    return node;
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr-FR");
  }

  function parseTime(backup) {
    const time = Date.parse(backup.savedAt || "");

    return Number.isFinite(time) ? time : null;
  }

  function dayKey(time) {
    if (time === null) return "unknown";

    const date = new Date(time);

    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
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

  function fillModpackOptions(modpacks, desiredValue) {
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "Tous les modpacks";

    modpackFilter.replaceChildren(all);

    const sorted = [...modpacks].sort((a, b) =>
      a.name.localeCompare(b.name, "fr", { numeric: true })
    );

    for (const modpack of sorted) {
      const option = document.createElement("option");
      option.value = modpack.id;
      option.textContent = modpack.name;
      modpackFilter.append(option);
    }

    modpackFilter.value = sorted.some(
      (modpack) => modpack.id === desiredValue
    )
      ? desiredValue
      : "all";
  }

  function resetFilters() {
    search.value = "";
    modpackFilter.value = "all";
    formatFilter.value = "all";
    orderFilter.value = "recent";
    dateFrom.value = "";
    dateTo.value = "";
    visibleLimit = PAGE_SIZE;
  }

  function getFilteredRows() {
    const query = normalize(search.value.trim());

    return rows
      .filter((row) => {
        if (
          query &&
          !normalize(`${row.backup.name} ${row.modpack.name}`).includes(query)
        ) return false;

        if (
          modpackFilter.value !== "all" &&
          row.modpack.id !== modpackFilter.value
        ) return false;

        if (
          formatFilter.value !== "all" &&
          row.backup.format !== formatFilter.value
        ) return false;

        // Comparaison de jours locaux pour inclure la journée entière.
        if (dateFrom.value || dateTo.value) {
          if (row.time === null) return false;

          const key = dayKey(row.time);

          if (dateFrom.value && key < dateFrom.value) return false;
          if (dateTo.value && key > dateTo.value) return false;
        }

        return true;
      })
      .sort((a, b) => {
        // Les dates inconnues restent en bas dans les deux sens.
        if (a.time === null && b.time === null) {
          return a.backup.id.localeCompare(b.backup.id);
        }

        if (a.time === null) return 1;
        if (b.time === null) return -1;

        const difference = orderFilter.value === "oldest"
          ? a.time - b.time
          : b.time - a.time;

        return difference || a.backup.id.localeCompare(b.backup.id);
      });
  }

  function createEntry(row) {
    const { backup, modpack, time } = row;

    const article = element("article", "history-entry");
    const content = element("div", "history-entry-content");

    const top = element("div", "history-entry-top");

    top.append(
      element(
        "span",
        "history-entry-time",
        time === null ? "Heure inconnue" : timeFormatter.format(new Date(time))
      ),
      element("span", "subtle-badge", backup.format === "zip" ? "ZIP" : "DOSSIER")
    );

    content.append(
      top,
      element("h4", "history-entry-name", backup.name),
      element("p", "history-entry-modpack", modpack.name),
      element(
        "p",
        "history-entry-size",
        `Sauvegarde du ${formatDate(backup.savedAt)} · ` +
        `${formatSize(backup.sizeBytes)}`
      )
    );

    const actions = element("div", "history-entry-actions");

    const showButton = element(
      "button",
      "compact-button",
      "Afficher dans l’Explorateur"
    );

    showButton.type = "button";

    showButton.addEventListener("click", async () => {
      showButton.disabled = true;

      try {
        const result = await window.mcvault.showBackupInExplorer(backup.id);

        if (!result.success) {
          feedback.textContent = result.message;
          feedback.classList.add("is-error");
        }
      } catch (error) {
        console.error("Ouverture depuis l’historique :", error);

        feedback.textContent =
          "Impossible de contacter le module d’ouverture.";

        feedback.classList.add("is-error");
      } finally {
        showButton.disabled = false;
      }
    });

    actions.append(showButton);
    content.append(actions);
    article.append(content);

    return article;
  }

  function render() {
    timeline.replaceChildren();
    feedback.classList.remove("is-error");

    if (
      dateFrom.value &&
      dateTo.value &&
      dateFrom.value > dateTo.value
    ) {
      empty.hidden = true;
      moreButton.hidden = true;

      feedback.textContent =
        "La date de début doit précéder ou égaler la date de fin.";

      feedback.classList.add("is-error");
      return;
    }

    const filtered = getFilteredRows();
    const displayed = filtered.slice(0, visibleLimit);

    const fragment = document.createDocumentFragment();

    let currentKey = null;
    let currentEntries = null;

    for (const row of displayed) {
      const key = dayKey(row.time);

      if (key !== currentKey) {
        currentKey = key;

        const group = element("section", "history-day");
        const title = row.time === null
          ? "Date de sauvegarde inconnue"
          : dayFormatter.format(new Date(row.time));

        group.append(element("h3", "history-day-title", title));

        currentEntries = element("div", "history-day-entries");
        group.append(currentEntries);
        fragment.append(group);
      }

      currentEntries.append(createEntry(row));
    }

    timeline.append(fragment);

    empty.hidden = filtered.length !== 0;
    moreButton.hidden = displayed.length >= filtered.length;

    emptyDescription.textContent = totalImports === 0
      ? "Importe une sauvegarde pour commencer ton historique."
      : "Aucune sauvegarde ne correspond aux filtres sélectionnés.";

    const size = filtered.reduce(
      (total, row) => total + row.backup.sizeBytes,
      0
    );

    feedback.textContent =
      `${filtered.length} import(s) correspondant(s), ` +
      `${displayed.length} affiché(s) — ${formatSize(size)} indexés.` +
      (
        needsReview
          ? " Un journal d’import est présent : un contrôle reste nécessaire."
          : ""
      );
  }

  async function loadHistory(desiredModpack = modpackFilter.value) {
    const currentRequest = ++requestId;

    refreshButton.disabled = true;
    refreshButton.textContent = "Chargement...";

    try {
      const result = await window.mcvault.getLibrary();

      if (currentRequest !== requestId) return;

      if (!result.success) {
        throw new Error(result.message);
      }

      const library = result.library;

      const modpacks = new Map(
        library.modpacks.map((modpack) => [modpack.id, modpack])
      );

      rows = library.backups.map((backup) => ({
        backup,
        modpack: modpacks.get(backup.modpackId),
        time: parseTime(backup)
      }));

      totalImports = rows.length;
      needsReview = result.importNeedsReview;

      fillModpackOptions(library.modpacks, desiredModpack);

      visibleLimit = PAGE_SIZE;
      render();
    } catch (error) {
      if (currentRequest !== requestId) return;

      feedback.textContent =
        `Impossible de charger l’historique : ${error.message}`;

      feedback.classList.add("is-error");
    } finally {
      if (currentRequest === requestId) {
        refreshButton.disabled = false;
        refreshButton.textContent = "Actualiser";
      }
    }
  }

  function openHistory(modpackId = "all") {
    if (dialog.open) return;

    resetFilters();
    timeline.replaceChildren();
    empty.hidden = true;
    moreButton.hidden = true;

    feedback.classList.remove("is-error");
    feedback.textContent = "Chargement de l’historique...";

    dialog.showModal();
    loadHistory(modpackId);
  }

  function filtersChanged() {
    visibleLimit = PAGE_SIZE;
    render();
  }

  search.addEventListener("input", filtersChanged);

  for (const control of [
    modpackFilter,
    formatFilter,
    orderFilter,
    dateFrom,
    dateTo
  ]) {
    control.addEventListener("change", filtersChanged);
  }

  $("history-reset-button").addEventListener("click", () => {
    resetFilters();
    render();
  });

  refreshButton.addEventListener("click", () => {
    loadHistory();
  });

  moreButton.addEventListener("click", () => {
    visibleLimit += PAGE_SIZE;
    render();
  });

  $("close-history-button").addEventListener("click", () => {
    dialog.close();
  });

  $("open-history-button").addEventListener("click", () => {
    openHistory();
  });

  window.addEventListener("mcvault:open-history", (event) => {
    openHistory(event.detail?.modpackId || "all");
  });

  window.addEventListener("mcvault:library-updated", () => {
    if (dialog.open) {
      loadHistory();
    }
  });

  function formatDate(value) {
    const time = Date.parse(value);

    return Number.isFinite(time)
      ? new Date(time).toLocaleString("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short"
      })
      : "Date inconnue";
  }

})();