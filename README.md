# Save Pinned Tabs

A browser extension to save and load groups of pinned tabs

## Features

- Save groups of pinned tabs
- Load groups of pinned tabs
- Autoload a group of pinned tabs on browser startup
- Update and delete saved tab groups
- Import and export tab groups as JSON backups
- Sync saved tab groups through browser extension storage

### Restoring tab sets

Loading a set attempts every saved URL. Tabs the browser can create and pin are restored in their saved relative order. If any creation or pinning fails, the popup reports the restored/total count and each failed URL and reason, including failures to clean up an unpinned replacement. If every tab fails, existing pinned tabs are retained. The saved set is not changed, so skipped URLs can be retried later.

Autoload uses the same restoration behavior and reports per-tab failures in the extension's background console. Storage, session, and other operation-wide failures remain errors rather than skipped tabs.

Restoration counts reflect browser tab-creation and pinning API results, not successful navigation. A browser may create a tab for an unavailable page or deleted local file and show a navigation error afterward; that is separate from an API rejection.

Deleted-file investigation: Chromium 149.0.7827.200 created and pinned the deleted-file tab, then displayed `ERR_FILE_NOT_FOUND`. Firefox 146.0 rejected the file URL with `Illegal URL` and restored the other tabs, but also rejected that URL while the file existed; this reflects file-URL restrictions, not deletion-specific handling. The original reporter's browser/version is unknown, so the exact deleted-file trigger is not confirmed fixed.

Permanent Chromium and Firefox end-to-end tests save a real local HTML file between valid tabs, close the saved tabs, and restore the set both while the file exists and after deleting it. They check pinned order, unchanged saved URLs, and browser-specific feedback: Chromium accepts the file tab but shows a navigation error after deletion; Firefox reports its file-URL API rejection in both scenarios. Chromium scenarios require extension access to file URLs.

## Installation

- [Chrome Web Store](https://chrome.google.com/webstore/detail/save-pinned-tabs/anmidgajdonkgmmilbccfefkfieajakd)

- [Firefox Addons](https://addons.mozilla.org/en-US/firefox/addon/save-pinned-tabs/)

- [Edge Addons](https://microsoftedge.microsoft.com/addons/detail/ahejjkehekfnjbpaaochgfbmbajocdkn)

## Manual Installation
  1. Download the latest zip file from [Releases](https://github.com/jmakila/save-pinned-tabs/releases)
  2. Extract the zip file into a new directory
  3. Open your chromium-based browser and navigate to `chrome://extensions`
  4. Enable Developer Mode and click "Load Unpacked"
  5. Select the new directory with the extracated zip file

## Support Our Work

This project will always be free and open source. If you appreciate it and want to support our work with a donation, please [visit our OpenCollective](https://opencollective.com/save-pinned-tabs). Thank you!

### Code Contributors

This project exists thanks to all the people who contribute. [[Contribute](CONTRIBUTING.md)].
<a href="https://github.com/save-pinned-tabs/SavePinnedTabs/graphs/contributors"><img src="https://opencollective.com/save-pinned-tabs/contributors.svg?width=890&button=false" /></a>

### Financial Contributors

Become a financial contributor and help us sustain our community. [[Contribute](https://opencollective.com/save-pinned-tabs/contribute)]

#### Individuals

<a href="https://opencollective.com/save-pinned-tabs"><img src="https://opencollective.com/save-pinned-tabs/individuals.svg?width=890"></a>

#### Organizations

Support this project with your organization. Your logo will show up here with a link to your website. [[Contribute](https://opencollective.com/save-pinned-tabs/contribute)]

<a href="https://opencollective.com/save-pinned-tabs/organization/0/website"><img src="https://opencollective.com/save-pinned-tabs/organization/0/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/1/website"><img src="https://opencollective.com/save-pinned-tabs/organization/1/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/2/website"><img src="https://opencollective.com/save-pinned-tabs/organization/2/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/3/website"><img src="https://opencollective.com/save-pinned-tabs/organization/3/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/4/website"><img src="https://opencollective.com/save-pinned-tabs/organization/4/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/5/website"><img src="https://opencollective.com/save-pinned-tabs/organization/5/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/6/website"><img src="https://opencollective.com/save-pinned-tabs/organization/6/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/7/website"><img src="https://opencollective.com/save-pinned-tabs/organization/7/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/8/website"><img src="https://opencollective.com/save-pinned-tabs/organization/8/avatar.svg"></a>
<a href="https://opencollective.com/save-pinned-tabs/organization/9/website"><img src="https://opencollective.com/save-pinned-tabs/organization/9/avatar.svg"></a>
