'use strict';
/**
 * Isolated extension-host functional test for the review presentation layer.
 *
 * The attribution layer is a later PR of the split, so this suite records
 * "already verified" changes directly through the test bridge's shared ledger
 * (the same store the UI draws from). Everything after that is the real UI:
 * decorations, CodeLens, hover arguments, Keep/Undo writes and persistence.
 */
const vscode = require('vscode');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { reviewDiff, changeHint } = require('./precise-review-core');

async function waitFor(predicate, label) {
    const start = Date.now();
    while (!await predicate()) {
        if (Date.now() - start > 15000) throw Error(`Timeout: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 30));
    }
}
async function bounded(operation, label) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timeout: ${label}`)), 8000); })]);
    }
    finally { clearTimeout(timer); }
}
const command = (id, ...args) => bounded(vscode.commands.executeCommand(id, ...args), id);

async function run() {
    const api = await vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode').activate();
    const review = api.getEditReviewTestBridge();
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    await review.ready;
    const terminal = vscode.window.createTerminal({ name: 'DeepSeek' });
    review.trackTerminal(terminal);
    const result = { version: vscode.version, inferenceRequested: false, onlyFixtureFiles: true, status: 'running', checks: [] };
    const evidence = path.join(root, 'host-result.json');
    const checkpoint = label => {
        result.phase = label;
        syncFs.writeFileSync(evidence, JSON.stringify(result, null, 2));
        console.log('REVIEW_HOST_PHASE', label);
    };
    let sequence = 0;

    /** Wait until the open editor for `file` shows `text` (reload after an external write). */
    const syncEditor = async (file, text) => {
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === file && !candidate.isClosed);
        if (!document) return;
        for (let attempt = 0; attempt < 200; attempt++) {
            if (document.getText() === text) return;
            if (attempt === 4 && !document.isDirty) {
                try {
                    await vscode.window.showTextDocument(document.uri, { preview: false });
                    await vscode.commands.executeCommand('workbench.action.files.revert');
                } catch { /* older host without revert */ }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error('open editor did not reload the externally written text');
    };

    /** Write `after` and record it as an already-verified change. */
    const aiWrite = async (file, after, options = {}) => {
        let before = null;
        try { before = await fs.readFile(file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const kind = options.kind ?? (after === null ? 'delete' : (before === null ? 'create' : 'modify'));
        if (after === null) await fs.rm(file, { force: true });
        else await fs.writeFile(file, after, 'utf8');
        const entry = await review.withPath(file, async () => review.store.record({
            path: file,
            before,
            after,
            kind,
            provenance: 'file-tool-v1',
        }));
        sequence++;
        if (after !== null) await syncEditor(file, after);
        await new Promise(resolve => setTimeout(resolve, 120));
        return entry;
    };
    const lensesFor = async uri => {
        let lenses;
        await waitFor(async () => {
            lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
            return lenses?.some(lens => lens.command?.command === 'dsh-tui-vscode.editKeep');
        }, 'review CodeLens');
        return lenses;
    };
    const executeLens = lens => {
        assert.ok(lens?.command, 'lens has a command');
        return command(lens.command.command, ...lens.command.arguments);
    };
    const diffTabs = () => (vscode.window.tabGroups?.all ?? [])
        .flatMap(group => group.tabs)
        .filter(tab => tab.input instanceof vscode.TabInputTextDiff);

    try {
        // ---- 1. ordinary writes are never attributed to AI -----------------
        checkpoint('ordinary writes are not AI');
        const ordinary = path.join(root, 'ordinary.txt');
        await fs.writeFile(ordinary, 'ordinary script\n');
        await review.onFsEvent(vscode.Uri.file(ordinary), 'create');
        await review.onFsEvent(vscode.Uri.file(ordinary), 'change');
        assert.equal(review.store.get(ordinary), null);
        result.checks.push('ordinary create/change never mints a pending review');

        // ---- 2. an entry is drawn without any comparison tab ---------------
        checkpoint('recorded change is drawn in place');
        const file = path.join(root, 'review-fixture.js');
        const uri = vscode.Uri.file(file);
        await vscode.window.showTextDocument(uri, { preview: false });
        const before = await fs.readFile(file, 'utf8');
        const after = before.replace('old a', 'new a').replace('old b', 'new b').replace('old c', 'new c');
        const entry = await aiWrite(file, after);
        assert.equal(entry.before, before);
        assert.equal(entry.provenance, 'file-tool-v1');
        const editor = await vscode.window.showTextDocument(uri, { preview: false });
        await waitFor(() => editor.document.getText() === after, 'editor shows the AI text');
        assert.equal(diffTabs().length, 0, 'no comparison tab opens automatically');
        let lenses = await lensesFor(uri);
        const keepLenses = lenses.filter(lens => lens.command.command === 'dsh-tui-vscode.editKeep');
        const undoLenses = lenses.filter(lens => lens.command.command === 'dsh-tui-vscode.editUndo');
        assert.ok(keepLenses.length >= 3, 'file bar + one per block');
        assert.ok(undoLenses.length >= 2, 'per-block Undo');
        assert.ok(keepLenses.some(lens => /\+[0-9]+|−[0-9]+/.test(String(lens.command.title))), 'block lenses carry counts');
        result.checks.push('no auto diff; CodeLens bar + per-block Keep/Undo with counts');

        // ---- 3. per-hunk Keep folds the block into the baseline -----------
        checkpoint('per-hunk Keep');
        const firstKeep = keepLenses.find(lens => !lens.command.arguments[1]?.file && String(lens.command.title).includes('1/'));
        await editor.document.save();
        await executeLens(firstKeep);
        // `old a` and `old b` are adjacent changed lines: one block, one Keep.
        const kept = before.replace('old a', 'new a').replace('old b', 'new b');
        assert.equal(review.store.get(file)?.before, kept, 'the kept block left the pending diff');
        result.checks.push('per-hunk Keep rebases the baseline without writing');

        // A control captured before the decision must be refused afterwards.
        const staleUndo = undoLenses.find(lens => !lens.command.arguments[1]?.file);
        await executeLens(staleUndo).catch(() => { });
        assert.equal(await fs.readFile(file, 'utf8'), after, 'a stale block control never rewrites the file');

        // ---- 4. whole-file Keep + a second recorded change ----------------
        checkpoint('whole-file Keep and later Undo');
        const fileLevelKeep = (await lensesFor(uri)).find(lens => lens.command.command === 'dsh-tui-vscode.editKeep' && lens.command.arguments[1]?.file);
        await executeLens(fileLevelKeep);
        assert.equal(review.store.get(file), null, 'the whole review was accepted');
        await aiWrite(file, after.replace('new c', 'later c'));
        const debugDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === file && !candidate.isClosed);
        result.debug = {
            entry: review.store.get(file) ? { before: review.store.get(file).before, after: review.store.get(file).after } : null,
            documentText: debugDocument?.getText() ?? null,
            documentDirty: debugDocument?.isDirty ?? null,
            activeFile: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
        };
        const laterUndo = (await lensesFor(uri)).find(lens => lens.command.command === 'dsh-tui-vscode.editUndo' && lens.command.arguments[1]?.file);
        await executeLens(laterUndo);
        assert.equal(await fs.readFile(file, 'utf8'), after);
        result.checks.push('whole-file Keep accepts; later verified change can be undone exactly');

        // ---- 5. a deployment block restores the removed lines -------------
        checkpoint('removed-block marker and Undo');
        const deletedText = path.join(root, 'deleted-lines.txt');
        const long = Array.from({ length: 8 }, (_, index) => `旧稿第${index + 1}行：完整旧文本，不能截断`).join('\r\n');
        await fs.writeFile(deletedText, `start\r\n${long}\r\nend`);
        const removedEntry = await aiWrite(deletedText, 'start\r\nend');
        const deletedUri = vscode.Uri.file(deletedText);
        const deletedEditor = await vscode.window.showTextDocument(deletedUri, { preview: false });
        await waitFor(() => deletedEditor.document.getText() === 'start\r\nend', 'deletion editor');
        result.debug2 = {
            entry: review.store.get(deletedText) ? { before: review.store.get(deletedText).before, after: review.store.get(deletedText).after } : null,
            beforeMissing: review.store.get(deletedText)?.beforeMissing ?? null,
            userTouched: review.store.get(deletedText)?.userTouched ?? null,
            documentText: deletedEditor.document.getText(),
            dirty: deletedEditor.document.isDirty,
            rawLenses: (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', deletedUri))?.map(lens => ({ command: lens.command?.command, title: lens.command?.title })),
        };
        const deletionLenses = await lensesFor(deletedUri);
        const deletionUndo = deletionLenses.find(lens => lens.command.command === 'dsh-tui-vscode.editUndo' && !lens.command.arguments[1]?.file);
        assert.ok(deletionUndo, 'a removed block still gets a per-block Undo control');
        await executeLens(deletionUndo);
        assert.equal(await fs.readFile(deletedText, 'utf8'), `start\r\n${long}\r\nend`, 'the 8 Chinese lines restore byte-exactly');
        assert.equal(review.store.get(deletedText), null);
        result.checks.push('removed blocks are one marker; Undo restores the exact multi-line text');
        // Record the same deletion again and accept it with the block Keep.
        await aiWrite(deletedText, 'start\r\nend');
        const keepDeletion = (await lensesFor(deletedUri)).find(lens => lens.command.command === 'dsh-tui-vscode.editKeep' && !lens.command.arguments[1]?.file);
        assert.ok(keepDeletion, 'the removed block keeps its Keep control');
        await executeLens(keepDeletion);
        assert.equal(review.store.get(deletedText), null, 'keeping a deletion accepts it');
        assert.equal(await fs.readFile(deletedText, 'utf8'), 'start\r\nend');
        result.checks.push('keeping a deletion accepts it without writing');

        // ---- 6. hover links carry the same pinned decision ----------------
        checkpoint('hover decision links');
        const hoverEntry = review.store.get(deletedText) ?? removedEntry;
        assert.ok(hoverEntry);
        const hunk = reviewDiff(hoverEntry.before ?? '', hoverEntry.after ?? '').hunks[0] ?? null;
        if (hunk) {
            const hover = review.hunkHover(hoverEntry, hunk).value;
            const match = hover.match(/command:dsh-tui-vscode\.editUndo\?([^)]*)/);
            assert.ok(match, 'hover exposes an undo command');
            const args = JSON.parse(decodeURIComponent(match[1]));
            assert.equal(args[0], deletedText);
            assert.equal(typeof args[1]?.id, 'string');
        }
        result.checks.push('hover command arguments stay pinned to the reviewed entry');

        // ---- 7. a new file, BOM refusal and deletion restoration -----------
        checkpoint('create, BOM and deleted-file restore');
        const created = path.join(root, 'created.txt');
        await fs.rm(created, { force: true });
        await aiWrite(created, 'accepted\r\nremaining\r\n', { kind: 'create' });
        await command('dsh-tui-vscode.editKeep', { path: created, reviewHint: review.store.fileHint(created) });
        assert.equal(review.store.get(created), null);
        assert.equal(await fs.readFile(created, 'utf8'), 'accepted\r\nremaining\r\n');

        const bom = path.join(root, 'bom.txt');
        await fs.writeFile(bom, '\uFEFFBOM original\r\n');
        await aiWrite(bom, '\uFEFFBOM changed\r\n');
        await command('dsh-tui-vscode.editUndo', bom);
        assert.equal(await fs.readFile(bom, 'utf8'), '\uFEFFBOM changed\r\n', 'BOM Undo is refused');
        assert.ok(review.store.get(bom), 'the BOM review stays pending');
        await command('dsh-tui-vscode.editKeep', { path: bom, reviewHint: review.store.fileHint(bom) });

        const gone = path.join(root, 'gone.txt');
        await fs.writeFile(gone, 'delete original\r\n');
        await aiWrite(gone, null, { kind: 'delete' });
        await command('dsh-tui-vscode.editUndo', gone);
        assert.equal(await fs.readFile(gone, 'utf8'), 'delete original\r\n', 'a deleted file is restored');
        assert.equal(review.store.get(gone), null);
        result.checks.push('created file Keep, BOM Undo refusal, deleted-file restore');

        // ---- 8. a pending review survives an awaited shutdown -------------
        checkpoint('shutdown persists the review');
        const pending = path.join(root, 'batch-b.txt');
        await fs.writeFile(pending, 'batch B original');
        await aiWrite(pending, 'shutdown pending\n');
        const hint = changeHint(review.store.get(pending), reviewDiff(review.store.get(pending).before, review.store.get(pending).after).hunks[0]);
        assert.equal(typeof hint.id, 'string');
        await review.flushState();
        const stored = JSON.parse(await fs.readFile(review.storeFile(), 'utf8'))
            .entries.find(entryRecord => entryRecord.path === pending);
        assert.equal(stored.before, 'batch B original');
        assert.equal(stored.after, 'shutdown pending\n');
        assert.equal(stored.provenance, 'file-tool-v1');
        result.checks.push('awaited flush persists the pending review and its provenance');

        result.status = 'passed';
        checkpoint('complete');
    }
    catch (error) {
        result.status = 'failed';
        result.error = String(error.stack ?? error);
        checkpoint(`failed: ${result.phase}`);
        throw error;
    }
    finally {
        terminal.dispose();
        syncFs.writeFileSync(evidence, JSON.stringify(result, null, 2));
    }
}

module.exports = { run };
