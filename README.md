# Image Metadata Note Generator (Obsidian Plugin)

An Obsidian plugin for batch-generating Markdown notes from image metadata.

## Features
- Dedicated control panel for image metadata note generation
- Vault-relative `input folder`, `output folder`, and `tags folder`
- Stable Diffusion-style metadata extraction from `png`, `jpg`, `jpeg`, and `webp`
- Job-note workflow using Markdown frontmatter in the current note
- `Scan`, `Run`, `Dry run`, `Overwrite existing`, and `Delete extra notes`

## Job Note Format
Store batch settings in a Markdown note frontmatter:

```yaml
---
imgbatch_job: true
input_folder: Assets/Images
output_folder: Notes/Image Metadata
tags_folder: Tags
overwrite_existing: true
delete_extra_notes: false
dry_run: false
---
```

Open the note, then use the command or the control panel button to load it.

## Install (from source)
1. Install dependencies
   - `npm i`
2. Build
   - `npm run build`
3. Link or copy this folder into your vault plugin directory

## Current Status
This is a usable first implementation. Further polish is still needed for validation, folder picking UI, and broader metadata test coverage.
