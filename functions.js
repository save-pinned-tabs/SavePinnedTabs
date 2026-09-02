import Swal from './lib/sweetalert2.esm.min.js';

export var Sets = (function () {

		var browser = globalThis.browser ?? globalThis.chrome;


    var windowId = null;
    var restoreErrorReportPromise = null;
    var withRestoreErrorsLock = function (callback) {
        return navigator.locks.request('restoreErrors', callback);
    };
    browser.windows.getCurrent().then(function (win) {
        windowId = win.id;
    });

    var set_active = function (id, winid) {
        return browser.storage.local.get(['activeTabs']).then(function(result) {
            var atabs = result.activeTabs || {};
            atabs[winid] = id;
            return browser.storage.local.set({'activeTabs': atabs}).then(function() {
                console.log('Active tabset for window '+winid+' is set to '+id);
                if (typeof window !== 'undefined') {
                    window.location.href = 'popup.html';
                }
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
        			browser.storage.sync.set(saveObj).then(function () {
        				set_active(uid, windowId);
        			});
        		} else {
        			console.log('No pinned tabs found!');
        		}
        	});
        },
        load: async function (id, winid) {
            var set = await browser.storage.sync.get(id);
            var tabs = set[id].tabs;
            var currentTabs = await browser.tabs.query({ pinned: true, windowId: winid });
            var tabIds = currentTabs.map(function (tab) { return tab.id; });

            if (tabIds.length > 0) {
                await browser.tabs.remove(tabIds);
            }

            var results = await Promise.all(tabs.map(async function (url) {
                try {
                    await browser.tabs.create({
                        windowId: winid,
                        url: url,
                        active: false,
                        pinned: true
                    });
                    return null;
                } catch (error) {
                    return {
                        url: url,
                        message: error && error.message ? error.message : String(error)
                    };
                }
            }));
            var restoreErrors = results.filter(function (result) { return result !== null; });

            await withRestoreErrorsLock(function () {
                if (restoreErrors.length > 0) {
                    return browser.storage.local.set({ restoreErrors: restoreErrors });
                }
                return browser.storage.local.remove('restoreErrors');
            });

            if (restoreErrors.length > 0) {
                console.log('Loaded tabs with '+restoreErrors.length+' error(s)');
            } else {
                console.log('Loaded tabs');
            }

            await set_active(id, winid);
        },
        reportRestoreErrors: function () {
            if (restoreErrorReportPromise) return restoreErrorReportPromise;

            restoreErrorReportPromise = (async function () {
                var restoreErrors = await withRestoreErrorsLock(async function () {
                    var result = await browser.storage.local.get(['restoreErrors']);
                    var errors = result.restoreErrors || [];
                    if (errors.length > 0) {
                        await browser.storage.local.remove('restoreErrors');
                    }
                    return errors;
                });
                if (restoreErrors.length === 0) return;

                var text = restoreErrors.map(function (error) {
                    return error.url + '\n' + error.message;
                }).join('\n\n');

                await swal({
                    title: 'Some tabs could not be restored',
                    text: text,
                    icon: 'error'
                });
            })().finally(function () {
                restoreErrorReportPromise = null;
            });

            return restoreErrorReportPromise;
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
        clearActive: function (winid) {
            set_active(null, winid);
        },
        autoLoad: function (winid) {
            browser.tabs.query({
                pinned: true,
                windowId: winid
            }).then(function (cutabs) {
                browser.storage.sync.get(null).then(function (sets) {
            		var autoloaded = false;
            		for (var property in sets) {
            			if (sets.hasOwnProperty(property)) {
            				var set = sets[property];
            				if (set.autoload == 1) { // there is a tab set to be autoloaded
                                console.log('Autoloading tabs');
            					autoloaded = true;
            					Sets.load(property, winid);
                                break;
            				}
            			}
            		}
            		if (!autoloaded) Sets.clearActive(winid);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export var Autoload = (function () {
  let ranOnce = false;
	var browser = globalThis.browser ?? globalThis.chrome;


  return {
    windowCreated: function (window) {
      console.log("windowCreated");
      ranOnce = true;

      browser.windows.getAll(null).then(function (windows) {
        if (windows.length < 2 && window.type === "normal") {
          Sets.autoLoad(window.id);
        }
      });
    },

    manual: async function () {
      // Brave workaround:
      //  wait a few milliseconds for browser.windows.onCreated to fire
      //  before checking if we need to manually run windowCreated
      //  to ensure brave does not load tab set twice
      await sleep(50);

      // Firefox workaround:
      //  browser.windows.onCreated does not fire reliably in Firefox
      //  so we run autoload manually, only if it has not been run before
      if (!ranOnce) {
        browser.windows.getCurrent().then(function (window) {
          Autoload.windowCreated(window);
        });
      }
    },
  };
})();
