# Image Metadata Note Generator (Obsidian Plugin)

An Obsidian plugin for batch-generating Markdown notes from image metadata.

## Features
- Current-note inspector workflow for image metadata jobs
- Vault-relative `input folder`, `output folder`, and `tags folder`
- Folder path suggestions in inspector fields
- Stable Diffusion-style metadata extraction from `png`, `jpg`, `jpeg`, and `webp`
- Job-note workflow using Markdown frontmatter in the current note
- `Scan`, `Run`, `Dry run`, `Overwrite existing`, and `Delete extra notes`

## Job Note Format
Store batch settings in a Markdown note frontmatter:

```yaml
---
type: image-metadata-note-generator-job
input_folder: Assets/Images
output_folder: Notes/Image Metadata
tags_folder: Tags
overwrite_existing: true
delete_extra_notes: false
dry_run: false
---
```

Open the job note and the inspector will bind to it automatically.
If the current note is not a job note yet, use the inspector action to initialize it.

## Install (from source)
1. Install dependencies
   - `npm i`
2. Build
   - `npm run build`
3. Link or copy this folder into your vault plugin directory

## Current Status
This is a usable first implementation. Further polish is still needed for validation, folder picking UI, and broader metadata test coverage.
