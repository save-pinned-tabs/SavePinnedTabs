import { createStartupAutoload, loadTabSet } from './autoload.mjs';

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

function refreshPopup() {
    if (typeof window !== 'undefined') window.location.href = "popup.html";
}
function withTabSetsLock(operation) {
    return navigator.locks.request('saved-tab-sets', operation);
}
const UNSAFE_URL_PROTOCOLS = new Set(['data:', 'javascript:', 'vbscript:']);

function isLoadableUrl(value) {
    try {
        return !UNSAFE_URL_PROTOCOLS.has(new URL(value).protocol);
    } catch {
        return false;
    }
}


export var Sets = (function () {


    var windowId = null;
    var editGeneration = 0;
    browser.windows.getCurrent().then(function (win) {
        windowId = win.id;
    });

    var set_active = function (id, winid) {
        return browser.storage.local.get(['activeTabs']).then(function(result) {
            var atabs = result.activeTabs || {};
            atabs[winid] = id;
            return browser.storage.local.set({'activeTabs': atabs}).then(function() {
                console.log('Active tabset for window '+winid+' is set to '+id);
            });
        });
    }

    return {
        save: function (name, autoload, setId) {
            var urilist = [];
            return browser.tabs.query({
        		pinned: true,
        		currentWindow: true
        	}).then(function (tabs) {
        		for (var i = 0; i < tabs.length; i++) {
        			urilist[i] = tabs[i].url;
        		}
        		if (urilist.length > 0) {
                    return withTabSetsLock(async function () {
                        var uid = setId ?? crypto.randomUUID();
                        var existing = setId != null
                            ? (await browser.storage.sync.get(uid))[uid]
                            : undefined;
                        if (setId != null && !existing) {
                            refreshPopup();
                            return;
                        }
                        var saveObj = {};
                        saveObj[uid] = {
                            set_name: existing?.set_name ?? name,
                            autoload: autoload || 0,
                            tabs: urilist
                        };
                        await browser.storage.sync.set(saveObj);
                        await set_active(uid, windowId);
                        refreshPopup();
                    });
        		} else {
        			console.log('No pinned tabs found!');
        		}
        	});
        },
        load: function (id, winid) {
            return loadTabSet(browser, id, winid).then(function () {
                console.log('Loaded tabs');
                refreshPopup();
            });
        },
        delete: async function (id) {
            if (!await confirmDelete()) return;

            await withTabSetsLock(() => browser.storage.sync.remove(id));
            window.location.href = "popup.html";
        },
        get: function () {
            browser.storage.sync.get(null).then(function (sets) {
                var winid = windowId;
                browser.storage.local.get('activeTabs').then(function (result) {
                  var active = result.activeTabs ? result.activeTabs[winid] : null;
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
                        const editButton = document.createElement('button');
                        editButton.classList.add('set-edit');
                        editButton.textContent = '✎';
                        editButton.title = 'Edit';
                        editButton.setAttribute('aria-label', `Edit ${row.set_name}`);
                        editButton.addEventListener('click', function () {
                            Sets.edit(property);
                        });
                        rowElement.appendChild(editButton);

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
                                Sets.save(row.set_name, auto, property);
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
        edit: async function (id) {
            const generation = ++editGeneration;
            const dialog = document.getElementById('edit-dialog');
            const status = document.getElementById('edit-status');
            const saveButton = document.getElementById('save-edit-button');
            dialog.dataset.setId = id;
            document.getElementById('edit-dialog-title').textContent = 'Edit tab set';
            document.getElementById('edit-urls').value = '';
            document.getElementById('edit-name').value = '';
            status.textContent = 'Loading…';
            saveButton.disabled = true;
            dialog.showModal();

            try {
                const set = (await browser.storage.sync.get(id))[id];
                if (!dialog.open || editGeneration !== generation) return;
                if (!set) {
                    status.textContent = 'This tab set no longer exists.';
                    return;
                }
                document.getElementById('edit-name').value = set.set_name;
                document.getElementById('edit-urls').value = set.tabs.join('\n');
                status.textContent = '';
                saveButton.disabled = false;
            } catch {
                if (!dialog.open || editGeneration !== generation) return;
                status.textContent = 'Could not load this tab set. Please try again.';
            }
        },
        saveEdits: async function () {
            const dialog = document.getElementById('edit-dialog');
            const id = dialog.dataset.setId;
            const generation = editGeneration;
            const saveButton = document.getElementById('save-edit-button');
            const status = document.getElementById('edit-status');
            const cancelButton = dialog.querySelector('button[value="cancel"]');
            const name = document.getElementById('edit-name').value.trim();
            if (!name) {
                status.textContent = 'Enter a name for this tab set.';
                return;
            }
            const tabs = document.getElementById('edit-urls').value
                .split('\n')
                .map((url) => url.trim())
                .filter(Boolean);
            const invalidUrl = tabs.find((url) => !isLoadableUrl(url));
            if (invalidUrl) {
                status.textContent = `Invalid URL: ${invalidUrl}`;
                return;
            }
            saveButton.disabled = true;
            cancelButton.disabled = true;

            try {
                await withTabSetsLock(async function () {
                    const saved = await browser.storage.sync.get(id);
                    if (!dialog.open || editGeneration !== generation) return;
                    if (!saved[id]) {
                        status.textContent = 'This tab set no longer exists.';
                        saveButton.disabled = false;
                        cancelButton.disabled = false;
                        return;
                    }
                    saved[id].set_name = name;
                    saved[id].tabs = tabs;
                    await browser.storage.sync.set(saved);
                    if (!dialog.open || editGeneration !== generation) return;
                    dialog.close();
                    refreshPopup();
                });
            } catch {
                if (!dialog.open || editGeneration !== generation) return;
                saveButton.disabled = false;
                cancelButton.disabled = false;
                status.textContent = 'Could not save these changes. Please try again.';
            }
        },
        setAutoload: async function (id) {
            await withTabSetsLock(async function () {
                const sets = await browser.storage.sync.get(null);
                for (var property in sets) {
                    if (sets.hasOwnProperty(property)) {
                        if (id && property == id) sets[property].autoload = 1;
                        else sets[property].autoload = 0;
                    }
                }
                await browser.storage.sync.set(sets);
            });
            window.location.href = "popup.html";
        },
		export: function () {
			var fileName = "SavePinnedTabs_export_" + new Date().toISOString().replaceAll(/[.:]/g, "-") + '.json';
			
			return browser.storage.sync.get(null).then(function (sets) {
				var fileText = JSON.stringify(sets);
				var fileBlob = new Blob([fileText], { type: "application/json;charset=utf-8" });
				saveAs(fileBlob, fileName);
			});
		},
		import: function (sets) {
			if (!validate20(sets)) {
				return Promise.reject();
			}

			return withTabSetsLock(() => browser.storage.sync.set(sets));
		},
    }
})();

export var Autoload = createStartupAutoload(browser);
