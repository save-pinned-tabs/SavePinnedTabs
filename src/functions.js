import { createStartupAutoload, loadTabSet } from './autoload.mjs';
import Swal from './lib/sweetalert2.esm.min.js';

var browser = globalThis.browser ?? globalThis.chrome;

function refreshPopup() {
    if (typeof window !== 'undefined') window.location.href = "popup.html";
}

export var Sets = (function () {


    var windowId = null;
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
        save: function (name, autoload) {
            var urilist = [];
        	browser.tabs.query({
        		pinned: true,
        		currentWindow: true
        	}).then(function (tabs) {
        		for (var i = 0; i < tabs.length; i++) {
        			urilist[i] = tabs[i].url;
        		}
        		if (urilist.length > 0) {
        			var saveObj = {};
        			var uid = window.btoa(name);
        			saveObj[uid] = {
        				set_name: name,
        				autoload: autoload || 0,
        				tabs: urilist
        			};
                    browser.storage.sync.set(saveObj)
                        .then(function () { return set_active(uid, windowId); })
                        .then(refreshPopup);
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
        delete: function (id) {
			Swal.fire({
				showCancelButton: true,
				confirmButtonText: 'Delete',
				cancelButtonText: 'Cancel',
				customClass: {
					popup: 'confirm-delete-dialog'
				},
				text: "Do you really want to delete this tab set?",
			}).then(function (result) {
				if (result.isConfirmed) browser.storage.sync.remove(id).then(function () {
					window.location.href = "popup.html";
				});
			});
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
