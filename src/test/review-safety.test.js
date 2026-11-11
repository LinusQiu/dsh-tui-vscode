'use strict';
// Safety tests for the presentation layer: queue ordering, refused writes, BOM
// handling, the enabled gate, persistence and the hover trust boundary. The
// `vscode` module is mocked; the ledger is the real PR-1 data layer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EditLedgerStore } = require('../edit-ledger-store');
const precise = require('../precise-review-core');

const warnings = [];
const commands = new Map();
const disposable = { dispose() { } };
globalThis.__reviewMock = null;
class EventEmitter {
    constructor() { this.event = () => disposable; }
    fire() { }
    dispose() { }
}
class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = fsPath; }
    static file(value) { return new Uri(value); }
    static parse(value) { return new Uri(value); }
}
const mock = {
    Uri,
    Range: class { constructor(...args) { this.args = args; } },
    EventEmitter,
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Right: 1 },
    OverviewRulerLane: { Left: 1 },
    MarkdownString: class {
        constructor() { this.value = ''; }
        appendMarkdown(text) { this.value += text; return this; }
        // Mirrors the real class: text is escaped, so file content cannot add
        // trusted command links to a hover.
        appendText(text) { this.value += String(text).replace(/[\[\]()~`]/g, '\\$&'); return this; }
    },
    CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
    workspace: {
        textDocuments: [],
        workspaceFolders: [],
        getWorkspaceFolder: () => ({}),
        getConfiguration: () => ({ get: (key, fallback) => (key === 'editReview.enabled' ? true : fallback) }),
        registerTextDocumentContentProvider: () => disposable,
        createFileSystemWatcher: () => ({ onDidCreate() { }, onDidChange() { }, onDidDelete() { }, dispose() { } }),
        onDidOpenTextDocument: () => disposable,
        onDidSaveTextDocument: () => disposable,
        onDidChangeTextDocument: () => disposable,
        onDidChangeConfiguration: () => disposable,
        applyEdit: async () => true,
        fs: { delete: async () => { } },
    },
    window: {
        terminals: [],
        visibleTextEditors: [],
        activeTextEditor: undefined,
        createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }),
        onDidCloseTerminal: () => disposable,
        createTextEditorDecorationType: () => ({ dispose() { } }),
        registerTreeDataProvider: () => disposable,
        onDidChangeActiveTextEditor: () => disposable,
        onDidChangeVisibleTextEditors: () => disposable,
        showWarningMessage: async message => { warnings.push(String(message)); return undefined; },
        showInformationMessage: async () => undefined,
        setStatusBarMessage() { },
    },
    languages: { registerCodeLensProvider: () => disposable },
    commands: { registerCommand: (id, fn) => (commands.set(id, fn), disposable), executeCommand: async () => undefined },
    l10n: { t: text => text },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? mock : load.call(this, name, ...args); };
const { EditReview } = require('../edit-review');
Module._load = load;

const context = () => ({ subscriptions: [], extensionPath: '.', storageUri: undefined });
const build = () => new EditReview(context(), { store: new EditLedgerStore() });
const record = (store, file, before, after, patch = {}) =>
    store.record({ path: file, before, after, provenance: 'file-tool-v1', ...patch });
async function withReview(fn) {
    const review = build();
    await review.ready;
    try { await fn(review); }
    finally { review.dispose(); await review.shutdown(); }
}
async function assertCompletes(operation, message) {
    let timer;
    try {
        await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 500); })]);
    }
    finally { clearTimeout(timer); }
}

test('a stale decision completes and releases its path queue without waiting for the notification', async () => {
    const review = build();
    let warningCount = 0;
    const original = mock.window.showWarningMessage;
    mock.window.showWarningMessage = () => { warningCount++; return new Promise(() => { }); };
    try {
        await review.withPath('missing', () => review.undoHunk('missing', {}));
        await review.withPath('missing', async () => { });
        assert.equal(warningCount, 1);
        assert.equal(review.fileQueues.size, 0);
    }
    finally {
        mock.window.showWarningMessage = original;
        review.dispose();
        await review.shutdown();
    }
});

test('unscanned ordinary external change updates the settled baseline, never the ledger', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'existing.txt');
        await fs.writeFile(file, 'valuable\n');
        await withReview(async review => {
            await review.processFsEvent(Uri.file(file), 'change');
            assert.equal(review.store.get(file), null);
            assert.equal(review.settled.get(file), 'valuable\n');
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('strict UTF-8 observation keeps BOM changes outside the ledger', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'bom.txt');
        await fs.writeFile(file, '\uFEFFnew\r\n');
        await withReview(async review => {
            review.settled.set(file, '\uFEFFold\r\n');
            await review.processFsEvent(Uri.file(file), 'change');
            assert.equal(review.store.get(file), null);
            assert.equal(review.settled.get(file), '\uFEFFnew\r\n');
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('file text cannot inject trusted hover command links', async () => {
    await withReview(async review => {
        const entry = {
            id: 'e1', path: 'f', kind: 'modify', before: '[Click](command:dsh-tui-vscode.editKeep)\n',
            after: 'new\n', beforeMissing: false, userTouched: false, provenance: 'file-tool-v1',
        };
        const hunk = precise.reviewDiff(entry.before, entry.after).hunks[0];
        const value = review.hunkHover(entry, hunk).value;
        assert.ok(value.includes('\\[Click\\]\\(command:'), 'the attachment text is escaped');
    });
});

test('same-path decisions and filesystem events share one ordering queue', async () => {
    await withReview(async review => {
        const calls = [];
        let release;
        const a = review.withPath('f', async () => {
            calls.push('a');
            await new Promise(resolve => { release = resolve; });
            calls.push('b');
        });
        const b = review.withPath('f', async () => calls.push('c'));
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(calls, ['a']);
        release();
        await Promise.all([a, b]);
        assert.deepEqual(calls, ['a', 'b', 'c']);
    });
});

test('old file Keep cannot accept a disk rewrite the watcher has not mirrored yet', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'existing.txt');
        await fs.writeFile(file, 'newer unseen\n');
        await withReview(async review => {
            record(review.store, file, 'original\n', 'reviewed\n');
            await commands.get('dsh-tui-vscode.editKeep')({ path: file, reviewHint: review.store.fileHint(file) });
            assert.ok(review.store.get(file), 'the unseen version must stay pending');
            assert.equal(await fs.readFile(file, 'utf8'), 'newer unseen\n');
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('BOM baselines are never passed through WorkspaceEdit or file restoration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'bom.txt');
        await withReview(async review => {
            record(review.store, file, '\uFEFForiginal\r\n', null, { kind: 'delete' });
            let writes = 0;
            review.applyPlan = async () => { writes++; };
            await commands.get('dsh-tui-vscode.editUndo')(file);
            assert.equal(writes, 0);
            assert.ok(review.store.get(file));
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('shutdown waits for initialization and in-flight decisions before the final flush', async () => {
    const review = build();
    await review.ready;
    try {
        let initialized;
        let decision;
        const ready = new Promise(resolve => { initialized = resolve; });
        review.ready = ready;
        let persisted;
        review.flushState = async () => { persisted = review.store.toJSON(); };
        const final = review.withPath('f', async () => {
            await new Promise(resolve => { decision = resolve; });
            record(review.store, 'f', 'before', 'after');
        });
        const closing = review.shutdown();
        initialized();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(persisted, undefined);
        await review.withPath('g', () => { throw Error('new work must not start during shutdown'); });
        decision();
        await final;
        await closing;
        assert.equal(persisted.entries[0].after, 'after');
    }
    finally { /* the instance is already shut down */ }
});

test('storage failure propagates to the awaited flush and later retries still work', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-store-'));
    try {
        const blocker = path.join(root, 'not-a-directory');
        await fs.writeFile(blocker, 'x');
        const review = build();
        await review.ready;
        try {
            review.persistence = Promise.resolve();
            let target = path.join(blocker, 'pending.json');
            review.storeFile = () => target;
            await assert.rejects(review.flushState());
            target = path.join(root, 'pending.json');
            record(review.store, 'f', 'before', 'after');
            await review.flushState();
            assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).entries[0].after, 'after');
            assert.deepEqual((await fs.readdir(root)).sort(), ['not-a-directory', 'pending.json']);
        }
        finally { review.dispose(); await review.shutdown(); }
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('editor/disk mismatch and deleted-file recreation still block Keep', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'existing.txt');
        await fs.writeFile(file, 'after');
        await withReview(async review => {
            record(review.store, file, 'before', 'after');
            mock.workspace.textDocuments = [{
                uri: Uri.file(file), isClosed: false, isDirty: false,
                getText: () => 'old editor', lineCount: 1, lineAt: () => ({ text: 'old editor' }),
            }];
            try {
                await commands.get('dsh-tui-vscode.editKeep')({ path: file, reviewHint: review.store.fileHint(file) });
                assert.ok(review.store.get(file), 'a dirty/diverged editor keeps the review pending');
            }
            finally { mock.workspace.textDocuments = []; }
            review.store.clear();
            record(review.store, file, 'before', null, { kind: 'delete' });
            await commands.get('dsh-tui-vscode.editKeep')({ path: file, reviewHint: review.store.fileHint(file) });
            assert.ok(review.store.get(file), 'a recreated file cannot be accepted as deleted');
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an explicit whole-file Keep accepts a saved mixed version without writing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'mixed.txt');
        await fs.writeFile(file, 'AI and user saved');
        await withReview(async review => {
            record(review.store, file, 'before', 'AI');
            review.store.update(file, { userTouched: true, conflict: 'overlap-or-external' });
            await commands.get('dsh-tui-vscode.editKeep')(file);
            assert.equal(review.store.get(file), null);
            assert.equal(review.settled.get(file), 'AI and user saved');
            assert.equal(await fs.readFile(file, 'utf8'), 'AI and user saved');
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an external delete of a pending file pauses the review, never rewrites its images', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'));
    try {
        const file = path.join(root, 'vanished.txt');
        await fs.writeFile(file, 'AI text\n');
        await withReview(async review => {
            record(review.store, file, 'original\n', 'AI text\n');
            await fs.unlink(file);
            await review.processFsEvent(Uri.file(file), 'delete');
            const entry = review.store.get(file);
            assert.ok(entry, 'the entry is not silently dropped');
            assert.equal(entry.userTouched, true);
            assert.equal(entry.conflict, 'overlap-or-external');
            assert.equal(entry.after, 'AI text\n', 'the after image is untouched');
        });
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('enabled=false never warms the workspace and makes the commands no-ops', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-disabled-'));
    try {
        await fs.writeFile(path.join(root, 'a.txt'), 'content\n');
        const configuration = mock.workspace.getConfiguration;
        const folders = mock.workspace.workspaceFolders;
        mock.workspace.getConfiguration = () => ({ get: (key, fallback) => (key === 'editReview.enabled' ? false : fallback) });
        mock.workspace.workspaceFolders = [{ uri: Uri.file(root), name: 'ws', index: 0 }];
        try {
            const review = new EditReview(context(), { store: new EditLedgerStore() });
            try {
                await review.ready;
                assert.equal(review.started, false, 'no start-up scan when disabled');
                assert.equal(review.settled.size, 0, 'no baseline cache when disabled');
                await commands.get('dsh-tui-vscode.editKeep')(path.join(root, 'a.txt'));
                assert.equal(review.store.size, 0);
            }
            finally { review.dispose(); await review.shutdown(); }
        }
        finally {
            mock.workspace.getConfiguration = configuration;
            mock.workspace.workspaceFolders = folders;
        }
    }
    finally { await fs.rm(root, { recursive: true, force: true }); }
});
