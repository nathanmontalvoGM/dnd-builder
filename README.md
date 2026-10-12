# Character Builder

A D&D 2024 character builder that runs entirely in the browser. It has no content of its own: players load a `content.json` pack built from the private content repo.

## Structure

- `index.html` — page shell
- `css/style.css` — all styling (light and dark)
- `js/app.js` — loading packs, routing, home page, the compendium browser
- `js/wizard.js` — the character creation wizard and character file export
- `js/engine.js` — the rules engine: walks grants, finds open choices, computes the character
- `js/render.js` — turns content entries and grants into readable HTML
- `js/rules.js` — proficiency bonus and spell slot math
- `js/store.js` — saves the pack in the browser (IndexedDB)
- `js/vendor/` — marked (Markdown) and DOMPurify (sanitizer), MIT/Apache licensed

## Testing locally

The app uses JavaScript modules, which browsers won't load from a double-clicked file. Run a local server from this folder instead:

```
npx serve .
```

Then open the address it prints (usually http://localhost:3000).
