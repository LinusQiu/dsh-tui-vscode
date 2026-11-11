'use strict';
// Pure display-planning tests: no `vscode` module, no filesystem.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planInlineReview, isReviewable, MAX_DECORATED_HUNKS, lineCount } = require('../edit-review-display');

const entry = (before, after, patch = {}) => ({
    id: 'e1',
    path: 'C:\\work\\file.txt',
    kind: 'modify',
    before,
    after,
    beforeMissing: false,
    userTouched: false,
    provenance: 'file-tool-v1',
    ...patch,
});

test('a pure insertion is planned as a dark-green block and no element spans', () => {
    const plan = planInlineReview(entry('a\n', 'a\nb\nc\n'), 'a\nb\nc\n');
    assert.ok(plan);
    assert.equal(plan.totalHunks, 1);
    assert.equal(plan.hunks[0].kind, 'added');
    assert.deepEqual(plan.hunks[0].addedLines, [1, 2]);
    assert.deepEqual(plan.hunks[0].modifiedLines, []);
    assert.deepEqual(plan.hunks[0].spans, []);
    assert.deepEqual(plan.lines.added, [1, 2]);
    assert.deepEqual(plan.lines.modified, []);
});

test('a rewritten line is planned as light green with the changed element darker', () => {
    const plan = planInlineReview(entry('const a = "old";\n', 'const a = "new";\n'), 'const a = "new";\n');
    assert.equal(plan.hunks[0].kind, 'modified');
    assert.deepEqual(plan.hunks[0].modifiedLines, [0]);
    assert.deepEqual(plan.hunks[0].addedLines, []);
    assert.ok(plan.hunks[0].spans.length >= 1);
    const span = plan.hunks[0].spans[0];
    assert.equal(span.line, 0);
    assert.ok(span.startCol >= 0 && span.endCol > span.startCol);
    assert.deepEqual(plan.lines.modified, [0]);
    assert.deepEqual(plan.lines.added, []);
});

test('a pure deletion is one block marker on the surviving anchor line', () => {
    const plan = planInlineReview(entry('start\none\ntwo\nend\n', 'start\nend\n'), 'start\nend\n');
    assert.equal(plan.hunks.length, 1);
    const hunk = plan.hunks[0];
    assert.equal(hunk.kind, 'removed');
    assert.equal(hunk.removedLines, 2);
    assert.deepEqual(hunk.addedLines, []);
    assert.deepEqual(hunk.modifiedLines, []);
    assert.deepEqual(hunk.spans, []);
    assert.deepEqual(plan.lines.removed, [hunk.line]);
    assert.equal(hunk.line, 1);
});

test('a rewritten line followed by pure additions keeps the two green weights apart', () => {
    const plan = planInlineReview(entry('a\nold tail\n', 'a\nnew tail\nadded one\nadded two\n'), 'a\nnew tail\nadded one\nadded two\n');
    assert.equal(plan.hunks.length, 1);
    assert.equal(plan.hunks[0].kind, 'modified');
    assert.deepEqual(plan.hunks[0].modifiedLines, [1], 'the paired rewritten line is the light wash');
    assert.deepEqual(plan.hunks[0].addedLines, [2, 3], 'unpaired new lines are pure additions');
    assert.deepEqual(plan.lines.modified, [1]);
    assert.deepEqual(plan.lines.added, [2, 3]);
});

test('every planned hunk carries a pinned button hint', () => {
    const plan = planInlineReview(entry('a\nx\n', 'a\ny\n'), 'a\ny\n');
    const hint = plan.hunks[0].hint;
    assert.equal(typeof hint.id, 'string');
    assert.equal(typeof hint.beforeHash, 'string');
    assert.equal(typeof hint.afterHash, 'string');
    assert.equal(typeof hint.offset, 'number');
});

test('CRLF content keeps line coordinates on the same lines', () => {
    const plan = planInlineReview(entry('a\r\nb\r\n', 'a\r\nB\r\n'), 'a\r\nB\r\n');
    assert.equal(plan.hunks[0].kind, 'modified');
    assert.deepEqual(plan.hunks[0].modifiedLines, [1]);
});

test('a paused, missing or deleted review is not drawn at all', () => {
    assert.equal(isReviewable(null), false);
    assert.equal(isReviewable(entry('a', 'b', { userTouched: true })), false);
    assert.equal(isReviewable(entry('a', 'b', { conflict: 'overlap-or-external' })), false);
    assert.equal(isReviewable(entry(null, 'b', { beforeMissing: true })), false);
    assert.equal(isReviewable(entry('a', null, { kind: 'delete' })), false);
    assert.equal(planInlineReview(entry('a', 'b', { userTouched: true }), 'b'), null);
    assert.equal(planInlineReview(entry(null, 'b', { kind: 'create', beforeMissing: true }), 'b'), null);
    assert.equal(planInlineReview(entry('a', null, { kind: 'delete' }), ''), null);
});

test('an upserted file with an empty diff has an empty plan, not a null one', () => {
    const plan = planInlineReview(entry('same\n', 'same\n'), 'same\n');
    assert.deepEqual(plan.hunks, []);
    assert.equal(plan.truncated, false);
});

test('BOM images are never planned (the editor model omits the preamble)', () => {
    const plan = planInlineReview(entry('\uFEFFa\nx\n', '\uFEFFa\ny\n'), 'a\ny\n');
    assert.equal(plan, null);
});

test('a lone CR counts as a line break, like the diff tokenizer', () => {
    assert.equal(lineCount('a\rb'), 2);
    assert.equal(lineCount('a\r\nb'), 2);
    assert.equal(lineCount('a\nb\rc\r\nd'), 4);
});

test('the painted-hunk cap bounds pathological diffs', () => {
    const changed = MAX_DECORATED_HUNKS + 25;
    const beforeLines = [];
    const afterLines = [];
    for (let index = 0; index < changed; index++) {
        beforeLines.push(`line ${index} old`, `stable separator ${index}`);
        afterLines.push(`line ${index} new`, `stable separator ${index}`);
    }
    const before = beforeLines.join('\n') + '\n';
    const after = afterLines.join('\n') + '\n';
    const plan = planInlineReview(entry(before, after), after);
    assert.equal(plan.totalHunks, changed);
    assert.equal(plan.hunks.length, MAX_DECORATED_HUNKS);
    assert.equal(plan.truncated, true);
});

test('lineCount matches TextDocument semantics', () => {
    assert.equal(lineCount(''), 1);
    assert.equal(lineCount('a'), 1);
    assert.equal(lineCount('a\n'), 2);
    assert.equal(lineCount('a\r\nb'), 2);
});
