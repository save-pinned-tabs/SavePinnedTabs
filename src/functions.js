import { appendTabSet, createStartupAutoload, loadTabSet, runWindowOperation, setActiveTabSet } from './autoload.mjs';

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

export var Sets = (function () {


    var windowId = null;
    browser.windows.getCurrent().then(function (win) {
        windowId = win.id;
    });


    return {
        save: async function (name, autoload) {
            const winid = windowId ?? (await browser.windows.getCurrent()).id;
            return runWindowOperation(winid, async function () {
                var urilist = [];
                const tabs = await browser.tabs.query({
                    pinned: true,
                    windowId: winid
                });
                for (var i = 0; i < tabs.length; i++) {
                    urilist[i] = tabs[i].url;
                }
                if (urilist.length === 0) {
                    console.log('No pinned tabs found!');
                    return;
                }

                var saveObj = {};
                var uid = window.btoa(name);
                saveObj[uid] = {
                    set_name: name,
                    autoload: autoload || 0,
                    tabs: urilist
                };
                await browser.storage.sync.set(saveObj);
                await setActiveTabSet(browser, winid, uid);
                refreshPopup();
            });
        },
        load: function (id, winid) {
            return loadTabSet(browser, id, winid).then(function () {
                console.log('Loaded tabs');
                refreshPopup();
            });
        },
        append: function (id, winid) {
            return appendTabSet(browser, id, winid).then(refreshPopup);
        },
        delete: async function (id) {
            if (!await confirmDelete()) return;

            await browser.storage.sync.remove(id);
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

                        const appendButton = document.createElement('button');
                        appendButton.classList.add('set-append');
                        appendButton.textContent = 'Append';
                        appendButton.addEventListener('click', function () {
                            Sets.append(property, winid);
                        });
                        rowElement.appendChild(appendButton);

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
            browser.storage.sync.get(null).then(function (sets) {
        		for (var property in sets) {
        			if (sets.hasOwnProperty(property)) {
        				if (id && property == id) sets[property].autoload = 1;
        				else sets[property].autoload = 0;
        			}
        		}
        		browser.storage.sync.set(sets).then(function () {
        			window.location.href = "popup.html";
        		});
        	});
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

			return browser.storage.sync.set(sets);
		},
    }
})();

export var Autoload = createStartupAutoload(browser);
