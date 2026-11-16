"use strict";

(() => {
  const $ = (id) => document.getElementById(id);

  const dialog = $("settings-dialog");
  const closeButton = $("close-settings-button");

  const storagePath = $("settings-storage-path");
  const chooseStorageButton = $("choose-settings-storage-button");
  const applyStorageButton = $("apply-settings-storage-button");

  const keepInput = $("settings-keep-recent");
  const ageInput = $("settings-minimum-age");
  const saveButton = $("save-settings-button");
  const feedback = $("settings-feedback");

  let busy = false;
  let pendingStorageRoot = null;

  function message(text, isError = false) {
    feedback.textContent = text;
    feedback.classList.toggle("is-error", isError);
  }

  function setBusy(value) {
    busy = value;

    closeButton.disabled = value;
    chooseStorageButton.disabled = value;
    applyStorageButton.disabled = value || !pendingStorageRoot;
    keepInput.disabled = value;
    ageInput.disabled = value;
    saveButton.disabled = value;

    saveButton.textContent = value
      ? "Enregistrement..."
      : "Enregistrer les réglages";
  }

  function displaySettings(settings, info) {
    storagePath.textContent = info.storageRoot || "Non configuré";

    keepInput.value = settings.cleanup.keepRecent;
    ageInput.value = settings.cleanup.minimumAgeDays;

    pendingStorageRoot = null;
    applyStorageButton.disabled = true;
  }

  async function loadSettings() {
    if (busy) return;

    setBusy(true);
    message("Chargement des paramètres...");

    try {
      const result = await window.mcvault.getSettings();

      if (!result.success) {
        throw new Error(result.message);
      }

      displaySettings(result.settings, result.info);

      message("Paramètres chargés.");
    } catch (error) {
      message(`Impossible de charger les paramètres : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  }

  chooseStorageButton.addEventListener("click", async () => {
    if (busy) return;

    setBusy(true);
    message("Sélection du dossier...");

    try {
      const result = await window.mcvault.chooseSettingsStorage();

      if (result.canceled) {
        message("Sélection annulée. Le dossier actuel reste utilisé.");
        return;
      }

      if (!result.success) {
        throw new Error(result.message);
      }

      pendingStorageRoot = result.storageRoot;
      applyStorageButton.disabled = false;

      message(
        "Dossier sélectionné. Confirme son utilisation pour les futurs imports."
      );
    } catch (error) {
      message(`Sélection impossible : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  });

  applyStorageButton.addEventListener("click", async () => {
    if (busy || !pendingStorageRoot) return;

    setBusy(true);
    message("Application du nouveau dossier...");

    try {
      const result = await window.mcvault.applySettingsStorage();

      if (result.canceled) {
        message("Application annulée.");
        return;
      }

      if (!result.success) {
        throw new Error(result.message);
      }

      displaySettings(
        (await window.mcvault.getSettings()).settings,
        result.info
      );

      message("Nouveau dossier enregistré pour les futurs imports.");

      window.dispatchEvent(new Event("mcvault:settings-updated"));
    } catch (error) {
      message(`Application impossible : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  });

  saveButton.addEventListener("click", async () => {
    if (busy) return;

    const keepRecent = keepInput.valueAsNumber;
    const minimumAgeDays = ageInput.valueAsNumber;

    if (
      !Number.isInteger(keepRecent) ||
      keepRecent < 1 ||
      keepRecent > 100
    ) {
      message(
        "Le nombre d’imports récents doit être un entier de 1 à 100.",
        true
      );

      return;
    }

    if (
      !Number.isInteger(minimumAgeDays) ||
      minimumAgeDays < 0 ||
      minimumAgeDays > 36500
    ) {
      message(
        "L’ancienneté minimale doit être un entier de 0 à 36 500 jours.",
        true
      );

      return;
    }

    setBusy(true);
    message("Enregistrement des réglages...");

    try {
      const result = await window.mcvault.updateCleanupSettings({
        cleanup: {
          keepRecent,
          minimumAgeDays
        }
      });

      if (!result.success) {
        throw new Error(result.message);
      }

      displaySettings(result.settings, result.info);

      message("Réglages enregistrés.");

      window.dispatchEvent(
        new CustomEvent("mcvault:settings-updated", {
          detail: { settings: result.settings }
        })
      );
    } catch (error) {
      message(`Enregistrement impossible : ${error.message}`, true);
    } finally {
      setBusy(false);
    }
  });

  closeButton.addEventListener("click", () => {
    if (!busy) dialog.close();
  });

  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });

  $("open-settings-button").addEventListener("click", () => {
    if (!dialog.open) {
      dialog.showModal();
      loadSettings();
    }
  });

  window.addEventListener("mcvault:settings-updated", () => {
    if (dialog.open) {
      loadSettings();
    }
  });
})();