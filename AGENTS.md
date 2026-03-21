# Repository Guidelines

This repository contains an Obsidian plugin for batch-generating Markdown notes from image metadata.

## Project Structure
- `main.ts`: Plugin entry and image metadata note generator view.
- `styles.css`: Minimal styles for the batch view.
- `manifest.json`: Obsidian plugin manifest.
- `rollup.config.mjs`: Build configuration.
- `README.md`: Project overview and intended direction.

## Build Commands
- `npm i`
- `npm run dev`
- `npm run build`

## Coding Style
- Language: TypeScript.
- Indentation: 4 spaces.
- Use semicolons and double quotes.
- Keep comments and documentation in English.

## Scope
- No network calls.
- Prefer mobile-safe Obsidian APIs.
- Keep batch generation logic focused on note generation from image metadata.
