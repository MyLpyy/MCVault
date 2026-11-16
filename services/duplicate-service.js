"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// Limites sur la quantité de métadonnées analysées.
// Elles ne limitent pas la taille en octets des sauvegardes.
const MAX_ENTRIES_PER_BACKUP = 100000;
const MAX_ENTRIES_PER_SCAN = 500000;
const MAX_SIGNATURE_LENGTH = 8 * 1024 * 1024;

function isStrictlyInside(parent, child) {
  const relative = path.relative(parent, child);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function describeBackup(backup, allowedRoot, budget) {
  const originalStats = await fs.lstat(backup.path);

  if (originalStats.isSymbolicLink()) {
    throw new Error("Lien symbolique ou jonction non pris en charge.");
  }

  const realPath = await fs.realpath(backup.path);

  if (!isStrictlyInside(allowedRoot, realPath)) {
    throw new Error("Emplacement en dehors du stockage autorisé.");
  }

  const entries = [];
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  let signatureLength = 0;

  async function visit(absolute, relative) {
    entryCount++;
    budget.used++;

    if (entryCount > MAX_ENTRIES_PER_BACKUP) {
      throw new Error(
        "Limite de 100 000 éléments atteinte pour cette sauvegarde."
      );
    }

    if (budget.used > MAX_ENTRIES_PER_SCAN) {
      throw new Error(
        "Budget global de 500 000 éléments atteint pour cette analyse."
      );
    }

    const stats = await fs.lstat(absolute);

    if (stats.isSymbolicLink()) {
      throw new Error(
        `Lien symbolique ou jonction rencontré : ${relative || "racine"}`
      );
    }

    let entry;

    if (stats.isDirectory()) {
      entry = ["directory", relative];
    } else if (stats.isFile()) {
      entry = ["file", relative, stats.size];
      fileCount++;
      totalBytes += stats.size;
    } else {
      throw new Error("Type de fichier non pris en charge.");
    }

    const encoded = JSON.stringify(entry);
    signatureLength += encoded.length + 1;

    if (signatureLength > MAX_SIGNATURE_LENGTH) {
      throw new Error("Description de l’arborescence trop volumineuse.");
    }

    entries.push(encoded);

    if (stats.isDirectory()) {
      const directory = await fs.opendir(absolute);

      for await (const child of directory) {
        await visit(
          path.join(absolute, child.name),
          relative ? path.join(relative, child.name) : child.name
        );
      }
    }
  }

  if (backup.format === "zip") {
    if (!originalStats.isFile()) {
      throw new Error("L’archive indexée n’est plus un fichier.");
    }

    budget.used++;

    if (budget.used > MAX_ENTRIES_PER_SCAN) {
      throw new Error("Budget global d’analyse atteint.");
    }

    return {
      signature: JSON.stringify(["zip", originalStats.size]),
      sizeBytes: originalStats.size,
      fileCount: 1,
      empty: originalStats.size === 0
    };
  }

  if (backup.format !== "directory" || !originalStats.isDirectory()) {
    throw new Error("Le format ou le dossier indexé est invalide.");
  }

  await visit(realPath, "");

  entries.sort();

  return {
    // Description textuelle des métadonnées, pas un hash.
    signature: JSON.stringify(["directory", entries]),
    sizeBytes: totalBytes,
    fileCount,
    empty: fileCount === 0
  };
}

async function findPotentialDuplicates(library, storageRoot) {
  const allowedRoot = await fs.realpath(
    path.join(storageRoot, "backups")
  );

  const modpacks = new Map(
    library.modpacks.map((modpack) => [modpack.id, modpack])
  );

  const buckets = new Map();
  const skipped = [];
  const budget = { used: 0 };

  let analyzed = 0;

  for (const backup of library.backups) {
    try {
      if (budget.used >= MAX_ENTRIES_PER_SCAN) {
        throw new Error("Budget global d’analyse atteint.");
      }

      const description = await describeBackup(
        backup,
        allowedRoot,
        budget
      );

      analyzed++;

      const key = JSON.stringify([
        backup.modpackId,
        backup.format,
        description.signature
      ]);

      if (!buckets.has(key)) {
        buckets.set(key, {
          modpackId: backup.modpackId,
          modpackName: modpacks.get(backup.modpackId).name,
          format: backup.format,
          sizeBytes: description.sizeBytes,
          fileCount: description.fileCount,
          empty: description.empty,
          backups: []
        });
      }

      buckets.get(key).backups.push({
        id: backup.id,
        name: backup.name,
        importedAt: backup.importedAt,
        sizeBytes: description.sizeBytes
      });
    } catch (error) {
      skipped.push({
        id: backup.id,
        name: backup.name,
        reason: error.message
      });
    }
  }

  const groups = [...buckets.values()]
    .filter((group) => group.backups.length > 1);

  return {
    scannedAt: new Date().toISOString(),
    total: library.backups.length,
    analyzed,
    groups,
    skipped
  };
}

module.exports = { findPotentialDuplicates };