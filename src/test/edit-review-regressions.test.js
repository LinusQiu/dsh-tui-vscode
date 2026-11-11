'use strict';
// Regression tests for the presentation contract: what gets painted, what must
// never be painted inline, and how paused reviews keep a safe way out. The
// `vscode` module is mocked; the ledger and the diff math are the real PR-1
// data layer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EditLedgerStore } = require('../edit-ledger-store');
const precise = require('../precise-review-core');

const callbacks = {};
const commands = new Map();
const commandCalls = [];
const warnings = [];
let provider;
class EventEmitter {
    constructor() { this.event = () => ({ dispose() { } }); }
    fire() { }
    dispose() { }
}
class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = fsPath; }
    static file(value) { return new Uri(value); }
    static parse(value) { return new Uri(value); }
}
class Range {
    constructor(...args) { this.args = args; }
}
const disposable = { dispose() { } };
const mock = {
    Uri, Range, EventEmitter,
    CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Right: 1 },
    OverviewRulerLane: { Left: 1 },
    MarkdownString: class {
        constructor() { this.value = ''; }
        appendMarkdown(text) { this.value += text; return this; }
        appendText(text) { this.value += text; return this; }
    },
    workspace: {
        textDocuments: [],
        workspaceFolders: [],
        getWorkspaceFolder: () => ({}),
        getConfiguration: () => ({ get: (key, fallback) => (key === 'editReview.enabled' ? true : fallback) }),
        registerTextDocumentContentProvider: () => disposable,
        createFileSystemWatcher: () => ({ onDidCreate() { }, onDidChange() { }, onDidDelete() { }, dispose() { } }),
        onDidOpenTextDocument: () => disposable,
        onDidSaveTextDocument: fn => (callbacks.save = fn, disposable),
        onDidChangeTextDocument: fn => (callbacks.change = fn, disposable),
        onDidChangeConfiguration: () => disposable,
        applyEdit: async () => true,
        fs: { delete: async () => { } },
    },
    window: {
        terminals: [{ name: 'DeepSeek' }],
        visibleTextEditors: [],
        activeTextEditor: undefined,
        createStatusBarItem: () => (globalThis.__lastStatusBar = { show() { }, hide() { globalThis.__statusBarHidden = true; }, dispose() { } }),
        onDidCloseTerminal: () => disposable,
        createTextEditorDecorationType: () => ({ dispose() { } }),
        registerTreeDataProvider: () => disposable,
        onDidChangeActiveTextEditor: () => disposable,
        onDidChangeVisibleTextEditors: () => disposable,
        showWarningMessage: async (...args) => { warnings.push(args[0]); return undefined; },
        showInformationMessage: async () => undefined,
        setStatusBarMessage() { },
    },
    languages: { registerCodeLensProvider: (_, p) => (provider = p, disposable) },
    commands: {
        registerCommand: (id, fn) => (commands.set(id, fn), disposable),
        executeCommand: async (...args) => { commandCalls.push(args); },
    },
    l10n: { t: text => text },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? mock : load.call(this, name, ...args); };
const { EditReview } = require('../edit-review');
Module._load = load;

const context = () => ({ subscriptions: [], extensionPath: '.', storageUri: undefined });
const build = () => new EditReview(context(), { store: new EditLedgerStore() });
const document = (file, text, dirty = false) => ({
    uri: Uri.file(file),
    isClosed: false,
    isDirty: dirty,
    getText: () => text,
    lineCount: text.split('\n').length,
    lineAt: index => ({ text: text.split('\n')[index] ?? '' }),
});
const record = (store, file, before, after, patch = {}) => store.record({ path: file, before, after, provenance: 'file-tool-v1', ...patch });

async function fixture(fn) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-regression-'));
    try { await fn(path.join(root, 'f.txt')); }
    finally {
        mock.workspace.textDocuments = [];
        await fs.rm(root, { recursive: true, force: true });
    }
}
async function withReview(fn) {
    const review = build();
    await review.ready;
    try { await fn(review); }
    finally { review.dispose(); await review.shutdown(); }
}

test('an open DeepSeek terminal does not attribute an unrelated external write to AI', () => fixture(async file => {
    await fs.writeFile(file, 'ordinary script\n');
    const review = build();
    await review.ready;
    try {
        review.trackTerminal({ name: 'DeepSeek' });
        review.settled.set(file, 'original\n');
        await review.processFsEvent(Uri.file(file), 'change');
        assert.equal(review.store.size, 0, 'no entry was minted');
        assert.equal(review.settled.get(file), 'ordinary script\n', 'only the settled baseline moved');
    }
    finally { review.dispose(); await review.shutdown(); }
}));

test('a deletion block is marked once; the removed text is never painted inline', () => fixture(async file => {
    await fs.writeFile(file, 'one\nthree\n');
    await withReview(async review => {
        record(review.store, file, 'one\ntwo\nthree\n', 'one\nthree\n');
        const batches = new Map();
        review.decor = { added: 'added', modified: 'modified', span: 'span', removed: 'removed', attachment: 'attachment' };
        review.decorateEditor({
            document: document(file, 'one\nthree\n'),
            setDecorations: (type, options) => batches.set(type, options),
        });
        const removed = batches.get('removed');
        assert.equal(removed.length, 1, 'one block marker for one deletion block');
        assert.equal(Object.hasOwn(removed[0], 'renderOptions'), false, 'no inline attachment on the block marker');
        const attachments = batches.get('attachment');
        assert.equal(attachments.length, 1);
        const badge = attachments[0].renderOptions.before;
        assert.match(badge.contentText, /^\u2296/);
        assert.equal(badge.contentText.includes('two'), false, 'the old line is not rendered inline');
        assert.equal(batches.get('added').length + batches.get('modified').length, 0);
    });
}));

test('added lines are dark green whole-line marks with no element spans', () => fixture(async file => {
    await fs.writeFile(file, 'a\nb\n');
    await withReview(async review => {
        record(review.store, file, 'a\n', 'a\nb\n');
        const batches = new Map();
        review.decor = { added: 'added', modified: 'modified', span: 'span', removed: 'removed', attachment: 'attachment' };
        review.decorateEditor({ document: document(file, 'a\nb\n'), setDecorations: (type, options) => batches.set(type, options) });
        assert.equal(batches.get('added').length, 1);
        assert.equal(batches.get('modified').length, 0);
        assert.equal(batches.get('span').length, 0);
        assert.deepEqual(batches.get('added')[0].range.args, [1, 0, 1, 0]);
    });
}));

test('rewritten lines are light green and only the changed element is darker green', () => fixture(async file => {
    await fs.writeFile(file, 'const a = "new";\n');
    await withReview(async review => {
        record(review.store, file, 'const a = "old";\n', 'const a = "new";\n');
        const batches = new Map();
        review.decor = { added: 'added', modified: 'modified', span: 'span', removed: 'removed', attachment: 'attachment' };
        review.decorateEditor({ document: document(file, 'const a = "new";\n'), setDecorations: (type, options) => batches.set(type, options) });
        assert.equal(batches.get('modified').length, 1);
        assert.equal(batches.get('added').length, 0);
        assert.ok(batches.get('span').length >= 1, 'a changed element is highlighted');
        const span = batches.get('span')[0].range.args;
        assert.equal(span[0], 0);
        assert.ok(span[3] > span[1]);
    });
}));

test('recording an edit never opens a comparison tab on its own', () => fixture(async file => {
    await fs.writeFile(file, 'AI\n');
    await withReview(async review => {
        commandCalls.length = 0;
        record(review.store, file, 'before\n', 'AI\n');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(commandCalls.some(args => args[0] === 'vscode.diff'), false, 'no automatic diff tab');
    });
}));

test('a paused review still offers Compare and a safe whole-file Keep', async () => {
    await fixture(async file => {
        await fs.writeFile(file, 'user version\n');
        await withReview(async review => {
            record(review.store, file, 'before\n', 'ai version\n');
            const clean = provider.provideCodeLenses(document(file, 'ai version\n'));
            assert.ok(clean.some(lens => lens.command.command === 'dsh-tui-vscode.editKeep'));
            assert.ok(clean.some(lens => lens.command.command === 'dsh-tui-vscode.editUndo'));
            review.store.update(file, { userTouched: true, conflict: 'overlap-or-external' });
            const lenses = provider.provideCodeLenses(document(file, 'user version\n'));
            assert.equal(lenses.length, 2);
            assert.equal(lenses[0].command.command, 'dsh-tui-vscode.editShowDiff');
            assert.match(lenses[0].command.title, /Review paused/);
            assert.equal(lenses[1].command.command, 'dsh-tui-vscode.editKeep');
            assert.match(lenses[1].command.title, /accept current file/);
            await commands.get('dsh-tui-vscode.editKeep')({ path: file, reviewHint: review.store.fileHint(file) });
            assert.equal(review.store.get(file), null);
            assert.equal(await fs.readFile(file, 'utf8'), 'user version\n');
            assert.equal(review.settled.get(file), 'user version\n');
        });
    });
});

test('undo on a paused entry routes to the confirmation prompt, not the stale warning', async () => {
    await fixture(async file => {
        await fs.writeFile(file, 'user version\n');
        await withReview(async review => {
            record(review.store, file, 'before\n', 'ai version\n');
            review.store.update(file, { userTouched: true, conflict: 'overlap-or-external' });
            warnings.length = 0;
            await commands.get('dsh-tui-vscode.editUndo')({ path: file, reviewHint: review.store.fileHint(file) });
            assert.ok(warnings.some(message => String(message).includes('Restore the original')), 'confirmation prompt shown');
            assert.equal(warnings.some(message => String(message).includes('earlier review snapshot')), false);
            assert.equal(await fs.readFile(file, 'utf8'), 'user version\n', 'declined modal wrote nothing');
            assert.ok(review.store.get(file), 'the pending review survived');
        });
    });
});

test('paused reasons are named: a stale deleted-file tab says so and still offers Keep', async () => {
    await fixture(async file => {
        await fs.writeFile(file, 'gone original\n');
        await fs.unlink(file);
        await withReview(async review => {
            record(review.store, file, 'gone original\n', null, { kind: 'delete' });
            mock.workspace.textDocuments = [document(file, 'gone original\n')];
            try {
                const lenses = provider.provideCodeLenses(document(file, 'gone original\n'));
                assert.ok(lenses.some(lens => String(lens.command.title).includes('File deleted')), JSON.stringify(lenses.map(l => l.command.title)));
                assert.ok(lenses.some(lens => lens.command.command === 'dsh-tui-vscode.editKeep' && lens.command.arguments[1]?.file), 'keep stays available');
            }
            finally { mock.workspace.textDocuments = []; }
        });
    });
});

test('paused reasons are named: BOM and missing-original reviews keep their own exit', async () => {
    await fixture(async file => {
        await fs.writeFile(file, 'BOM changed\n');
        await withReview(async review => {
            record(review.store, file, '\uFEFFBOM original\n', '\uFEFFBOM changed\n');
            const bomLenses = provider.provideCodeLenses(document(file, 'BOM changed\n'));
            assert.ok(bomLenses.some(lens => String(lens.command.title).includes('BOM: Undo unavailable')), JSON.stringify(bomLenses.map(l => l.command.title)));
            review.store.clear();
            record(review.store, file, 'unknown original\n', 'AI text\n', { beforeMissing: true });
            const missingLenses = provider.provideCodeLenses(document(file, 'AI text\n'));
            assert.ok(missingLenses.some(lens => String(lens.command.title).includes('Pre-edit original not captured')), JSON.stringify(missingLenses.map(l => l.command.title)));
        });
    });
});

test('turning the gate off removes marks, counter and CodeLens', async () => {
    await fixture(async file => {
        await fs.writeFile(file, 'AI\n');
        await withReview(async review => {
            record(review.store, file, 'before\n', 'AI\n');
            const sets = [];
            const editor = { document: document(file, 'AI\n'), setDecorations: (type, options) => sets.push(options) };
            mock.window.visibleTextEditors = [editor];
            globalThis.__statusBarHidden = false;
            const configuration = mock.workspace.getConfiguration;
            mock.workspace.getConfiguration = () => ({ get: (key, fallback) => (key === 'editReview.enabled' ? false : fallback) });
            try {
                review.refreshAll();
                assert.equal(sets.every(options => Array.isArray(options) && options.length === 0), true, 'every batch is cleared');
                assert.equal(globalThis.__statusBarHidden, true, 'the counter disappears');
                assert.deepEqual(provider.provideCodeLenses(document(file, 'AI\n')), [], 'CodeLens disappear');
                assert.deepEqual(review.entries(), [], 'the tree is empty');
            }
            finally {
                mock.workspace.getConfiguration = configuration;
                mock.window.visibleTextEditors = [];
            }
        });
    });
});

test('a whole-file Keep accepts a deleted file whose stale tab is still open', async () => {
    await fixture(async file => {
        await fs.writeFile(file, 'gone original\n');
        // The AI tool deleted the file, but the editor tab still shows the old text.
        await fs.unlink(file);
        await withReview(async review => {
            record(review.store, file, 'gone original\n', null, { kind: 'delete' });
            // Keep writes nothing, so a stale buffer must not block accepting the deletion.
            mock.workspace.textDocuments = [document(file, 'gone original\n')];
            try {
                await commands.get('dsh-tui-vscode.editKeep')({ path: file, reviewHint: review.store.fileHint(file) });
                assert.equal(review.store.get(file), null, 'the deletion was accepted');
                await assert.rejects(fs.readFile(file, 'utf8'), 'Keep never wrote');
            }
            finally { mock.workspace.textDocuments = []; }
        });
    });
});

test('a review comparison aligns the VS Code diff to the inline view by default', () => fixture(async file => {
    await fs.writeFile(file, 'after\n');
    await withReview(async review => {
        record(review.store, file, 'before\n', 'after\n');
        commandCalls.length = 0;
        await review.showDiff(file, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.ok(commandCalls.some(args => args[0] === 'vscode.diff'), 'the comparison still opens on demand');
        assert.ok(commandCalls.some(args => args[0] === 'diffEditor.setViewMode.inline'), 'stacked red/green rows');
    });
}));

test('no-change save and empty document event do not invalidate the actual generated Keep button', () => fixture(async file => {
    await fs.writeFile(file, 'AI\n');
    await withReview(async review => {
        mock.workspace.textDocuments = [document(file, 'AI\n')];
        try {
            record(review.store, file, 'before\n', 'AI\n');
            const lens = provider.provideCodeLenses(document(file, 'AI\n'))
                .find(l => l.command.command === 'dsh-tui-vscode.editKeep' && !l.command.arguments[1]?.file);
            assert.ok(lens);
            callbacks.save(document(file, 'AI\n'));
            callbacks.change({ document: document(file, 'AI\n', true), contentChanges: [] });
            assert.notEqual(review.store.get(file).userTouched, true);
            review.assertSafePath = async () => { };
            await commands.get(lens.command.command)(...lens.command.arguments);
            assert.equal(review.store.get(file), null);
            assert.equal(await fs.readFile(file, 'utf8'), 'AI\n');
        }
        finally { mock.workspace.textDocuments = []; }
    });
}));

test('a fresh button is never rendered against a different live document than its after image', async () => {
    await withReview(async review => {
        record(review.store, 'f', 'before\n', 'AI\n');
        const lenses = provider.provideCodeLenses(document('f', 'later\n'));
        assert.equal(lenses.some(l => ['dsh-tui-vscode.editKeep', 'dsh-tui-vscode.editUndo'].includes(l.command?.command)), false);
    });
});

test('non-overlapping user text is rebased into both snapshots, never attributed to AI', () => {
    const result = precise.rebaseUserEdit('old\nseparator\nuser before\n', 'AI\nseparator\nuser before\n', 'AI\nseparator\nuser after\n');
    assert.equal(result.conflict, false);
    assert.equal(result.before, 'old\nseparator\nuser after\n');
    assert.equal(result.after, 'AI\nseparator\nuser after\n');
    assert.equal(precise.reviewDiff(result.before, result.after).hunks.length, 1);
});

test('overlapping user change and deleted-line insertion ambiguity retain the original and report conflict', () => {
    for (const [before, after, current] of [['old\n', 'AI\n', 'user\n'], ['a\ndeleted\nb\n', 'a\nb\n', 'a\nuser\nb\n']]) {
        const result = precise.rebaseUserEdit(before, after, current);
        assert.equal(result.conflict, true);
        assert.equal(result.before, before);
        assert.equal(result.after, after);
    }
});
