import { Sets, saveWithFeedback } from "./functions.js";

var saveForm = document.getElementById('save-form');

saveForm.addEventListener('submit', function (event) {
	event.preventDefault();
	saveWithFeedback(document.getElementById('save-name').value);
});

document.getElementById('save-name').focus();
document.addEventListener('DOMContentLoaded', Sets.get);
