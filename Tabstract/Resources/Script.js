function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerHTML = "Tabstract is <em class=\"enabled\">enabled</em> and ready to use!<br> You can safely close this window.";
        document.getElementsByClassName('state-off')[0].innerHTML = "Tabstract is <em class=\"disabled\">disabled</em>.<br> Enable it in Safari Settings to start saving tabs.";
        document.getElementsByClassName('state-unknown')[0].innerHTML = "Turn on Tabstract's extension in Safari Settings to get started.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Open Safari Settings";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
