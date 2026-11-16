"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const dialog = $("modpack-dialog");
  const selector = $("modpack-select");
  const content = $("modpack-content");
  const feedback = $("modpack-feedback");
  const closeButton = $("close-modpack-button");
  const saveButton = $("save-modpack-button");
  const form = $("modpack-form");

  const fields = {
    name: $("modpack-name"),
    status: $("modpack-status"),
    minecraftVersion: $("modpack-minecraft-version"),
    loader: $("modpack-loader"),
    tags: $("modpack-tags"),
    notes: $("modpack-notes"),
    links: $("modpack-links")
  };

  let library = { modpacks: [], backups: [] };
  let currentModpack = null;
  let initialState = "";
  let busy = false;

  function message(text, isError = false) {
    feedback.textContent = text;
    feedback.classList.toggle("is-error", isError);
  }

  function setBusy(value) {
    busy = value;

    selector.disabled = value;
    closeButton.disabled = value;
    saveButton.disabled = value;

    for (const field of Object.values(fields)) {
      field.disabled = value;
    }

    saveButton.textContent = value
      ? "Enregistrement..."
      : "Enregistrer la fiche";
  }

  function currentChanges() {
    return {
      status: fields.status.value,
      minecraftVersion: fields.minecraftVersion.value.trim(),
      loader: fields.loader.value.trim(),
      tags: fields.tags.value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      notes: fields.notes.value.trim(),
      links: fields.links.value
        .split(/\r?\n/)
        .map((link) => link.trim())
        .filter(Boolean)
    };
  }

  function isDirty() {
    return currentModpack &&
      JSON.stringify(currentChanges()) !== initialState;
  }

  let discardPending = false;

  async function allowDiscard() {
    if (discardPending) return false;
    if (!isDirty()) return true;

    discardPending = true;

    try {
      const result = await window.mcvault.confirmDiscard("modpack");
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

  function dateValue(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
  }

  function formatDate(value) {
    const time = dateValue(value);

    return time
      ? new Date(time).toLocaleString("fr-FR", {
        dateStyle: "medium",
        timeStyle: "short"
      })
      : "—";
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

  function renderBackups(backups) {
    const container = $("modpack-backups-list");
    container.replaceChildren();

    if (backups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "modpack-help";
      empty.textContent = "Aucune sauvegarde associée.";
      container.append(empty);
      return;
    }

    for (const backup of backups) {
      const row = document.createElement("article");
      row.className = "modpack-backup-row";

      const info = document.createElement("div");
      const name = document.createElement("h4");
      const details = document.createElement("p");

      name.textContent = backup.name;

      details.textContent =
        `Sauvegarde du ${formatDate(backup.savedAt)} · ` +
        `${formatSize(backup.sizeBytes)} · ` +
        `${backup.format === "zip" ? "ZIP" : "Dossier"}`;

      info.append(name, details);

      const profileButton = document.createElement("button");
      profileButton.type = "button";
      profileButton.className = "compact-button";
      profileButton.textContent = "Fiche sauvegarde";

      profileButton.addEventListener("click", async () => {
        if (busy) return;
        if (!(await allowDiscard())) return;

        dialog.close();

        window.dispatchEvent(
          new CustomEvent("mcvault:open-backup", {
            detail: { backupId: backup.id }
          })
        );
      });

      const explorerButton = document.createElement("button");
      explorerButton.type = "button";
      explorerButton.className = "compact-button";
      explorerButton.textContent = "Afficher l’emplacement";

      explorerButton.addEventListener("click", async () => {
        if (busy) return;

        explorerButton.disabled = true;

        try {
          const result = await window.mcvault.showBackupInExplorer(
            backup.id
          );

          if (!result.success) {
            throw new Error(result.message);
          }
        } catch (error) {
          message(error.message, true);
        } finally {
          explorerButton.disabled = false;
        }
      });

      const actions = document.createElement("div");
      actions.className = "modpack-backup-actions";
      actions.append(profileButton, explorerButton);

      row.append(info, actions);
      container.append(row);
    }
  }

  function displayModpack(id) {
    currentModpack = library.modpacks.find((item) => item.id === id);

    if (!currentModpack) {
      content.hidden = true;
      message("Aucun modpack à afficher.");
      return;
    }

    content.hidden = false;
    selector.value = currentModpack.id;

    $("modpack-dialog-title").textContent = currentModpack.name;

    fields.name.value = currentModpack.name;
    fields.status.value = currentModpack.status || "in_progress";
    fields.minecraftVersion.value = currentModpack.minecraftVersion || "";
    fields.loader.value = currentModpack.loader || "";

    fields.tags.value = Array.isArray(currentModpack.tags)
      ? currentModpack.tags.join(", ")
      : "";

    fields.notes.value = currentModpack.notes || "";

    fields.links.value = Array.isArray(currentModpack.links)
      ? currentModpack.links.join("\n")
      : "";

    const backups = library.backups
      .filter((backup) => backup.modpackId === currentModpack.id)
      .sort(
        (a, b) => dateValue(b.savedAt) - dateValue(a.savedAt)
      );

    $("modpack-backup-count").textContent = backups.length;

    $("modpack-total-size").textContent = formatSize(
      backups.reduce((total, backup) => total + backup.sizeBytes, 0)
    );

    $("modpack-last-backup").textContent = backups.length
      ? formatDate(backups[0].savedAt)
      : "—";

    renderBackups(backups);

    initialState = JSON.stringify(currentChanges());

    message(
      "Les modifications concernent la fiche uniquement, pas les fichiers de sauvegarde."
    );
  }

  async function openModpacks(requestedId) {
    if (busy || dialog.open) return;

    content.hidden = true;
    currentModpack = null;

    dialog.showModal();
    setBusy(true);
    message("Chargement des modpacks...");

    try {
      const result = await window.mcvault.getLibrary();

      if (!result.success) {
        throw new Error(result.message);
      }

      library = result.library;
      selector.replaceChildren();

      const sorted = [...library.modpacks].sort((a, b) =>
        a.name.localeCompare(b.name, "fr", { numeric: true })
      );

      for (const modpack of sorted) {
        const option = document.createElement("option");
        option.value = modpack.id;
        option.textContent = modpack.name;
        selector.append(option);
      }

      if (!sorted.length) {
        $("modpack-dialog-title").textContent = "Mes modpacks";
        message("Importe une sauvegarde pour créer ton premier modpack.");
        return;
      }

      const selected = sorted.find((item) => item.id === requestedId);

      displayModpack(selected ? selected.id : sorted[0].id);
    } catch (error) {
      message(`Impossible de charger les fiches : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  selector.addEventListener("change", async () => {
    if (busy || !currentModpack) return;

    const requestedId = selector.value;
    const previousId = currentModpack.id;

    selector.value = previousId;

    if (!(await allowDiscard())) return;

    displayModpack(requestedId);
  });

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

    if (busy || !currentModpack || !form.reportValidity()) return;

    if (!isDirty()) {
      message("Aucune modification à enregistrer.");
      return;
    }

    setBusy(true);
    message("Vérification des informations...");

    try {
      const result = await window.mcvault.updateModpack(
        currentModpack.id,
        currentChanges(),
        currentModpack.updatedAt ?? null
      );

      if (result.canceled) {
        message("Enregistrement annulé. Tes modifications restent dans le formulaire.");
        return;
      }

      if (!result.success) {
        message(result.message, true);
        return;
      }

      const index = library.modpacks.findIndex(
        (item) => item.id === result.modpack.id
      );

      library.modpacks[index] = result.modpack;

      displayModpack(result.modpack.id);
      message("Fiche enregistrée avec succès.");

      window.dispatchEvent(new Event("mcvault:library-updated"));
    } catch (error) {
      message("Impossible d’enregistrer la fiche.", true);
      console.error(error);
    } finally {
      setBusy(false);
    }
  });

  $("open-modpacks-button").addEventListener("click", () => {
    openModpacks();
  });

  window.addEventListener("mcvault:open-modpack", (event) => {
    openModpacks(event.detail?.modpackId);
  });

  $("open-modpack-history-button").addEventListener("click", async () => {
    if (!(await allowDiscard())) return;

    if (!allowDiscard()) return;

    const modpackId = currentModpack.id;

    dialog.close();

    window.dispatchEvent(
      new CustomEvent("mcvault:open-history", {
        detail: { modpackId }
      })
    );
  });
})();