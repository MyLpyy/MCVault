"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const refreshButton = $("refresh-trash-button");
  const emptyButton = $("empty-trash-button");
  const feedback = $("trash-feedback");
  const list = $("trash-list");

  let busy = false;

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "Taille inconnue";
    }

    const units = ["octet", "Kio", "Mio", "Gio", "Tio"];
    const index = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );

    const value = bytes / (1024 ** index);

    return `${value.toLocaleString("fr-FR", {
      maximumFractionDigits: index === 0 ? 0 : 2
    })} ${units[index]}`;
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

  function message(text, isError = false) {
    feedback.textContent = text;
    feedback.classList.toggle("is-error", isError);
  }

  function setBusy(value) {
    busy = value;

    refreshButton.disabled = value;
    emptyButton.disabled = value;
  }

  async function loadTrash() {
    if (busy) return;

    setBusy(true);
    message("Chargement de la corbeille...");

    try {
      const result = await window.mcvault.listTrash();

      if (!result.success) {
        throw new Error(result.message);
      }

      list.replaceChildren();

      if (!result.items.length) {
        const empty = document.createElement("p");
        empty.className = "cleanup-help";
        empty.textContent = "La corbeille est vide.";

        list.append(empty);
        message("La corbeille est vide.");
        return;
      }

      for (const item of result.items) {
        const row = document.createElement("article");
        row.className = "cleanup-backup-row";

        const info = document.createElement("div");
        info.className = "cleanup-backup-info";

        const title = document.createElement("h4");
        title.textContent = item.name;

        const details = document.createElement("p");
        details.textContent =
          `${item.modpackName} — ${formatSize(item.sizeBytes)} — ` +
          `mise à la corbeille le ${formatDate(item.deletedAt)}`;

        info.append(title, details);
        row.append(info);
        list.append(row);
      }

      message(
        `${result.items.length} sauvegarde(s) présente(s) dans la corbeille.`
      );
    } catch (error) {
      message(`Impossible de charger la corbeille : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  refreshButton.addEventListener("click", loadTrash);

  emptyButton.addEventListener("click", async () => {
    if (busy) return;

    setBusy(true);
    message("Suppression définitive en cours...");

    try {
      const result = await window.mcvault.emptyTrash();

      if (result.canceled) {
        message("Suppression annulée.");
        return;
      }

      if (!result.success) {
        throw new Error(result.message);
      }

      message(result.message);
      await loadTrash();
    } catch (error) {
      message(`Suppression impossible : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  });

  window.addEventListener("mcvault:library-updated", loadTrash);

  loadTrash();
})();