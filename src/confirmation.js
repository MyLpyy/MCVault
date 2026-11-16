"use strict";

(() => {
    const title = document.getElementById(
        "confirmation-title"
    );

    const message = document.getElementById(
        "confirmation-message"
    );

    const detail = document.getElementById(
        "confirmation-detail"
    );

    const closeButton = document.getElementById(
        "confirmation-close"
    );

    const cancelButton = document.getElementById(
        "confirmation-cancel"
    );

    const acceptButton = document.getElementById(
        "confirmation-accept"
    );

    let answered = false;

    function answer(response) {
        if (answered) {
            return;
        }

        answered = true;

        for (const button of [
            closeButton,
            cancelButton,
            acceptButton
        ]) {
            button.disabled = true;
        }

        window.vaultConfirmation.answer(response);
    }

    closeButton.addEventListener(
        "click",
        () => answer(1)
    );

    cancelButton.addEventListener(
        "click",
        () => answer(1)
    );

    acceptButton.addEventListener(
        "click",
        () => answer(0)
    );

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            answer(1);
        }
    });

    window.vaultConfirmation.onContent((content) => {
        document.title = content.title;

        title.textContent = content.title;
        message.textContent = content.message;
        detail.textContent = content.detail;

        cancelButton.textContent = content.cancelLabel;
        acceptButton.textContent = content.confirmLabel;

        document.documentElement.dataset.tone = content.tone;

        cancelButton.focus();
    });

    window.addEventListener("focus", () => {
        if (!answered) {
            cancelButton.focus();
        }
    });
})();