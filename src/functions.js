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
    if (typeof window !== 'undefined') window.location.href = 'popup.html';
}

export var Sets = (function () {
    var windowId = null;
    browser.windows.getCurrent().then(function (win) {
        windowId = win.id;
    });

    return {
        save: async function (name, id) {
            var winid = windowId ?? (await browser.windows.getCurrent()).id;
            var set = await windowTabState.captureAndSave(winid, { id, name: name });
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
            window.location.href = 'popup.html';
        },
        get: async function () {
            const currentWindowId = windowId ?? (await browser.windows.getCurrent()).id;
            const [sets, active, autoload] = await Promise.all([
                repositories.tabSets.list(),
                repositories.windowSessions.get(currentWindowId),
                repositories.tabSets.getAutoload(),
            ]);
            const autoloadIds = new Set(autoload.setIds);
            var area = document.getElementById('load-area');
            for (const set of sets) {
                const rowElement = document.createElement('div');
                rowElement.classList.add('load-row');
                if (active === set.id) rowElement.classList.add('active');
                rowElement.dataset.id = set.id;
                rowElement.dataset.name = set.name;

                const nameElement = document.createElement('span');
                nameElement.textContent = set.name;
                rowElement.appendChild(nameElement);

                const autoloadLabel = document.createElement('label');
                const autoloadInput = document.createElement('input');
                autoloadInput.type = 'checkbox';
                autoloadInput.name = 'autoload';
                autoloadInput.classList.add('autoload-radio');
                autoloadInput.value = set.id;
                autoloadInput.checked = autoloadIds.has(set.id);
                autoloadInput.addEventListener('click', function () {
                    Sets.setAutoload(this.value, this.checked);
                });
                autoloadLabel.append(autoloadInput, document.createTextNode(' Autoload'));
                rowElement.appendChild(autoloadLabel);

                if (active === set.id) {
                    const saveButton = document.createElement('button');
                    saveButton.classList.add('set-save');
                    saveButton.textContent = 'Save';
                    saveButton.addEventListener('click', function () {
                        Sets.save(set.name, set.id).catch(console.error);
                    });
                    rowElement.appendChild(saveButton);
                }

                const loadButton = document.createElement('button');
                loadButton.classList.add('set-load');
                loadButton.textContent = 'Load';
                loadButton.addEventListener('click', function () {
                    Sets.load(set.id, currentWindowId);
                });
                rowElement.appendChild(loadButton);

                const deleteButton = document.createElement('button');
                deleteButton.classList.add('set-delete');
                deleteButton.textContent = 'Del';
                deleteButton.addEventListener('click', function () {
                    Sets.delete(set.id);
                });
                rowElement.appendChild(deleteButton);
                area.appendChild(rowElement);
            }

            var placeholder = document.getElementById('placeholder');
            if (placeholder && area.querySelector('.load-row')) placeholder.remove();
        },
        setAutoload: async function (id, enabled) {
            const configuration = await repositories.tabSets.getAutoload();
            const setIds = new Set(configuration.setIds);
            if (enabled) setIds.add(id);
            else setIds.delete(id);
            await repositories.tabSets.setAutoload({
                scope: configuration.scope,
                setIds: [...setIds],
            });
            window.location.href = 'popup.html';
        },
        export: function () {
            var fileName = 'SavePinnedTabs_export_' + new Date().toISOString().replaceAll(/[.:]/g, '-') + '.json';
            return repositories.tabSets.export().then(function (document) {
                var fileText = JSON.stringify(document);
                var fileBlob = new Blob([fileText], { type: 'application/json;charset=utf-8' });
                saveAs(fileBlob, fileName);
            });
        },
        import: function (document) {
            return repositories.tabSets.import(document);
        },
    };
})();
