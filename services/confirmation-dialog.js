"use strict";

const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

let activeConfirmation = null;

function showVaultConfirmation(parent, options = {}) {
    if (
        activeConfirmation ||
        !parent ||
        parent.isDestroyed()
    ) {
        return Promise.resolve({ response: 1 });
    }

    return new Promise((resolve) => {
        const confirmationWindow = new BrowserWindow({
            parent,
            modal: true,
            width: 540,
            height: Number.isInteger(options.height)
                ? Math.min(700, Math.max(360, options.height))
                : 360,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            frame: false,
            show: false,
            autoHideMenuBar: true,
            backgroundColor: "#0b1120",
            title: options.title || "Confirmation MCVault",
            webPreferences: {
                preload: path.join(
                    __dirname,
                    "confirmation-preload.js"
                ),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });

        activeConfirmation = confirmationWindow;
        let settled = false;

        const finish = (response = 1) => {
            if (settled) {
                return;
            }

            settled = true;
            ipcMain.removeListener(
                "vault-confirmation:answer",
                onAnswer
            );

            activeConfirmation = null;

            if (!confirmationWindow.isDestroyed()) {
                confirmationWindow.destroy();
            }

            resolve({ response });
        };

        const onAnswer = (event, response) => {
            if (
                confirmationWindow.isDestroyed() ||
                event.sender !== confirmationWindow.webContents ||
                event.senderFrame !==
                confirmationWindow.webContents.mainFrame
            ) {
                return;
            }

            if (response !== 0 && response !== 1) {
                return;
            }

            finish(response);
        };

        ipcMain.on("vault-confirmation:answer", onAnswer);

        confirmationWindow.webContents.setWindowOpenHandler(
            () => ({ action: "deny" })
        );

        confirmationWindow.webContents.on(
            "will-navigate",
            (event) => event.preventDefault()
        );

        confirmationWindow.webContents.on(
            "render-process-gone",
            () => finish(1)
        );

        confirmationWindow.once("closed", () => finish(1));

        confirmationWindow.webContents.once(
            "did-finish-load",
            () => {
                if (settled || confirmationWindow.isDestroyed()) {
                    return;
                }

                confirmationWindow.webContents.send(
                    "vault-confirmation:content",
                    {
                        title: String(
                            options.title || "Confirmation"
                        ),
                        message: String(options.message || ""),
                        detail: String(options.detail || ""),
                        confirmLabel: String(
                            options.confirmLabel || "Confirmer"
                        ),
                        cancelLabel: String(
                            options.cancelLabel || "Annuler"
                        ),
                        tone: options.tone === "neutral" ? "neutral" : "danger"
                    }
                );

                confirmationWindow.show();
                confirmationWindow.focus();
            }
        );

        confirmationWindow.loadFile(
            path.join(
                __dirname,
                "..",
                "src",
                "confirmation.html"
            )
        ).catch((error) => {
            console.error(
                "Chargement de la confirmation impossible :",
                error
            );

            finish(1);
        });
    });
}

async function showVaultMessageBox(parent, options = {}) {
    const buttons = options.buttons;

    // Cet adaptateur ne prend en charge que :
    // bouton 0 = confirmer ; bouton 1 = annuler.
    if (
        !Array.isArray(buttons) ||
        buttons.length !== 2 ||
        options.cancelId !== 1
    ) {
        console.error(
            "Configuration de confirmation non prise en charge :",
            options.title
        );

        return { response: 1 };
    }

    const title = String(options.title || "Confirmation");
    const destructive = /corbeille|supprim|abandon/i.test(
        `${title} ${buttons[0]}`
    );

    const isImport = /déplacement/i.test(title);
    const isStorage = /dossier|stockage/i.test(title);

    return showVaultConfirmation(parent, {
        title,
        message: options.message,
        detail: options.detail,
        confirmLabel: buttons[0],
        cancelLabel: buttons[1],
        tone: destructive ? "danger" : "neutral",
        height: isImport ? 620 : isStorage ? 480 : 360
    });
}

module.exports = {
    showVaultConfirmation,
    showVaultMessageBox
};