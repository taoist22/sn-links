# Supernote Links Plugin

A powerful, native-feeling plugin for Supernote that supercharges your link management. Generate interactive index pages of all links inside a note, create external web links, link to specific pages of other note files seamlessly, and manage broken links with ease.

## Features

- **Links Index Generation**: Scans the current note for all links (text links, stroke links, and web links) and generates a clean, tappable index list right on the page.
- **Advanced File Linking**: Pick any `.note` or `.pdf` document on your device and create a link to it. 
  - **Page-Specific Jumping**: Automatically fetches the total pages of the selected note and lets you precisely choose which page to jump to using a visual selector.
  - **Absolute Routing**: Fixes native Supernote limitations to guarantee that links to external notes always land on the correct page.
- **Web Links**: Drop fully functional URLs directly into your notebooks.
- **Broken Link Management**: 
  - Automatically identifies links pointing to files that have been deleted or moved.
  - **Repair**: Visually re-map broken links to their new file destinations without having to recreate the link from scratch.
  - **Delete**: Safely scrub orphaned links off your pages.

## Installation

1. Download the latest `Links.snplg` file from the [Releases](https://github.com/) page.
2. Connect your Supernote to your computer or use the Supernote Cloud/Partner App.
3. Copy the `Links.snplg` file into the `MyStyle` folder on your Supernote device.
4. Install the plugin on your Supernote device by going to `Manage Plugins` and selecting `Links`.

## Usage

Once installed, you can launch the plugin at any time from the Plugins menu.

### 1. Generating an Index
- Navigate to a blank page in your note where you want your table of contents to live.
- Open the Links plugin and select the **Links page** tab.
- Tap **Insert Links**. The plugin will scan the entire notebook and drop a perfectly aligned, interactive index of every link onto your page.

### 2. Creating Web Links
- Go to the page where you want to insert a URL.
- Open the plugin and select the **Web link** tab.
- Type or paste your URL (e.g., `https://google.com`), give it an optional readable label, and tap **Add**.

### 3. Creating File Links
- Select the **File link** tab.
- Tap **Select File** to browse your Supernote's storage for the target document.
- Use the horizontal page chips to pick exactly which page the link should jump to. (If you want to just open the file to its last-read page, you can delete the page number entirely).
- Give it a label and tap **Add**.

### 4. Fixing Broken Links
If you move or rename a file, any links pointing to it will break. 
- Open the plugin to the **Links page** tab. It will immediately warn you if any broken links exist in the current note.
- Tap **Repair** to select the file's new location, or tap **Delete** to cleanly remove the dead link from your notebook.

## Development

If you want to modify this plugin, you'll need Node.js and npm installed.

1. Clone the repository:
```bash
git clone git@github.com:YOUR-USERNAME/supernote-links-plugin.git
cd supernote-links-plugin
```

2. Install dependencies:
```bash
npm install
```

3. Build the plugin:
```bash
./buildPlugin.sh
```
This script bundles the React Native JavaScript, packages the assets, and generates a fresh `Links.snplg` file located in `build/outputs/`.
