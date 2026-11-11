<div align="right">

English · [中文](edit-review_ZH.md)

</div>

# Edit review: the presentation layer

This document covers the **presentation half** of the edit-review feature split out
of PR #46: how a recorded AI file change is shown in the editor and how the
Keep / Undo controls behave. Attribution — which writes count as AI edits — is a
separate layer and is **not** part of this code; until that layer ships,
`dsh-tui-vscode.editReview.enabled` defaults to `false` and the view stays empty.

## Display contract

The editor shows four different things, and they must not be confused:

| Change | Mark in the live editor |
| --- | --- |
| Pure addition | Whole added line washed **dark green**, green gutter triangle, overview-ruler tick |
| Rewritten line | Whole rewritten line washed **light green**; the changed elements inside it darker green |
| Pure deletion block | No live line belongs to it: the surviving anchor line carries a **dark-red left border**, a red gutter icon and a compact `⊖N` badge (N = removed lines). Hover previews the removed text |
| Compared view | A real VS Code diff, opened **only** on request — never automatically |

The removed text is deliberately **not** painted inline. An extension cannot insert
extra lines into a normal editor (VS Code keeps that capability internal), so an
inline "old text" mark would have to share a line with the new text — the old
display did exactly that and made dense changes unreadable. Instead the deletion
block is a single marker: one place to see that lines are gone, the exact old
text one hover or one click away.

## Review controls

- **CodeLens row, first line of a pending file**: `▲` / `▼` move between blocks,
  `Keep file`, `Undo file`, `Compare with original`.
- **CodeLens above every block**: `1/3 · +2 −1 · Keep this change` and
  `Undo this change`. The counts are the block's added / removed lines.
- **AI Edits view** (activity bar, `dsh-tui` container): one row per pending file
  with its counts, a `new` / `deleted` label and the source tag; inline Keep,
  Undo and Compare buttons; the view title carries Keep all / Undo all. Clicking a
  row jumps to the first block in the editor instead of opening a tab.
- **Status bar**: `$(diff) dsh: N pending`; click it for the file list.
- **Hover** above a block: the pinned Keep / Undo / Compare links plus a short
  preview of the removed text (at most 160 characters).
- **Command palette** (`dsh-tui` category): Keep AI edit, Undo AI edit, Compare
  with original, Keep all AI edits, Undo all AI edits, Next / Previous pending
  edit, Keep / Undo current line change.
- **Editor title bar and context menu**: Keep / Undo while the active file is
  pending.

## Decision semantics

- **Keep** accepts the change and never writes the file. A whole-file Keep on a
  paused review accepts the current file as it stands.
- **Undo** restores the exact pre-edit bytes (line endings included) and, for a
  file the AI created, deletes it through the recycle bin. The plan → write →
  commit path for one block runs as a single queued operation per file.
- **User edits**: a hand edit that provably does not overlap the AI stretch is
  mirrored into both images; an overlapping edit pauses the review ("Review
  paused…") and the paused state offers Compare and the safe whole-file Keep.
- **Stale controls** are refused: every button carries the entry id and both
  image digests, so an old control can never target a newer state.
- **Safety refusals**: UTF-8 BOM files cannot be undone through the editor model
  (Undo is refused, Keep still works), writes outside the workspace or through a
  symbolic link are refused, and a save participant that changes the file keeps
  the original review and flags the conflict.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `dsh-tui-vscode.editReview.enabled` | `false` | The single gate for the whole feature |
| `dsh-tui-vscode.editReview.exclude` | the usual build/`.git` globs | Never reviewed, never captured |
| `dsh-tui-vscode.editReview.diffView` | `inline` | Layout of the on-demand comparison: `inline`, `sideBySide` or `auto` |

## Where the data comes from

The ledger is the data layer of the split: at most one pending entry per file,
carrying the before and after images, a provenance tag, a "being written" mark and
a conflict mark. This PR only reads it and performs the host-side writes; the
attribution layer (a later PR) records entries into the same store. The pending
list is persisted in the extension's workspace storage, so a window reload does
not lose a review.

## Verification

```bash
npm run typecheck
npm test                     # includes the display, integration, regression and safety suites
npm run test:e2e             # real extension-host suite (Linux: xvfb-run -a)
npm run package              # standard vsix; the host-test entry points are excluded

# isolated host: the display + real CodeLens clicks
#   DSH_REVIEW_ARTIFACT_ROOT=<isolated dir> VSCODE_EXECUTABLE=<Code.exe> node scripts/run-review-host.cjs
#   DSH_REVIEW_ARTIFACT_ROOT=<isolated dir> VSCODE_EXECUTABLE=<Code.exe> DSH_REVIEW_VISUAL_HANDSHAKE=1 node scripts/run-review-ui-host.cjs
```

The isolated host writes `host-result.json` / `ui-result.json`, and the visual host
also writes `screenshots/<phase>.png` together with `run-meta.json` (HEAD commit,
working-tree state, `out/` build time). `docs/review-host-result.json` records one
such run.

Not verified in this PR: real attribution (no source yet — entries in the host
tests are recorded through the test seam), and a true end-to-end run inside a
user's everyday VS Code profile (the isolated hosts use wiped profiles).
