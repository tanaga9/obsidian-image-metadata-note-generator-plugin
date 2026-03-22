# Image Metadata Note Generator (Obsidian Plugin)

An Obsidian plugin that turns AI image metadata into Markdown notes, so prompts, settings, and tags become reusable knowledge in your vault.

## Purpose
The purpose of this project is to convert metadata embedded in AI-generated images into Markdown notes that Obsidian can work with, so image generation history becomes reusable knowledge inside the vault.

Obsidian does not directly make good use of embedded metadata in formats such as `webp`. By extracting that information into notes, prompts, generation settings, tags, and related details can be stored in a searchable, linkable, and reusable form.

Those notes are intended primarily as generated, machine-readable records rather than documents for manual editing. Their main purpose is to support search, reading, and follow-up note creation by making it easier to navigate links to notes that do not exist yet.

They can also be read by AI agents and other Markdown-based tools, making past generations reusable as input for future prompt construction, evaluation, and iterative refinement.

## Features
- Current-note inspector workflow for image metadata jobs
- Vault-relative `input folder`, `output folder`, and `tags folder`
- Optional separate `template note` rendered with Handlebars
- Folder path suggestions in inspector fields
- Stable Diffusion-style metadata extraction from `png`, `jpg`, `jpeg`, and `webp`
- Job-note workflow using Markdown frontmatter in the current note
- `Scan`, `Run`, `Dry run`, `Do not overwrite existing`, and `Do not delete extra notes`

## Job Note Format
Store batch settings in a Markdown note frontmatter:

```yaml
---
type: image-metadata-note-generator-job
input_folder: Assets/Images
output_folder: Notes/Image Metadata
---
```

Open the job note and the inspector will bind to it automatically.
If the current note is not a job note yet, use the inspector action to initialize it.

Other fields are optional and fall back to defaults when omitted.
The default behavior is to overwrite existing notes. Set `skip_overwrite_existing: true` only when you want to preserve existing files.
The default behavior is also to delete extra output notes. Set `skip_delete_extra_notes: true` only when you want to keep unmatched files.

## Template Notes
Use a separate Markdown note as the output template by setting `template_note` to its vault path.
The template body is rendered with Handlebars. If `template_note` is empty, the plugin uses the built-in template that matches the current output format.

Available fields in the template include:
- `{{image.path}}`
- `{{image.name}}`
- `{{image.embed}}`
- `{{prompt}}`
- `{{yamlIndentedPrompt}}`
- `{{parameters}}`
- `{{tagsInline}}`
- `{{#each tags}}...{{/each}}`
- `{{#each models}}...{{/each}}`

## Install (from source)
1. Install dependencies
   - `npm i`
2. Build
   - `npm run build`
3. Link or copy this folder into your vault plugin directory

## Current Status
This is a usable first implementation. Further polish is still needed for validation, folder picking UI, and broader metadata test coverage.
