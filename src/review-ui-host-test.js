'use strict';
/**
 * Isolated extension-host VISUAL test for the reworked review display.
 *
 * The host script drives real state (recorded changes, themes, a paused review,
 * a manual comparison) and stops at named phases; the external CDP observer
 * (`scripts/stable-review-ui-observer.cjs`) captures a real screenshot and a
 * small DOM snapshot for each phase. A final pair of phases verifies that the
 * CodeLens controls work through REAL mouse clicks.
 */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const output = path.join(root, 'ui-result.json');
    const marker = path.join(root, 'visual-next.json');
    const result = { version: vscode.version, status: 'running', phases: [], checks: [] };
    const write = phase => {
        result.phase = phase;
        result.phases.push(phase);
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
    };
    const wait = async () => {
        const start = Date.now();
        while (!fs.existsSync(marker)) {
            if (Date.now() - start > 30000) throw Error('UI observer timeout');
            await sleep(50);
        }
        fs.unlinkSync(marker);
    };
    const waitFor = async (predicate, label) => {
        const start = Date.now();
        while (!await predicate()) {
            if (Date.now() - start > 15000) throw Error(`Timeout: ${label}`);
            await sleep(30);
        }
    };
    const setTheme = async theme => {
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Workspace);
        await sleep(450);
    };
    const record = async (file, after, options = {}) => {
        let before = null;
        try { before = await fs.promises.readFile(file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const kind = options.kind ?? (after === null ? 'delete' : (before === null ? 'create' : 'modify'));
        if (after === null) await fs.promises.rm(file, { force: true });
        else await fs.promises.writeFile(file, after, 'utf8');
        return review.withPath(file, () => review.store.record({ path: file, before, after, kind, provenance: 'file-tool-v1' }));
    };
    let review;
    try {
        const api = await vscode.extensions.getExtension('baobaolaodie.dsh-tui-vscode').activate();
        review = api.getEditReviewTestBridge();
        await review.ready;
        const terminal = vscode.window.createTerminal({ name: 'DeepSeek' });
        review.trackTerminal(terminal);
        try {
            // ---- 1. the full display: rewrite + deletion block + addition ---
            const file = path.join(root, 'ui.txt');
            const before = [
                'header line',
                'unchanged separator one',
                'old text A',
                'unchanged separator two',
                'delete me one',
                'delete me two',
                'unchanged separator three',
                'old tail line',
            ].join('\r\n');
            const after = [
                'header line',
                'unchanged separator one',
                'new text A',
                'unchanged separator two',
                'unchanged separator three',
                'new tail line',
                'added line one',
                'added line two',
            ].join('\r\n');
            await fs.promises.writeFile(file, before, 'utf8');
            const uri = vscode.Uri.file(file);
            const editor = await vscode.window.showTextDocument(uri, { preview: false });
            await record(file, after);
            await waitFor(() => editor.document.getText() === after, 'editor shows the reviewed text');
            await sleep(250);
            await vscode.commands.executeCommand('notifications.clearAll');
            for (const [theme, label] of [['Default Dark+', 'inline-dark'], ['Default Light+', 'inline-light'], ['Default High Contrast', 'inline-contrast']]) {
                await setTheme(theme);
                // Give VS Code one beat to repaint the CodeLens row after the
                // theme switch before the observer captures the phase.
                await sleep(500);
                write(label);
                await wait();
            }
            result.checks.push('inline phases captured for all three themes');
            // keep the pristine file for the sidebar shot
            await setTheme('Default Dark+');
            await vscode.commands.executeCommand('dsh-tui-vscode.editReview.focus').catch(() => { });
            await sleep(500);
            write('sidebar-dark');
            await wait();
            result.checks.push('sidebar phase captured');
            await vscode.commands.executeCommand('workbench.action.closeSidebar').catch(() => { });
            await sleep(250);

            // ---- 2. a paused review shows the explicit warning -----------------
            const pauseEdit = new vscode.WorkspaceEdit();
            const pauseLine = after.split('\r\n').indexOf('new text A');
            pauseEdit.replace(uri, new vscode.Range(pauseLine, 0, pauseLine, 'new text A'.length), 'user overlapping text');
            if (!await vscode.workspace.applyEdit(pauseEdit)) throw Error('could not apply the user edit');
            await editor.document.save();
            await waitFor(() => !!review.store.get(file)?.userTouched, 'review paused after an overlapping user edit');
            await setTheme('Default Light+');
            const pausedLenses = (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri)) ?? [];
            result.pausedLenses = pausedLenses.map(lens => lens.command?.title);
            if (!result.pausedLenses.some(title => String(title).includes('Review paused'))) {
                throw Error(`paused CodeLens missing: ${JSON.stringify(result.pausedLenses)}`);
            }
            // Let the editor repaint the CodeLens row before the screenshot.
            await sleep(800);
            write('paused-light');
            await wait();
            result.checks.push('paused phase captured');
            // Leave the review clean again: whole-file Keep accepts the current file.
            await vscode.commands.executeCommand('dsh-tui-vscode.editKeep', { path: file, reviewHint: review.store.fileHint(file) });
            await waitFor(() => review.store.get(file) === null, 'paused review accepted');
            await setTheme('Default Dark+');

            // ---- 3. an on-demand comparison still looks like a real diff ------
            const compareFile = path.join(root, 'compare.txt');
            const long = Array.from({ length: 5 }, (_, index) => `旧稿第${index + 1}行：完整旧文本`).join('\r\n');
            await fs.promises.writeFile(compareFile, `start\r\n${long}\r\nend`, 'utf8');
            await record(compareFile, 'start\r\nend');
            await review.showDiff(compareFile, true);
            await sleep(900);
            write('compare-dark');
            await wait();
            result.checks.push('manual compare phase captured');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor').catch(() => { });
            await review.store.remove(compareFile);
            await sleep(250);

            // ---- 4. real mouse clicks on the generated CodeLens --------------
            const clickFile = path.join(root, 'click.txt');
            await fs.promises.writeFile(clickFile, 'alpha old\r\nseparator\r\nbeta old\r\n', 'utf8');
            const clickAfter = 'alpha new\r\nseparator\r\nbeta new\r\n';
            const clickUri = vscode.Uri.file(clickFile);
            await vscode.window.showTextDocument(clickUri, { preview: false });
            await record(clickFile, clickAfter);
            await sleep(500);
            write('click-keep-first');
            await wait();
            await waitFor(() => review.store.get(clickFile)?.before === 'alpha new\r\nseparator\r\nbeta old\r\n', 'first block kept');
            write('click-undo-second');
            await wait();
            await waitFor(() => review.store.get(clickFile) === null, 'second block undone');
            await waitFor(async () => (await fs.promises.readFile(clickFile, 'utf8')) === 'alpha new\r\nseparator\r\nbeta old\r\n', 'exact undo content');
            result.checks.push('real CodeLens clicks performed Keep then Undo');

            result.status = 'passed';
            write('complete');
        }
        finally { terminal.dispose(); }
    }
    catch (error) {
        result.status = 'failed';
        result.error = error.stack || String(error);
        write('failed');
        throw error;
    }
}

module.exports = { run };
