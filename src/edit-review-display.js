'use strict';
/**
 * edit-review-display — pure layout for the in-editor review marks.
 *
 * The presentation layer draws four different things and must keep them
 * apart, because the ledger only stores the before/after images and the host
 * (VS Code) only lets an extension paint lines that still exist:
 *
 * - rewritten lines      — light green whole-line wash;
 * - changed elements     — darker green inside a rewritten line;
 * - pure additions       — darker green whole-line wash;
 * - pure deletions       — a block marker on the surviving line (no old text
 *                          is drawn inline: the old red strikethrough made the
 *                          old and the new text share one line).
 *
 * Everything here is derived from `precise-review-core` and stays free of the
 * `vscode` module and of I/O, so the mapping can be unit-tested without a
 * host. `edit-review.js` turns the returned line/column coordinates into
 * decorations, hovers and CodeLens entries.
 *
 * The plan returns `null` when the entry cannot be reviewed in the editor
 * right now (missing baseline, whole-file deletion, paused by user edits or by
 * a conflict, or a BOM image). The caller must clear its decorations then.
 */
const precise = require('./precise-review-core');
const { elementChanges, pairLines } = require('./edit-review-core');

/** Upper bound on painted hunks: a pathological diff must not stall the editor. */
const MAX_DECORATED_HUNKS = 200;

/** Number of lines in `text` (1 for the empty string, like TextDocument). */
function lineCount(text) {
    // Match precise-review-core's tokenizer (and VS Code TextDocument): CRLF,
    // LF and a lone CR are all line breaks.
    const breaks = text.match(/\r\n|\r|\n/g);
    return breaks ? breaks.length + 1 : 1;
}

/** True when the entry is currently pairable with the editor document. */
function isReviewable(entry) {
    if (!entry) return false;
    // The editor model omits the UTF-8 encoding BOM; a BOM image can never be
    // matched coordinate-for-coordinate, so it is not planned at all.
    const boms = [entry.before, entry.after].some(text => typeof text === 'string' && text.startsWith('\uFEFF'));
    return !boms
        && !entry.beforeMissing
        && entry.kind !== 'delete'
        && entry.userTouched !== true
        && !entry.conflict;
}

/**
 * Plan the in-editor marks for one pending entry.
 *
 * @param {object} entry pending ledger entry (PR-1 shape)
 * @param {string} currentText current editor text (must equal `entry.after`
 *   for the caller to draw; this function only lays out coordinates)
 * @param {number} [limit] painted-hunk cap
 * @returns {null|{
 *   hunks: Array<{
 *     change: object,          // the precise-review-core hunk (offsets, texts)
 *     hint: object,            // pinned button hint for Keep/Undo
 *     line: number,            // 0-based anchor line in the current text
 *     kind: 'added'|'modified'|'removed',
 *     lines: number[],         // live lines touched by the block (empty for a deletion)
 *     addedLines: number[],    // pure additions inside the block (darker green)
 *     modifiedLines: number[], // rewritten lines (lighter green)
 *     spans: Array<{line: number, startCol: number, endCol: number}>,
 *     ghosts: Array<{line: number, startCol: number, endCol: number, text: string}>,
 *     removedLines: number,    // > 0 only for a deletion block
 *   }>,
 *   totalHunks: number,
 *   truncated: boolean,
 *   lines: {added: number[], modified: number[], removed: number[]},
 *   spans: Array<{line: number, startCol: number, endCol: number}>,
 *   ghosts: Array<{line: number, startCol: number, endCol: number, text: string}>,
 * }>}
 */
function planInlineReview(entry, currentText, limit = MAX_DECORATED_HUNKS) {
    if (!isReviewable(entry)) return null;
    if (typeof currentText !== 'string') return null;
    const diff = precise.reviewDiff(entry.before ?? '', currentText);
    const totalHunks = diff.hunks.length;
    if (totalHunks === 0) {
        return {
            hunks: [], totalHunks: 0, truncated: false,
            lines: { added: [], modified: [], removed: [] }, spans: [], ghosts: [],
        };
    }
    const maxLine = Math.max(lineCount(currentText) - 1, 0);
    const clamp = line => Math.max(0, Math.min(line, maxLine));
    const hunks = [];
    const lines = { added: [], modified: [], removed: [] };
    const spans = [];
    const ghosts = [];
    for (const change of diff.hunks.slice(0, limit)) {
        const anchor = clamp(change.startLine);
        const hint = precise.changeHint(entry, change);
        if (change.kind === 'removed') {
            lines.removed.push(anchor);
            hunks.push({
                change, hint, line: anchor, kind: 'removed',
                lines: [], addedLines: [], modifiedLines: [], spans: [], ghosts: [], removedLines: change.removed,
            });
            continue;
        }
        // Classify line by line: a "modified" hunk can also contain pure
        // additions (a rewritten line followed by brand-new lines). Those are
        // darker green; only the paired lines are the lighter rewrite wash.
        const alignment = pairLines(change.removedTexts, change.addedTexts);
        const oldIndexByNew = new Map(alignment.pairs.map(pair => [pair.newIndex, pair.oldIndex]));
        const planned = {
            change, hint, line: anchor, kind: change.kind,
            lines: [], addedLines: [], modifiedLines: [], spans: [], ghosts: [], removedLines: 0,
        };
        const lineTotal = Math.max(change.lineCount, 1);
        for (let offset = 0; offset < lineTotal; offset++) {
            const line = clamp(anchor + offset);
            planned.lines.push(line);
            const oldIndex = oldIndexByNew.get(offset);
            if (oldIndex === undefined) {
                planned.addedLines.push(line);
                lines.added.push(line);
                continue;
            }
            planned.modifiedLines.push(line);
            lines.modified.push(line);
            const oldLine = change.removedTexts[oldIndex];
            const newLine = change.addedTexts[offset] ?? '';
            const ghostByAnchor = new Map();
            for (const element of elementChanges(oldLine, newLine)) {
                const startCol = Math.max(0, Math.min(element.nStart, newLine.length));
                const endCol = Math.max(startCol, Math.min(element.nEnd, newLine.length));
                if (endCol > startCol) {
                    planned.spans.push({ line, startCol, endCol });
                    spans.push({ line, startCol, endCol });
                }
                if (element.oEnd <= element.oStart) continue;
                // A fragment that disappeared from a still-live line: keep it at
                // its old column so a partial rewrite reads completely. Whole
                // removed lines never take this path (they are block markers).
                const anchorCol = startCol;
                const group = ghostByAnchor.get(anchorCol) ?? { end: anchorCol + 1, texts: [] };
                group.end = Math.max(group.end, endCol, anchorCol + 1);
                group.texts.push({ at: element.oStart, text: oldLine.slice(element.oStart, element.oEnd) });
                ghostByAnchor.set(anchorCol, group);
            }
            for (const [anchorCol, group] of [...ghostByAnchor].sort((a, b) => a[0] - b[0])) {
                let text = group.texts.sort((a, b) => a.at - b.at).map(part => part.text).join('');
                // The render option supplies a small right margin: keeping the
                // separator outside the strikethrough avoids a dash that looks
                // like a hyphen between the old and the new fragment.
                text = text.replace(/\s+$/, '');
                if (text.length > 60) text = text.slice(0, 59) + '\u2026';
                const ghost = { line, startCol: anchorCol, endCol: group.end, text };
                planned.ghosts.push(ghost);
                ghosts.push(ghost);
            }
        }
        hunks.push(planned);
    }
    return {
        hunks,
        totalHunks,
        truncated: totalHunks > hunks.length,
        lines,
        spans,
        ghosts,
    };
}

module.exports = { MAX_DECORATED_HUNKS, isReviewable, lineCount, planInlineReview };
