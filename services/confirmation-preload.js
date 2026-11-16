"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vaultConfirmation", {
    onContent: (callback) => {
        ipcRenderer.once(
            "vault-confirmation:content",
            (_event, content) => callback(content)
        );
    },

    answer: (response) => {
        if (response !== 0 && response !== 1) {
            return;
        }

        ipcRenderer.send(
            "vault-confirmation:answer",
            response
        );
    }
});