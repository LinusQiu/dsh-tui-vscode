'use strict';
// Unit tests for the host-side write path and the presentation wiring that can
// run without a real VS Code host. The `vscode` module is mocked through
// Module._load, exactly like the other review tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let applyResult = true;
let saved = true;
let captured;
class Range {
    constructor(...args) { this.args = args; }
}
class WorkspaceEdit {
    replace(uri, range, text) { captured = { uri, range, text }; }
}
let writingMarks = 0;
const disposable = { dispose() { } };
class EventEmitter {
    constructor() { this.event = () => disposable; }
    fire() { }
    dispose() { }
}
const mock = {
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }), parse: value => ({ scheme: 'file', value }) },
    Range,
    WorkspaceEdit,
    EventEmitter,
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Right: 1 },
    OverviewRulerLane: { Left: 1 },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(text) { this.value += text; return this; } appendText(text) { this.value += text; return this; } },
    CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
    workspace: {
        textDocuments: [],
        workspaceFolders: [],
        getWorkspaceFolder: () => ({}),
        getConfiguration: () => ({ get: (_, fallback) => fallback }),
        registerTextDocumentContentProvider: () => disposable,
        createFileSystemWatcher: () => ({ onDidCreate() { }, onDidChange() { }, onDidDelete() { }, dispose() { } }),
        onDidOpenTextDocument: () => disposable,
        onDidSaveTextDocument: () => disposable,
        onDidChangeTextDocument: () => disposable,
        onDidChangeConfiguration: () => disposable,
        applyEdit: async () => applyResult,
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
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        setStatusBarMessage() { },
    },
    languages: { registerCodeLensProvider: () => disposable },
    commands: { registerCommand: () => disposable, executeCommand: async () => undefined },
    l10n: { t: text => text },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? mock : load.call(this, name, ...args); };
const { EditReview } = require('../edit-review');
Module._load = load;

const owner = document => Object.assign(Object.create(EditReview.prototype), {
    disposed: false,
    settled: new Map(),
    selfMarks: new Map(),
    fileQueues: new Map(),
    store: { markWriting() { writingMarks++; }, clearWriting() { writingMarks--; } },
    assertSafePath: async () => { },
    findDocument: () => document,
    enabled: () => true,
    excluded: () => false,
    scheduleDocSettle: () => { },
    warn() { },
});

const document = (file, text) => ({
    uri: mock.Uri.file(file),
    getText: () => text,
    isClosed: false,
    isDirty: false,
    lineCount: text.split('\n').length,
    lineAt: index => ({ text: text.split('\n')[index] ?? '' }),
    save: async () => {
        if (saved) await fsp.writeFile(file, text);
        return saved;
    },
});

let root;
test.before(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-review-write-')); });
test.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

test('undo builds a whole-document TextEdit and saves it through the host', async () => {
    applyResult = true;
    saved = true;
    const file = path.join(root, 'fixture.txt');
    const doc = document(file, 'restored');
    writingMarks = 0;
    const instance = owner(doc);
    await EditReview.prototype.writeContent.call(instance, file, 'restored');
    assert.equal(captured.text, 'restored');
    assert.deepEqual(captured.range.args, [0, 0, 0, 8]);
    assert.equal(instance.settled.get(file), 'restored');
    assert.equal(writingMarks, 0, 'the in-flight mark is always cleared');
});

test('a refused applyEdit must not claim the restoration succeeded', async () => {
    applyResult = false;
    saved = true;
    const file = path.join(root, 'refused.txt');
    const instance = owner(document(file, 'restored'));
    await assert.rejects(EditReview.prototype.writeContent.call(instance, file, 'restored'), /refused/);
    assert.equal(instance.settled.size, 0);
});

test('a failed save must not advance the settled baseline', async () => {
    applyResult = true;
    saved = false;
    const file = path.join(root, 'unsaved.txt');
    const instance = owner(document(file, 'restored'));
    await assert.rejects(EditReview.prototype.writeContent.call(instance, file, 'restored'), /saved/);
    assert.equal(instance.settled.size, 0);
});

test('delete-file Undo reports the action it really performed', async () => {
    const file = path.join(root, 'created.txt');
    const instance = owner(document(file, 'x'));
    const messages = [];
    mock.window.setStatusBarMessage = message => { messages.push(String(message)); };
    try {
        instance.writeContent = async () => { };
        instance.store.remove = () => { };
        await EditReview.prototype.applyPlan.call(instance, { path: file, before: null, after: 'x' }, 'delete-file', undefined);
        assert.ok(messages.some(message => message.includes('removed the newly created file')), messages.join('|'));
        assert.equal(messages.some(message => message.includes('restored the pre-edit original')), false);
    }
    finally { mock.window.setStatusBarMessage = () => { }; }
});
