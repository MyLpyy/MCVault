"use strict";

(() => {
    const input = document.getElementById("import-modpack");
    const options = document.getElementById("import-modpack-options");
    const help = document.getElementById("import-modpack-help");

    let knownModpacks = [];
    let loading = false;
    let available = false;

    function normalizeName(value) {
        return value.trim().toLocaleLowerCase("fr-FR");
    }

    function updateHelp() {
        const name = input.value.trim();

        if (!available) {
            help.textContent =
                "Suggestions indisponibles. Tu peux saisir un nom : " +
                "MCVault vérifiera le modpack lors de l’import.";
            return;
        }

        if (!name) {
            help.textContent =
                "Sélectionne un modpack connu ou saisis un nouveau nom.";
            return;
        }

        const existing = knownModpacks.find(
            (modpack) =>
                normalizeName(modpack.name) === normalizeName(name)
        );

        help.textContent = existing
            ? `Modpack existant : ${existing.name}.`
            : `Nouveau modpack : ${name}. Il sera créé si l’import réussit.`;
    }

    async function refreshOptions() {
        if (loading) return;

        loading = true;

        try {
            const result = await window.mcvault.getLibrary();

            if (!result.success) {
                throw new Error(
                    result.message || "Impossible de lire la bibliothèque."
                );
            }

            knownModpacks = result.library.modpacks
                .filter(
                    (modpack) =>
                        typeof modpack.name === "string" &&
                        modpack.name.trim() !== ""
                )
                .sort((a, b) =>
                    a.name.localeCompare(b.name, "fr", {
                        numeric: true,
                        sensitivity: "base"
                    })
                );

            const fragment = document.createDocumentFragment();
            const seen = new Set();

            for (const modpack of knownModpacks) {
                const key = normalizeName(modpack.name);

                if (seen.has(key)) continue;

                seen.add(key);

                const option = document.createElement("option");
                option.value = modpack.name;

                fragment.append(option);
            }

            options.replaceChildren(fragment);
            available = true;
        } catch (error) {
            available = false;
            knownModpacks = [];
            options.replaceChildren();

            console.error("Suggestions des modpacks :", error);
        } finally {
            loading = false;
            updateHelp();
        }
    }

    input.addEventListener("input", updateHelp);
    input.addEventListener("change", updateHelp);
    input.addEventListener("focus", refreshOptions);

    window.addEventListener(
        "mcvault:library-updated",
        refreshOptions
    );

    refreshOptions();
})();