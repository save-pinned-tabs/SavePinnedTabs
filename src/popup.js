import { Sets } from "./functions.js";

document.getElementById('save-button').addEventListener('click', function () {
	var name = document.getElementById('save-name').value;
	if (name) Sets.save(name);
});
document.getElementById('save-name').addEventListener('keydown', function (event) {
	if (event.keyCode == 13) {
		var name = document.getElementById('save-name').value;
		if (name) Sets.save(name);
	}
});
document.getElementById('save-name').focus();
document.getElementById('rename-form').addEventListener('submit', function (event) {
	event.preventDefault();
	if (!document.getElementById('save-rename-button').disabled) Sets.saveRename();
});
document.getElementById('rename-dialog').addEventListener('cancel', function (event) {
	if (document.getElementById('save-rename-button').disabled) event.preventDefault();
});
document.getElementById('cancel-rename-button').addEventListener('click', function () {
	document.getElementById('rename-dialog').close();
});
document.addEventListener('DOMContentLoaded', Sets.get);
