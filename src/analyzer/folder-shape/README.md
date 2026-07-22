# Folder Shape

This folder owns diagnostics about how large folders expose and document their
children.

- `large-folder.ts` enforces direct semantic-child budgets.
- `index.ts` requires boundary documentation once a folder has enough
  semantic children (the README-required check).
- `explicit-api.ts` flags folders consumed through multiple concrete files.
- `children/` contains shared semantic-child counting used by the folder-shape
  diagnostics.

Folder-shape rules should share counting logic through `children/` so threshold
rules agree on what a semantic child means.
