import { createBrowserRepositories } from './repositories.mjs';
import { createWindowTabStateClient } from './window-tab-state.mjs';

function confirmDelete() {
    var dialog = document.getElementById('delete-dialog');
    dialog.returnValue = '';
    dialog.showModal();

    return new Promise(function (resolve) {
        dialog.addEventListener('close', function () {
            resolve(dialog.returnValue === 'delete');
        }, { once: true });
    });
}

var browser = globalThis.browser ?? globalThis.chrome;
var repositories = createBrowserRepositories(browser);
var windowTabState = createWindowTabStateClient(browser);

function refreshPopup() {
    if (typeof window !== 'undefined') window.location.href = "popup.html";
}

export var Sets = (function () {


    var windowId = null;
    browser.windows.getCurrent().then(function (win) {
        windowId = win.id;
    });


    return {
        save: async function (name, autoload) {
            var winid = windowId ?? (await browser.windows.getCurrent()).id;
            var uid = window.btoa(name);
            var set = await windowTabState.captureAndSave(winid, uid, {
                name: name,
                autoload: autoload || 0,
            });
            if (!set) {
                console.log('No pinned tabs found!');
                return;
            }
            refreshPopup();
        },
        load: function (id, winid) {
            return windowTabState.replace(winid, id).then(function () {
                console.log('Loaded tabs');
                refreshPopup();
            });
        },
        append: function (id, winid) {
            return windowTabState.append(winid, id).then(refreshPopup);
        },
        unload: function (id, winid) {
            return windowTabState.unload(winid, id).then(refreshPopup);
        },
        delete: async function (id) {
            if (!await confirmDelete()) return;

            await repositories.tabSets.remove(id);
            window.location.href = "popup.html";
        },
        get: function () {
            repositories.tabSets.list().then(function (sets) {
                var winid = windowId;
                repositories.windowSessions.get(winid).then(function (active) {
                    var area = document.getElementById('load-area');
                    for (const property in sets) {
                        if (!sets.hasOwnProperty(property)) continue;

                        const row = sets[property];
                        const rowElement = document.createElement('div');
                        rowElement.classList.add('load-row');
                        if (active === property) rowElement.classList.add('active');
                        rowElement.dataset.id = property;
                        rowElement.dataset.name = row.set_name;
                        rowElement.dataset.autoload = row.autoload;

                        const nameElement = document.createElement('span');
                        nameElement.textContent = row.set_name;
                        rowElement.appendChild(nameElement);

                        const autoloadLabel = document.createElement('label');
                        const autoloadInput = document.createElement('input');
                        autoloadInput.type = 'checkbox';
                        autoloadInput.name = 'autoload';
                        autoloadInput.classList.add('autoload-radio');
                        autoloadInput.value = property;
                        autoloadInput.checked = Boolean(row.autoload);
                        autoloadInput.addEventListener('click', function () {
                            if (this.checked) Sets.setAutoload(this.value);
                            else Sets.setAutoload(false);
                        });
                        autoloadLabel.append(autoloadInput, document.createTextNode(' Autoload'));
                        rowElement.appendChild(autoloadLabel);

                        if (active === property) {
                            const saveButton = document.createElement('button');
                            saveButton.classList.add('set-save');
                            saveButton.textContent = 'Save';
                            saveButton.addEventListener('click', function () {
                                const auto = row.autoload == 1 ? 1 : 0;
                                Sets.save(row.set_name, auto);
                            });
                            rowElement.appendChild(saveButton);
                        }

                        const loadButton = document.createElement('button');
                        loadButton.classList.add('set-load');
                        loadButton.textContent = 'Load';
                        loadButton.addEventListener('click', function () {
                            Sets.load(property, winid);
                        });
                        rowElement.appendChild(loadButton);

                        const deleteButton = document.createElement('button');
                        deleteButton.classList.add('set-delete');
                        deleteButton.textContent = 'Del';
                        deleteButton.addEventListener('click', function () {
                            Sets.delete(property);
                        });
                        rowElement.appendChild(deleteButton);

                        area.appendChild(rowElement);
                    }

                    var plcelement = document.getElementById('placeholder')
                    if (plcelement && area.querySelector('.load-row')) plcelement.remove();

                });
        	});
        },
        setAutoload: function (id) {
            repositories.tabSets.setAutoload(id).then(function () {
                window.location.href = "popup.html";
            });
        },
		export: function () {
			var fileName = "SavePinnedTabs_export_" + new Date().toISOString().replaceAll(/[.:]/g, "-") + '.json';
			
			return repositories.tabSets.export().then(function (sets) {
				var fileText = JSON.stringify(sets);
				var fileBlob = new Blob([fileText], { type: "application/json;charset=utf-8" });
				saveAs(fileBlob, fileName);
			});
		},
		import: function (sets) {
			return repositories.tabSets.import(sets);
		},
    }
})();
