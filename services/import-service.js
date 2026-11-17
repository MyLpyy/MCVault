"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createReadStream, createWriteStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");

const STATUSES = new Set([
  "in_progress",
  "paused",
  "completed",
  "abandoned"
]);

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;

  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      flag: "wx"
    });

    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => { });
  }
}

function validateName(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} invalide.`);
  }

  const name = value.trim();

  if (
    !name ||
    name.length > 100 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    name === "." ||
    name === ".." ||
    /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error(
      `${label} invalide : évite les noms réservés Windows, ` +
      "les caractères spéciaux et les points en fin de nom."
    );
  }

  return name;
}

function validateSavedAt(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "La date de la sauvegarde est obligatoire."
    );
  }

  const time = Date.parse(value);

  if (!Number.isFinite(time)) {
    throw new Error("La date de la sauvegarde est invalide.");
  }

  const date = new Date(time);

  if (date.getTime() > Date.now()) {
    throw new Error(
      "La date de la sauvegarde ne peut pas être dans le futur."
    );
  }

  return date.toISOString();
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

async function inventory(root) {
  const entries = [];

  async function visit(absolute, relative) {
    const stat = await fs.lstat(absolute);

    if (stat.isSymbolicLink()) {
      throw new Error(`Lien symbolique ou jonction non accepté : ${absolute}`);
    }

    if (stat.isDirectory()) {
      entries.push({ relative, type: "directory" });

      const directory = await fs.opendir(absolute);

      for await (const entry of directory) {
        await visit(
          path.join(absolute, entry.name),
          relative ? path.join(relative, entry.name) : entry.name
        );
      }

      return;
    }

    if (!stat.isFile()) {
      throw new Error(`Élément non pris en charge : ${absolute}`);
    }

    entries.push({
      relative,
      type: "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }

  await visit(root, "");

  entries.sort((a, b) =>
    a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0
  );

  return entries;
}

function compareInventories(expected, actual, checkDates) {
  if (expected.length !== actual.length) {
    throw new Error("L’arborescence a changé pendant l’opération.");
  }

  for (let i = 0; i < expected.length; i++) {
    const a = expected[i];
    const b = actual[i];

    if (
      a.relative !== b.relative ||
      a.type !== b.type ||
      (
        a.type === "file" &&
        (
          a.size !== b.size ||
          (checkDates && a.mtimeMs !== b.mtimeMs)
        )
      )
    ) {
      throw new Error(
        `Vérification impossible : ${a.relative || "source"} a changé.`
      );
    }
  }
}

async function checkWindowsLocks(root, entries) {
  if (process.platform !== "win32") {
    throw new Error("Ce moteur d’import est prévu pour Windows.");
  }

  const files = entries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.relative
      ? path.join(root, entry.relative)
      : root
    );

  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      $items = ConvertFrom-Json ([Console]::In.ReadToEnd())
      foreach ($item in $items) {
        $handle = $null
        try {
          $handle = [System.IO.File]::Open(
            [string]$item,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::None
          )
        } finally {
          if ($null -ne $handle) { $handle.Dispose() }
        }
      }
      exit 0
    } catch {
      [Console]::Error.WriteLine($_.Exception.Message)
      exit 1
    }
  `;

  const encoded = Buffer.from(script, "utf16le").toString("base64");

  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );

  await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true }
    );

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          "Un fichier est utilisé, inaccessible ou verrouillé. " +
          "Ferme les programmes qui utilisent la sauvegarde. " +
          stderr.trim()
        ));
      }
    });

    // Le contenu transmis à PowerShell reste de la donnée JSON,
    // pas une commande construite avec les chemins.
    const json = JSON.stringify(files);
    const escapedJson = json.replace(
      /[\u007f-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    );

    child.stdin.end(escapedJson);
  });
}

async function prepareImport({ source, storageRoot, dataPath, metadata }) {
  const journalPath = path.join(dataPath, "import-journal.json");

  if (await exists(journalPath)) {
    throw new Error(
      "Un journal d’import précédent est présent. " +
      "Un contrôle est nécessaire avant un nouvel import. " +
      "Ne supprime pas ce journal sans vérifier les chemins qu’il contient."
    );
  }

  const modpackName = validateName(metadata.modpackName, "Nom du modpack");
  const backupName = validateName(metadata.backupName, "Nom de la sauvegarde");
  const savedAt = validateSavedAt(metadata.savedAt);

  if (!["solo", "server"].includes(metadata.playType)) {
    throw new Error("Type de partie invalide.");
  }

  if (!STATUSES.has(metadata.status)) {
    throw new Error("Statut invalide.");
  }

  const sourcePath = await fs.realpath(source.path);
  const root = await fs.realpath(storageRoot);

  if (isInside(root, sourcePath) || isInside(sourcePath, root)) {
    throw new Error("La source et la bibliothèque ne doivent pas se contenir.");
  }

  const sourceStat = await fs.lstat(source.path);

  if (sourceStat.isSymbolicLink()) {
    throw new Error("Sélectionne la source réelle, pas un lien.");
  }

  if (
    (source.type === "directory" && !sourceStat.isDirectory()) ||
    (
      source.type === "zip" &&
      (!sourceStat.isFile() || path.extname(source.path).toLowerCase() !== ".zip")
    )
  ) {
    throw new Error("Le type de la source a changé depuis la sélection.");
  }

  const entries = await inventory(sourcePath);
  const sizeBytes = entries.reduce(
    (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
    0
  );

  const libraryPath = path.join(dataPath, "library.json");
  const library = JSON.parse(await fs.readFile(libraryPath, "utf8"));

  if (!Array.isArray(library.modpacks) || !Array.isArray(library.backups)) {
    throw new Error("La structure de library.json est invalide.");
  }

  const existingModpack = library.modpacks.find(
    (item) =>
      item.name.toLocaleLowerCase("fr-FR") ===
      modpackName.toLocaleLowerCase("fr-FR")
  );

  const folderName = validateName(
    existingModpack ? existingModpack.name : modpackName,
    "Nom du dossier modpack"
  );

  const id = randomUUID();
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");

  const parent = path.join(root, "backups", folderName);
  const destination = path.join(parent, `${date}_${backupName}_${id.slice(0, 8)}`);
  const staging = path.join(root, "backups", `.import-${id}`);
  const sourceName = path.basename(sourcePath);

  if (await exists(destination)) {
    throw new Error("La destination existe déjà.");
  }

  return {
    id,
    sourcePath,
    sourceName,
    sourceType: source.type,
    root,
    parent,
    destination,
    staging,
    payload: path.join(staging, sourceName),
    finalPayload: path.join(destination, sourceName),
    journalPath,
    libraryPath,
    library,
    existingModpack,
    entries,
    sizeBytes,
    createdAt: now.toISOString(),
    metadata: {
      modpackName: folderName,
      backupName,
      savedAt,
      playType: metadata.playType,
      status: metadata.status
    }
  };
}

async function copyInventory(plan, notify) {
  let copiedBytes = 0;
  let lastUpdate = 0;

  for (const entry of plan.entries) {
    const source = entry.relative
      ? path.join(plan.sourcePath, entry.relative)
      : plan.sourcePath;

    const target = entry.relative
      ? path.join(plan.payload, entry.relative)
      : plan.payload;

    if (entry.type === "directory") {
      await fs.mkdir(target, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });

    const meter = new Transform({
      transform(chunk, encoding, callback) {
        copiedBytes += chunk.length;

        if (Date.now() - lastUpdate > 150) {
          lastUpdate = Date.now();

          notify({
            phase: "copy",
            message: "Copie vers le disque de destination...",
            percent: plan.sizeBytes
              ? Math.min(100, Math.floor(copiedBytes / plan.sizeBytes * 100))
              : 0
          });
        }

        callback(null, chunk);
      }
    });

    await pipeline(
      createReadStream(source),
      meter,
      createWriteStream(target, { flags: "wx" })
    );
  }
}

function getFriendlyImportError(error) {
  switch (error.code) {
    case "EPERM":
    case "EACCES":
      return "Un fichier est utilisé, verrouillé ou inaccessible. " +
        "Ferme les programmes qui utilisent la sauvegarde, " +
        "puis réessaie.";

    case "EBUSY":
      return "La sauvegarde est actuellement utilisée par un autre programme. " +
        "Ferme Minecraft, le launcher et les programmes concernés, " +
        "puis réessaie.";

    case "ENOENT":
      return "La sauvegarde ou son emplacement n’est plus disponible. " +
        "Vérifie que le dossier ou l’archive ZIP existe toujours.";

    case "ENOSPC":
      return "Le disque de destination ne dispose pas de suffisamment d’espace libre.";

    default:
      return "L’import n’a pas pu être terminé.";
  }
}

async function executeImport(plan, notify) {
  let mode = null;
  let finalized = false;
  let indexed = false;
  let journalCreated = false;

  const journal = {
    id: plan.id,
    source: plan.sourcePath,
    staging: plan.staging,
    destination: plan.destination,
    libraryPath: plan.libraryPath,
    phase: "prepared"
  };

  async function updateJournal(phase) {
    journal.phase = phase;
    journal.mode = mode;
    await writeJson(plan.journalPath, journal);
  }

  try {
    notify({ message: "Contrôle des fichiers utilisés...", percent: null });

    await checkWindowsLocks(plan.sourcePath, plan.entries);

    compareInventories(
      plan.entries,
      await inventory(plan.sourcePath),
      true
    );

    await fs.mkdir(plan.parent, { recursive: true });

    if (await exists(plan.destination)) {
      throw new Error("La destination n’est plus disponible.");
    }

    await fs.writeFile(
      plan.journalPath,
      JSON.stringify(journal, null, 2),
      { encoding: "utf8", flag: "wx" }
    );

    journalCreated = true;

    await fs.mkdir(plan.staging);

    // L’intention est écrite avant de modifier la source.
    mode = "rename";
    await updateJournal("moving");

    notify({ message: "Déplacement de la sauvegarde...", percent: null });

    try {
      await fs.rename(plan.sourcePath, plan.payload);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;

      mode = "copy";
      await updateJournal("copying");
      await copyInventory(plan, notify);
    }

    notify({ message: "Vérification du transfert...", percent: null });

    compareInventories(
      plan.entries,
      await inventory(plan.payload),
      false
    );

    if (mode === "copy") {
      compareInventories(
        plan.entries,
        await inventory(plan.sourcePath),
        true
      );

      await checkWindowsLocks(plan.sourcePath, plan.entries);
    }

    await updateJournal("finalizing");

    if (await exists(plan.destination)) {
      throw new Error("La destination existe déjà.");
    }

    await fs.rename(plan.staging, plan.destination);
    finalized = true;

    await updateJournal("indexing");

    notify({ message: "Enregistrement dans la bibliothèque...", percent: null });

    let modpack = plan.existingModpack;

    if (!modpack) {
      modpack = {
        id: randomUUID(),
        name: plan.metadata.modpackName,
        status: plan.metadata.status,
        tags: [],
        notes: "",
        createdAt: plan.createdAt
      };

      plan.library.modpacks.push(modpack);
    }

    // Pour un modpack déjà connu, son statut et son type existants
    // ne sont pas modifiés silencieusement par cet import.
    modpack.updatedAt = plan.createdAt;
    modpack.lastBackupAt = plan.createdAt;

    const backup = {
      id: plan.id,
      modpackId: modpack.id,
      name: plan.metadata.backupName,
      status: "in_progress",
      type: plan.metadata.playType,
      notes: "",
      tags: [],
      updatedAt: plan.createdAt,
      format: plan.sourceType,
      importedAt: plan.createdAt,
      savedAt: plan.metadata.savedAt,
      savedAtSource: "manual",
      sizeBytes: plan.sizeBytes,
      path: plan.finalPayload,
      containerPath: plan.destination,
      originalName: plan.sourceName
    };

    plan.library.backups.push(backup);

    await writeJson(plan.libraryPath, plan.library);
    indexed = true;

    await updateJournal("indexed");

    if (mode === "copy") {
      // Dernier contrôle avant toute suppression de la source.
      compareInventories(
        plan.entries,
        await inventory(plan.sourcePath),
        true
      );

      await checkWindowsLocks(plan.sourcePath, plan.entries);
      await updateJournal("removing-source");

      notify({ message: "Finalisation du déplacement...", percent: null });

      await fs.rm(plan.sourcePath, { recursive: true, force: false });
    }

    await updateJournal("complete");
    await fs.unlink(plan.journalPath);

    notify({ message: "Import terminé.", percent: 100 });

    return {
      success: true,
      backup,
      message: "Sauvegarde déplacée et indexée."
    };
  } catch (error) {
    let rollbackError = null;

    if (indexed) {
      // La destination valide est déjà référencée par library.json.
      // Ne jamais la supprimer pour tenter un retour en arrière.
      return {
        success: false,
        committed: true,
        message:
          "La sauvegarde est présente et indexée dans MCVault, " +
          "mais la finalisation nécessite un contrôle. " +
          "La source peut encore exister ou être partiellement nettoyée. " +
          `Détail : ${error.message}. ` +
          `Journal : ${plan.journalPath}`
      };
    }

    try {
      if (mode === "rename") {
        const currentPayload = finalized
          ? plan.finalPayload
          : plan.payload;

        if (await exists(currentPayload)) {
          if (await exists(plan.sourcePath)) {
            throw new Error(
              "Le chemin source existe de nouveau : retour automatique refusé."
            );
          }

          await fs.rename(currentPayload, plan.sourcePath);
        }
      }

      const container = finalized ? plan.destination : plan.staging;

      if (journalCreated && await exists(container)) {
        await fs.rm(container, { recursive: true, force: false });
      }

      if (journalCreated) {
        await fs.unlink(plan.journalPath);
      }
    } catch (rollbackError) {
      throw new Error(
        `${error.message} Retour automatique incomplet : ` +
        `${rollbackFailure.message}. Conserve les fichiers et consulte ` +
        `${plan.journalPath}`
      );
    }

    const friendlyMessage = getFriendlyImportError(error);

    const importError = new Error(
      `${friendlyMessage} ` +
      "L’import n’a pas été validé. " +
      "MCVault n’a pas supprimé la source."
    );

    importError.detail = [
      `Erreur technique : ${error.message}`,
      rollbackError
        ? `Retour automatique incomplet : ${rollbackError.message}`
        : null,
      `Journal d’import : ${plan.journalPath}`
    ]
      .filter(Boolean)
      .join("\n");

    importError.journalPath = plan.journalPath;

    throw importError;
  }
}

module.exports = {
  prepareImport,
  executeImport
};