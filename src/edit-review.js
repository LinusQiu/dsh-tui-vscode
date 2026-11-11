'use strict';
/**
 * Presentation layer for the pending-edit ledger.
 *
 * This layer owns everything the user sees and every button that may write to
 * disk: the in-editor diff marks, the review CodeLens bar, the "AI Edits
 * pending" tree, the status-bar counter, the on-demand comparison view and the
 * per-hunk / whole-file Keep and Undo actions.
 *
 * It consumes the data layer (`edit-ledger-store.js`) and never decides
 * attribution: entries appear only after another producer records a verified
 * change (the attribution layer is a later PR of the split). Tests inject
 * entries through the test bridge that `extension.ts` re-exports.
 *
 * Display contract (revision 2026-11-11; see the repository docs):
 * - no comparison tab is opened automatically — the diff view is on demand;
 * - pure additions are washed dark green, rewritten lines light green, the
 *   changed elements inside a rewritten line darker green;
 * - a pure deletion block is marked by a dark-red left border, a gutter icon
 *   and a compact `⊖` badge on the surviving anchor line; the removed text is
 *   NOT drawn inline (the old red strikethrough made old and new text share a
 *   line, which is exactly what the display rework removes);
 * - per-block Keep/Undo stay on CodeLens above the block.
 *
 * The presentation layer also owns the host-side write queue: the data layer
 * decides WHAT the file should contain, this module performs the write and
 * publishes the result. `store.planHunkUndo()` → write → `store.commitHunkUndo()`
 * is kept as one queued operation per path.
 */
const vscode = require('vscode');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { canonicalPathKey, formatCounts, planUndo } = require('./edit-review-core');
const precise = require('./precise-review-core');
const { assertInside, BINARY_EXTENSIONS, buildExcludeMatcher, DEFAULT_EXCLUDE_GLOBS, TEMP_NAME_RE } = require('./safe-path');
const { decodeReviewText, MAX_FILE_BYTES } = require('./review-text');
const { MAX_DECORATED_HUNKS, planInlineReview } = require('./edit-review-display');
const { deletedTextDecoration } = require('./review-decoration');

const fsp = nodeFs.promises;

const SCHEME = 'dsh-edit-review';
const KEEP_CMD = 'dsh-tui-vscode.editKeep';
const UNDO_CMD = 'dsh-tui-vscode.editUndo';
const KEEP_ALL_CMD = 'dsh-tui-vscode.editKeepAll';
const UNDO_ALL_CMD = 'dsh-tui-vscode.editUndoAll';
const DIFF_CMD = 'dsh-tui-vscode.editShowDiff';
const NEXT_CMD = 'dsh-tui-vscode.editNextHunk';
const PREV_CMD = 'dsh-tui-vscode.editPrevHunk';
const KEEP_LINE_CMD = 'dsh-tui-vscode.editKeepLine';
const UNDO_LINE_CMD = 'dsh-tui-vscode.editUndoLine';
const SHOW_PENDING_CMD = 'dsh-tui-vscode.editShowPending';
const REVEAL_CMD = 'dsh-tui-vscode.editReveal';
const TRUSTED_CMDS = [KEEP_CMD, UNDO_CMD, DIFF_CMD];

// ---- knobs ----------------------------------------------------------------
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_TOTAL = 48 * 1024 * 1024;
const MARK_TTL_MS = 2000; // how long a self write shields a path from watchers
const DOC_SETTLE_MS = 800;
const PERSIST_DEBOUNCE_MS = 500;
const DEFAULT_EXCLUDE = DEFAULT_EXCLUDE_GLOBS;

/** Command link for a trusted hover message; `hint` pins one edit (hunk). */
function cmdLink(command, arg, label, hint) {
    const args = encodeURIComponent(JSON.stringify(hint ? [arg, hint] : [arg]));
    return `[${label}](command:${command}?${args})`;
}

/** Tiny render option for the removed-block badge (attachment, not text). */
function removedBadge(count) {
    return {
        contentText: count > 0 ? `\u2296${count > 9 ? '9+' : count}` : '\u2296',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        margin: '0 4px 0 0',
    };
}

class EditReview {
    /**
     * @param {import('vscode').ExtensionContext} context
     * @param {{store: object, terminalName?: string}} options
     *   `store` is the shared data-layer ledger (an EditLedgerStore). It is
     *   required: the presentation layer must never mint its own ledger, or the
     *   attribution layer and the UI would diverge.
     */
    constructor(context, options) {
        const store = options && options.store;
        if (!store) throw new TypeError('EditReview needs the shared ledger store');
        this.store = store;
        this.disposed = false;
        this.closing = false;
        this.started = false;
        this.settled = new Map();
        this.cursor = new Map();
        this.selfMarks = new Map();
        this.saveMarks = new Map();
        this.docTimers = new Map();
        this.fileQueues = new Map();
        this.persistTimer = null;
        this.persistence = Promise.resolve();
        this.observedDuringScan = null;
        this.directoryInventory = new Map();
        this.contentEmitter = new vscode.EventEmitter();
        this.context = context;
        this.terminalName = options?.terminalName ?? 'DeepSeek';
        this.trackedTerminals = new Set();
        this.excludeMatcher = buildExcludeMatcher(DEFAULT_EXCLUDE);
        this.ready = Promise.resolve();
        this.pendingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 19);
        this.pendingStatus.command = SHOW_PENDING_CMD;
        context.subscriptions.push(this.pendingStatus, vscode.commands.registerCommand(SHOW_PENDING_CMD, async () => {
            const entries = this.entries();
            const choice = await vscode.window.showQuickPick(
                entries.map(entry => ({
                    label: nodePath.basename(entry.path),
                    description: this.describe(entry),
                    detail: entry.path,
                    path: entry.path,
                })),
                { title: vscode.l10n.t('Pending dsh-tui edits') },
            );
            if (choice) await this.revealFirstHunk(choice.path);
        }));
        context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => this.trackedTerminals.delete(terminal)));
        // Use the active theme's own diff colors; no private renderer access.
        this.decor = {
            // Pure additions: darker green (diffEditor.insertedTextBackground).
            added: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
                gutterIconPath: vscode.Uri.file(nodePath.join(context.extensionPath, 'media', 'edit-review-added.svg')),
                gutterIconSize: 'contain',
                overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),
            // Rewritten lines: lighter green (diffEditor.insertedLineBackground).
            // The gutter icon is the same green triangle; only the wash weight
            // distinguishes "rewritten" from "pure addition".
            modified: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
                gutterIconPath: vscode.Uri.file(nodePath.join(context.extensionPath, 'media', 'edit-review-added.svg')),
                gutterIconSize: 'contain',
                overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),
            // Changed elements inside a rewritten line: darker green again.
            span: vscode.window.createTextEditorDecorationType({
                backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
            }),
            // A pure deletion block: no live line belongs to it, so the anchor
            // line carries the marker — dark-red left border, gutter icon and
            // overview-ruler tick; the removed text lives in the hover only.
            removed: vscode.window.createTextEditorDecorationType({
                isWholeLine: true,
                borderColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                borderStyle: 'solid',
                borderWidth: '0 0 0 3px',
                gutterIconPath: vscode.Uri.file(nodePath.join(context.extensionPath, 'media', 'edit-review-removed.svg')),
                gutterIconSize: 'contain',
                overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
                overviewRulerLane: vscode.OverviewRulerLane.Left,
            }),
            // Attachment carrier for the removed-block badge (no chrome).
            attachment: vscode.window.createTextEditorDecorationType({}),
        };
        // ---- tree view (sidebar "AI Edits pending") -------------------------
        this.treeView = vscode.window.registerTreeDataProvider(
            'dsh-tui-vscode.editReview',
            new PendingTreeProvider(this),
        );
        context.subscriptions.push(this.treeView);
        // ---- original-image provider for the comparison view ----------------
        context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
            onDidChange: this.contentEmitter.event,
            provideTextDocumentContent: uri => this.provideOriginalContent(uri),
        }));
        // ---- commands ------------------------------------------------------
        const register = (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));
        register(KEEP_CMD, (target, hint) => this.withPath(this.resolvePath(target), () => this.keep(target, hint)));
        register(UNDO_CMD, (target, hint) => this.withPath(this.resolvePath(target), () => this.undo(target, hint)));
        register(KEEP_ALL_CMD, () => this.keepAll());
        register(UNDO_ALL_CMD, () => this.undoAll());
        register(DIFF_CMD, target => this.showDiff(this.resolvePath(target)));
        register(NEXT_CMD, target => this.gotoHunk(this.resolvePath(target), +1));
        register(PREV_CMD, target => this.gotoHunk(this.resolvePath(target), -1));
        register(KEEP_LINE_CMD, () => this.decideLine(false));
        register(UNDO_LINE_CMD, () => this.decideLine(true));
        register(REVEAL_CMD, target => this.revealFirstHunk(this.resolvePath(target)));
        context.subscriptions.push(this.contentEmitter);
        // ---- review bar (per-hunk and per-file CodeLens) --------------------
        this.bar = new ReviewBarProvider(this);
        context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.bar), this.bar);
        // ---- observation ----------------------------------------------------
        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        this.watcher = watcher;
        watcher.onDidCreate(uri => void this.onFsEvent(uri, 'create').catch(error => console.error('[dsh-tui-vscode] Review event:', error)));
        watcher.onDidChange(uri => void this.onFsEvent(uri, 'change').catch(error => console.error('[dsh-tui-vscode] Review event:', error)));
        watcher.onDidDelete(uri => void this.onFsEvent(uri, 'delete').catch(error => console.error('[dsh-tui-vscode] Review event:', error)));
        context.subscriptions.push(watcher);
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument(document => this.captureDocument(document)),
            vscode.workspace.onDidSaveTextDocument(document => this.onDidSaveDocument(document)),
            vscode.workspace.onDidChangeTextDocument(event => this.onDidChangeDocument(event)),
            vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration('dsh-tui-vscode.editReview.exclude')
                    && !event.affectsConfiguration('dsh-tui-vscode.editReview.enabled')) return;
                this.reloadExcludePatterns();
                if (this.enabled()) this.startServices();
                this.refreshAll();
            }),
        );
        this.unsub = this.store.onChange(() => {
            this.refreshAll();
            this.bar?.refresh();
            // A change may be recorded just after the host wrote the file: the
            // open document can still hold the old text for a moment, so one
            // delayed redraw picks up the reloaded document without polling.
            // CodeLens are re-requested asynchronously too, so refresh them once
            // more after the editor has settled.
            const redraw = setTimeout(() => {
                if (this.disposed) return;
                this.refreshAll();
                this.bar?.refresh();
            }, 300);
            redraw.unref?.();
            for (const document of vscode.workspace.textDocuments) {
                if (document.uri.scheme === SCHEME) this.contentEmitter.fire(document.uri);
            }
            this.schedulePersist();
        });
        // VS Code can coalesce external events around an editor save. Check open
        // and pending paths as a bounded fallback, without adopting a new baseline.
        this.pollTimer = setInterval(() => this.poll(), 750);
        if (this.enabled()) this.startServices();
        this.refreshAll();
    }

    // ---- start-up ----------------------------------------------------------
    /**
     * One-time initialization: restore the ledger, capture open buffers and
     * warm the bounded workspace baseline. Deliberately NOT run when the
     * feature is disabled: the author's review of #46 requires that
     * `editReview.enabled = false` never scans the workspace (5000 files /
     * 48 MB of text would otherwise sit in memory in every window).
     */
    startServices() {
        if (this.started || this.disposed) return;
        this.started = true;
        this.ready = Promise.all([this.loadState(), this.captureOpenBuffers(), this.warmScan()])
            .then(() => { this.observedDuringScan = null; })
            .catch(error => { console.error('[dsh-tui-vscode] Review start-up:', error); });
        this.refreshAll();
    }

    captureOpenBuffers() {
        for (const document of vscode.workspace.textDocuments) this.captureDocument(document);
    }

    captureDocument(document) {
        if (!document || document.uri.scheme !== 'file') return;
        const path = document.uri.fsPath;
        if (!this.settled.has(path) && !this.store.get(path)) {
            this.settled.set(path, this.documentSnapshot(document));
        }
    }

    onDidSaveDocument(document) {
        if (document.uri.scheme !== 'file') return;
        const path = document.uri.fsPath;
        const snapshot = this.documentSnapshot(document);
        if (!this.store.isWriting(path)) this.observeUserText(path, snapshot);
        this.saveMarks.set(path, { expires: Date.now() + MARK_TTL_MS, text: snapshot });
        if (!this.store.get(path)) this.settled.set(path, snapshot);
        this.scheduleDocSettle(path);
    }

    onDidChangeDocument(event) {
        const document = event.document;
        if (document.uri.scheme !== 'file') return;
        const path = document.uri.fsPath;
        if (document.isDirty && event.contentChanges.length && !this.store.isWriting(path)) {
            this.observeUserText(path, this.documentSnapshot(document));
        }
        // The document may have been reloaded after an external write: the
        // decorations are line-based and must follow the current text.
        this.refreshAll();
        this.bar?.refresh();
        this.scheduleDocSettle(path);
    }

    shutdown() {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.closing = true;
        clearInterval(this.pollTimer);
        for (const timer of this.docTimers.values()) clearTimeout(timer);
        this.docTimers.clear();
        for (const timer of this.retryTimers?.values() ?? []) clearTimeout(timer);
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = null;
        const pending = [...this.fileQueues.values()];
        this.shutdownPromise = (async () => {
            await this.ready;
            await Promise.allSettled(pending);
            await this.flushState();
        })();
        return this.shutdownPromise;
    }

    dispose() {
        if (this.disposed) return;
        void this.shutdown().catch(error => console.error('[dsh-tui-vscode] Review shutdown failed:', error));
        this.disposed = true;
        this.unsub?.();
        this.watcher?.dispose();
        for (const decoration of Object.values(this.decor)) decoration?.dispose?.();
    }

    // ------------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------------
    /** The feature is off unless the user turns it on (manual §4.5). */
    enabled() {
        return vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.enabled', false);
    }

    reloadExcludePatterns() {
        const globs = vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.exclude', DEFAULT_EXCLUDE);
        this.excludeMatcher = buildExcludeMatcher(Array.isArray(globs) ? globs : DEFAULT_EXCLUDE);
    }

    excluded(path) {
        if (this.excludeMatcher(path.replace(/\\/g, '/'))) return true;
        if (BINARY_EXTENSIONS.includes(nodePath.extname(path).toLowerCase())) return true;
        return TEMP_NAME_RE.test(nodePath.basename(path));
    }

    // ------------------------------------------------------------------------
    // User-edit mirroring
    // ------------------------------------------------------------------------
    /**
     * Mirror provably independent user edits into BOTH snapshots; overlap is an
     * explicit conflict, never an extra AI change or a permanent save latch.
     * The merge rules live in the data layer.
     */
    observeUserText(path, current) {
        const result = this.store.observeUserEdit(path, current);
        if (result.status === 'rebased' || result.status === 'conflict') this.bar?.refresh();
    }

    /** True when the editor text is still exactly the reviewed image. */
    reviewSnapshot(entry, document) {
        return !!entry
            && !entry.userTouched
            && !entry.beforeMissing
            && entry.kind !== 'delete'
            && !this.bomUnsupported(entry)
            && !document.isDirty
            && document.getText() === entry.after;
    }

    /** TextDocument omits the encoding BOM; never feed a disk preamble through
     * WorkspaceEdit or recreate it (Undo stays refused for BOM files). */
    bomUnsupported(entry, current) {
        return [entry?.before, entry?.after, current].some(
            text => typeof text === 'string' && text.startsWith('\uFEFF'),
        );
    }

    // ------------------------------------------------------------------------
    // Baseline cache (settled text, used only to notice unseen rewrites)
    // ------------------------------------------------------------------------
    documentSnapshot(document) {
        const text = document.getText();
        let fd;
        try {
            fd = nodeFs.openSync(document.uri.fsPath, 'r');
            const prefix = Buffer.alloc(3);
            const count = nodeFs.readSync(fd, prefix, 0, 3, 0);
            return count === 3 && prefix.equals(Buffer.from([0xef, 0xbb, 0xbf])) ? '\uFEFF' + text : text;
        } catch { return text; }
        finally { if (fd !== undefined) nodeFs.closeSync(fd); }
    }

    scheduleDocSettle(path) {
        const previous = this.docTimers.get(path);
        if (previous) clearTimeout(previous);
        this.docTimers.set(path, setTimeout(() => {
            this.docTimers.delete(path);
            void this.refreshSettled(path);
        }, DOC_SETTLE_MS));
    }

    async refreshSettled(path) {
        if (this.store.get(path) || this.store.isWriting(path)) return;
        const generation = this.settled.get(path);
        try {
            const document = this.findDocument(path);
            if (document && !document.isClosed) {
                this.settled.set(path, this.documentSnapshot(document));
                return;
            }
            const stat = await fsp.lstat(path);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
            const text = decodeReviewText(await fsp.readFile(path));
            if (text === null) return;
            if (!this.store.get(path) && !this.store.isWriting(path)
                && this.settled.get(path) === generation) this.settled.set(path, text);
        } catch {
            this.settled.delete(path);
        }
    }

    /** Bounded warm scan of the workspace: best effort, no AI attribution. */
    async warmScan() {
        const folders = vscode.workspace.workspaceFolders ?? [];
        this.observedDuringScan = new Set();
        let files = 0;
        let bytes = 0;
        try {
            for (const folder of folders) {
                const queue = [folder.uri.fsPath];
                while (queue.length > 0 && files < MAX_SCAN_FILES && bytes < MAX_SCAN_TOTAL) {
                    const directory = queue.shift();
                    let names;
                    try {
                        names = await fsp.readdir(directory, { withFileTypes: true });
                    } catch { continue; }
                    this.directoryInventory.set(directory, new Set(names.map(entry => entry.name)));
                    for (const entry of names) {
                        if (files >= MAX_SCAN_FILES || bytes >= MAX_SCAN_TOTAL) break;
                        const full = nodePath.join(directory, entry.name);
                        if (entry.isDirectory()) {
                            if (!isDirPrunable(entry.name) && !this.excluded(full)) queue.push(full);
                            continue;
                        }
                        if (!entry.isFile() || this.excluded(full)) continue;
                        try {
                            const stat = await fsp.stat(full);
                            if (stat.size > MAX_FILE_BYTES) continue;
                            const text = decodeReviewText(await fsp.readFile(full));
                            if (text === null) continue;
                            if (!this.observedDuringScan.has(full) && !this.settled.has(full) && !this.store.get(full)) {
                                this.settled.set(full, text);
                            }
                            files++;
                            bytes += stat.size;
                        } catch {
                            // unreadable file: skip silently
                        }
                    }
                }
            }
        } finally {
            this.observedDuringScan = null;
        }
    }

    async prepareSession() {
        await this.ready;
        if (!this.enabled()) return;
        for (const path of this.settled.keys()) {
            if (!this.store.get(path)) await this.refreshSettled(path);
        }
    }

    // ------------------------------------------------------------------------
    // Filesystem observation
    // ------------------------------------------------------------------------
    sessionActive() {
        return vscode.window.terminals.some(terminal =>
            this.trackedTerminals.has(terminal) || terminal.name === this.terminalName);
    }

    trackTerminal(terminal) {
        this.trackedTerminals.add(terminal);
    }

    pruneMarks(now) {
        for (const [path, mark] of this.selfMarks) if (mark.expires < now) this.selfMarks.delete(path);
        for (const [path, mark] of this.saveMarks) if (mark.expires < now) this.saveMarks.delete(path);
    }

    async onFsEvent(uri, kind) {
        if (this.disposed || !this.enabled() || !uri || uri.scheme !== 'file') return;
        this.observedDuringScan?.add(uri.fsPath);
        return this.withPath(uri.fsPath, () => this.processFsEvent(uri, kind));
    }

    async withPath(path, operation) {
        if (!path || this.closing) return;
        // One queue per FILE, not per spelling of the path: the ledger key and
        // the editor's fsPath may differ in drive-letter case on Windows.
        const key = canonicalPathKey(path);
        const previous = this.fileQueues.get(key) ?? this.ready ?? Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.fileQueues.set(key, next);
        try { return await next; }
        finally { if (this.fileQueues.get(key) === next) this.fileQueues.delete(key); }
    }

    async processFsEvent(uri, kind) {
        if (this.disposed || !this.enabled() || !uri || uri.scheme !== 'file') return;
        const path = uri.fsPath;
        if (this.excluded(path) || !vscode.workspace.getWorkspaceFolder(uri)) return;
        let after = null;
        try {
            const stat = await fsp.lstat(path);
            if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
            after = decodeReviewText(await fsp.readFile(path));
            if (after === null) return;
            // Atomic replace can report delete/create after the final path exists again.
            kind = this.settled.has(path) || this.store.get(path) ? 'change' : kind === 'create' ? 'create' : 'change';
        } catch (error) {
            if (error.code !== 'ENOENT') return;
            kind = 'delete';
        }
        if (kind === 'delete' && !this.settled.has(path) && !this.store.get(path)) return;
        this.pruneMarks(Date.now());
        const own = this.selfMarks.get(path);
        const save = this.saveMarks.get(path);
        // Shield only the exact content this extension wrote/saved itself.
        if ((own && own.text === after) || (save && save.text === after)) return;
        // An external filesystem event is not an AI tool transaction: never mint
        // an AI entry here. Mirror the change into an existing pending review.
        const existing = this.store.get(path);
        if (existing) {
            if (after === null && existing.kind !== 'delete') {
                // The reviewed file vanished outside a tool transaction: the
                // review is paused, never silently rewritten to an empty image.
                this.store.update(path, { userTouched: true, conflict: 'overlap-or-external' });
            }
            else if (after !== null && after !== existing.after) {
                this.observeUserText(path, after);
            }
        }
        else if (after === null) {
            this.settled.delete(path);
        } else {
            this.settled.set(path, after);
        }
        const inventory = this.directoryInventory.get(nodePath.dirname(path));
        if (after === null) inventory?.delete(nodePath.basename(path));
        else inventory?.add(nodePath.basename(path));
    }

    poll() {
        if (this.disposed || !this.enabled() || !this.sessionActive()) return;
        if (this.polling) return;
        this.polling = true;
        const paths = new Set(vscode.workspace.textDocuments
            .filter(document => document.uri.scheme === 'file' && !document.isClosed)
            .map(document => document.uri.fsPath));
        for (const entry of this.entries()) paths.add(entry.path);
        void Promise.all([...paths].slice(0, 200).map(path => this.onFsEvent(vscode.Uri.file(path), 'change')))
            .catch(error => console.error('[dsh-tui-vscode] Review poll failed:', error))
            .finally(() => { this.polling = false; });
    }

    // ------------------------------------------------------------------------
    // Persistence (the ledger survives a window reload)
    // ------------------------------------------------------------------------
    storeFile() {
        const base = this.context.storageUri;
        return base ? nodePath.join(base.fsPath, 'edit-review-pending.json') : null;
    }

    schedulePersist() {
        if (this.closing || this.disposed || !this.started) return;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            void this.flushState().catch(() => {});
        }, PERSIST_DEBOUNCE_MS);
    }

    flushState() {
        const file = this.storeFile();
        if (!file) return Promise.resolve();
        const state = JSON.stringify(this.store.toJSON());
        const next = this.persistence.then(async () => {
            await fsp.mkdir(nodePath.dirname(file), { recursive: true });
            const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
            try {
                await fsp.writeFile(temp, state, 'utf8');
                await fsp.rename(temp, file);
            } finally { await fsp.unlink(temp).catch(() => {}); }
        });
        this.persistence = next.catch(error => console.error('[dsh-tui-vscode] Review storage failed:', error));
        return next;
    }

    async loadState() {
        const file = this.storeFile();
        if (!file) return;
        try {
            const contents = await fsp.readFile(file, 'utf8');
            this.store.fromJSON(JSON.parse(contents));
            // Drop noise captured by older builds (outside the workspace,
            // excluded or unreviewable images): unreviewable by design.
            for (const entry of this.store.list()) {
                if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.path)) || this.excluded(entry.path)) {
                    this.store.remove(entry.path);
                }
            }
        }
        catch {
            // no previous state (or unreadable): start clean
        }
    }

    // ------------------------------------------------------------------------
    // UI refresh
    // ------------------------------------------------------------------------
    refreshAll() {
        if (this.disposed) return;
        if (!this.enabled()) {
            // The gate is off: no marks, no counter, no editor-title buttons
            // that would silently do nothing (author review 3.4-2).
            for (const editor of vscode.window.visibleTextEditors) this.clearEditorDecorations(editor);
            void vscode.commands.executeCommand('setContext', 'dshEditReview.activePending', false);
            void vscode.commands.executeCommand('setContext', 'dshEditReview.hasPending', false);
            this.pendingStatus.hide();
            return;
        }
        for (const editor of vscode.window.visibleTextEditors) this.decorateEditor(editor);
        const active = vscode.window.activeTextEditor;
        const path = active && active.document.uri.scheme === 'file' ? active.document.uri.fsPath : null;
        void vscode.commands.executeCommand('setContext', 'dshEditReview.activePending', !!(path && this.store.get(path)));
        const entries = this.entries();
        void vscode.commands.executeCommand('setContext', 'dshEditReview.hasPending', entries.length > 0);
        if (entries.length) {
            this.pendingStatus.text = vscode.l10n.t('$(diff) dsh: {0} pending', entries.length);
            this.pendingStatus.show();
        }
        else {
            this.pendingStatus.hide();
        }
    }

    /**
     * True while this document is one side of an open comparison tab. The
     * native diff already paints the change; drawing our own marks on top of
     * it would double the deletion marker.
     */
    isDiffEditor(editor) {
        const Diff = vscode.TabInputTextDiff;
        if (typeof Diff !== 'function') return false;
        const tabs = (vscode.window.tabGroups?.all ?? []).flatMap(group => group.tabs);
        const target = editor.document.uri.toString();
        return tabs.some(tab => tab.input instanceof Diff
            && (tab.input.modified.toString() === target || tab.input.original.toString() === target));
    }

    /**
     * Draw the plan: two green weights for live lines, darker green for the
     * changed elements, and one block marker where lines were deleted.
     */
    decorateEditor(editor) {
        if (!editor || editor.document.uri.scheme !== 'file') return;
        if (!this.enabled()) { this.clearEditorDecorations(editor); return; }
        const entry = this.store.get(editor.document.uri.fsPath);
        const plan = this.reviewSnapshot(entry, editor.document) && !this.isDiffEditor(editor)
            ? planInlineReview(entry, editor.document.getText(), MAX_DECORATED_HUNKS)
            : null;
        if (!plan) {
            this.clearEditorDecorations(editor);
            return;
        }
        const maxLine = Math.max(editor.document.lineCount - 1, 0);
        const clamp = line => Math.max(0, Math.min(line, maxLine));
        const added = [];
        const modified = [];
        const spans = [];
        const removed = [];
        const badges = [];
        for (const planned of plan.hunks) {
            const hover = this.hunkHover(entry, planned.change);
            if (planned.kind === 'removed') {
                const line = clamp(planned.line);
                // Zero-width: a file can end in an empty line, and a column
                // beyond the line length would drop the whole batch.
                const anchor = new vscode.Range(line, 0, line, 0);
                removed.push({ range: anchor, hoverMessage: hover });
                badges.push(deletedTextDecoration(anchor, removedBadge(planned.removedLines)));
                continue;
            }
            for (const line of planned.addedLines) {
                added.push({ range: new vscode.Range(clamp(line), 0, clamp(line), 0), hoverMessage: hover });
            }
            for (const line of planned.modifiedLines) {
                modified.push({ range: new vscode.Range(clamp(line), 0, clamp(line), 0), hoverMessage: hover });
            }
            for (const span of planned.spans) {
                const line = clamp(span.line);
                spans.push({ range: new vscode.Range(line, span.startCol, line, span.endCol), hoverMessage: hover });
            }
        }
        this.setSafe(editor, this.decor.added, added);
        this.setSafe(editor, this.decor.modified, modified);
        this.setSafe(editor, this.decor.span, spans);
        this.setSafe(editor, this.decor.removed, removed);
        this.setSafe(editor, this.decor.attachment, badges);
    }

    /** Remove every review mark from one editor (feature off / not reviewable). */
    clearEditorDecorations(editor) {
        if (!editor) return;
        for (const decoration of [this.decor.added, this.decor.modified, this.decor.span, this.decor.removed, this.decor.attachment]) {
            this.setSafe(editor, decoration, []);
        }
    }

    /** One bad decoration batch must never take the others down with it. */
    setSafe(editor, decoration, options) {
        try {
            editor.setDecorations(decoration, options);
        }
        catch (error) {
            console.error('[dsh-tui-vscode] edit-review decoration batch skipped:', error);
        }
    }
    // ------------------------------------------------------------------------
    // Hover / comparison
    // ------------------------------------------------------------------------
    hunkHover(entry, hunk) {
        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = { enabledCommands: TRUSTED_CMDS };
        const hint = precise.changeHint(entry, hunk);
        const source = entry.provenance === 'file-tool-v1' ? 'AI edit pending: {0}' : 'Source-unverified change: {0}';
        markdown.appendMarkdown(`**${vscode.l10n.t(source, formatCounts(hunk.added, hunk.removed))}**\n\n`);
        // Per-edit decisions: this change can be kept or undone without
        // touching the other edits in the file.
        markdown.appendMarkdown(
            `${cmdLink(KEEP_CMD, entry.path, vscode.l10n.t('Keep this change'), hint)} \u00b7 `
            + `${cmdLink(UNDO_CMD, entry.path, vscode.l10n.t('Undo this change'), hint)} \u00b7 `
            + `${cmdLink(DIFF_CMD, entry.path, vscode.l10n.t('Compare with original'))}`,
        );
        // The hover is a readable preview, not a view zone: VSCode gives an
        // extension no way to insert extra lines into a normal editor.
        if (hunk.removedTexts.length > 0) {
            markdown.appendMarkdown('\n\n');
            markdown.appendText(hunk.removedTexts.join(' \u23ce ').slice(0, 160));
        }
        return markdown;
    }

    provideOriginalContent(uri) {
        try {
            const params = new URLSearchParams(uri.query);
            const path = params.get('f') ?? '';
            const side = params.get('side') ?? 'before';
            const entry = this.store.get(path);
            if (side === 'after') return entry?.after ?? '';
            return entry?.before ?? '';
        }
        catch {
            return '';
        }
    }

    /**
     * Open the comparison view. NEVER called automatically: the reworked
     * display keeps the review in the editor body, and the diff tab is only a
     * deliberate action (the command palette, a tree button or a hover link).
     */
    showDiff(path, preserveFocus = false) {
        const entry = path ? this.store.get(path) : null;
        if (!path || !entry) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        if (entry.beforeMissing) return this.warn(vscode.l10n.t('Cannot compare: the pre-edit original was not captured.'));
        const query = `f=${encodeURIComponent(path)}`;
        const left = vscode.Uri.parse(`${SCHEME}:original?side=before&${query}`);
        // Right side is the real file while it exists, so the review tab shows
        // live content; for a deleted file both sides are virtual.
        const right = nodeFs.existsSync(path)
            ? vscode.Uri.file(path)
            : vscode.Uri.parse(`${SCHEME}:original?side=after&${query}`);
        const name = nodePath.basename(path);
        return vscode.commands.executeCommand('vscode.diff', left, right, vscode.l10n.t('Original \u2194 AI edit: {0}', name), { preview: true, preserveFocus })
            .then(() => this.alignDiffView(right));
    }

    /**
     * Review comparisons should LOOK like the VS Code diff the user asked for:
     * stacked red/green rows (inline view). `vscode.diff` cannot take a view
     * mode, so right after opening we align VS Code's own diff view mode with
     * the `diffEditor.setViewMode.*` command — the exact command behind the
     * diff editor's Inline View button. Delayed a beat so the editor exists.
     */
    alignDiffView(modified) {
        const mode = vscode.workspace.getConfiguration('dsh-tui-vscode').get('editReview.diffView', 'inline');
        if (mode !== 'inline' && mode !== 'sideBySide') return;
        setTimeout(() => {
            if (this.disposed || this.closing) return;
            try {
                const config = vscode.workspace.getConfiguration('diffEditor', modified);
                const current = config.get('renderSideBySide', true);
                const spaceLimited = config.get('useInlineViewWhenSpaceIsLimited', true);
                const settled = mode === 'inline' ? current === false : current === true && spaceLimited === false;
                if (settled) return;
                const command = mode === 'inline' ? 'diffEditor.setViewMode.inline' : 'diffEditor.setViewMode.sideBySide';
                void Promise.resolve(vscode.commands.executeCommand(command, modified)).catch(() => {});
            }
            catch {
                // Older hosts may not expose the diff view-mode commands; the
                // comparison still opens with VS Code's own default layout.
            }
        }, 350);
    }

    // ------------------------------------------------------------------------
    // Paths & safety
    // ------------------------------------------------------------------------
    resolvePath(target) {
        if (typeof target === 'string') return target;
        if (target instanceof vscode.Uri) return target.fsPath;
        if (target && typeof target === 'object') {
            if (typeof target.path === 'string' && !target.scheme) return target.path;
            if (target.resourceUri instanceof vscode.Uri) return target.resourceUri.fsPath;
        }
        const active = vscode.window.activeTextEditor;
        return active && active.document.uri.scheme === 'file' ? active.document.uri.fsPath : null;
    }

    workspaceRoots() {
        return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    }

    /** The data layer's path policy is the single authority for writes. */
    async assertSafePath(path) {
        const uri = vscode.Uri.file(path);
        if (!vscode.workspace.getWorkspaceFolder(uri) || this.excluded(path)) {
            throw Error(vscode.l10n.t('Review is restricted to workspace text files.'));
        }
        try {
            await assertInside(path, this.workspaceRoots());
        }
        catch (error) {
            throw Error(vscode.l10n.t('Review cannot write outside the workspace or through a link: {0}', String(error?.message ?? error)));
        }
    }

    findDocument(path) {
        const key = canonicalPathKey(path);
        return vscode.workspace.textDocuments.find(document =>
            document.uri.scheme === 'file' && !document.isClosed && canonicalPathKey(document.uri.fsPath) === key);
    }

    async readCurrent(path) {
        this.directoryInventory?.get(nodePath.dirname(path))?.add(nodePath.basename(path));
        const document = this.findDocument(path);
        if (document) return document.getText();
        try {
            return await fsp.readFile(path, 'utf8');
        }
        catch {
            return '';
        }
    }

    warn(message) {
        // Informational refusal is complete; a non-modal notification must not
        // hold the per-path decision/watcher queue until it is dismissed.
        void vscode.window.showWarningMessage(message);
    }

    staleWarning() {
        return this.warn(vscode.l10n.t('This control refers to an earlier review snapshot. Use the current AI Edits controls. If user edits overlap the change, save them and choose Keep current file or explicitly confirmed Undo file; no change was applied.'));
    }

    // ------------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------------
    async writeContent(path, text, expected) {
        // Always: the write target must be inside the workspace and must not be
        // a link, whether or not the caller supplied an expected image.
        await this.assertSafePath(path);
        this.store.markWriting(path);
        try { return await this.writeContentNow(path, text, expected); }
        finally { this.store.clearWriting(path); }
    }

    async writeContentNow(path, text, expected) {
        this.selfMarks.set(path, { expires: Date.now() + MARK_TTL_MS, text });
        const uri = vscode.Uri.file(path);
        const document = this.findDocument(path);
        if (expected !== undefined && expected !== null) {
            const disk = await fsp.readFile(path, 'utf8');
            if (disk !== expected || (document && (document.isDirty || document.getText() !== expected))) {
                throw Error(vscode.l10n.t('File changed during review. No restoration was applied.'));
            }
        }
        if (expected === null) {
            await fsp.writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
            if (!document || document.isClosed) { this.settled.set(path, text); return text; }
        }
        if (document) {
            const lastLine = Math.max(document.lineCount - 1, 0);
            const lastColumn = document.lineAt(lastLine).text.length;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(0, 0, lastLine, lastColumn), text);
            if (!await vscode.workspace.applyEdit(edit)) {
                throw Error(vscode.l10n.t('VS Code refused the edit; pending review was retained.'));
            }
            if (!await document.save()) {
                throw Error(vscode.l10n.t('The restored content could not be saved; pending review was retained.'));
            }
        }
        else {
            await fsp.writeFile(path, text, { encoding: 'utf8', flag: 'w' });
        }
        const actual = await fsp.readFile(path, 'utf8');
        if (actual !== text || (document && document.getText() !== text)) {
            const entry = this.store.get(path);
            if (entry) {
                this.store.update(path, { userTouched: true, conflict: 'save-participant' });
                this.store.setAfter(path, actual);
            }
            throw Error(vscode.l10n.t('Saving changed the file (possibly a save participant). Exact Undo did not complete; the original was retained and the current file requires review.'));
        }
        this.settled.set(path, text);
        return actual;
    }

    async applyPlan(entry, action, expected) {
        const path = entry.path;
        if (action === 'restore-content' || action === 'restore-file') {
            await this.writeContent(path, entry.before ?? '', expected);
        }
        else if (action === 'delete-file') {
            await this.assertSafePath(path);
            this.selfMarks.set(path, { expires: Date.now() + MARK_TTL_MS, text: null });
            if (expected !== undefined && await fsp.readFile(path, 'utf8') !== expected) {
                throw Error(vscode.l10n.t('File changed during review. Deletion was refused.'));
            }
            await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
            this.settled.delete(path);
        }
        this.store.remove(path);
        // The status message follows the ACTION: deleting a newly created file
        // is not "restoring the pre-edit original" (author review 3.4-5).
        const base = nodePath.basename(path);
        const message = action === 'delete-file'
            ? vscode.l10n.t('Undid {0}: removed the newly created file', base)
            : vscode.l10n.t('Undid {0}: restored the pre-edit original', base);
        vscode.window.setStatusBarMessage(message, 4000);
    }

    // ------------------------------------------------------------------------
    // Whole-file and per-hunk decisions
    // ------------------------------------------------------------------------
    async safeCurrent(entry) {
        if (this.bomUnsupported(entry) || entry.conflict === 'save-participant') return null;
        try { await this.assertSafePath(entry.path); } catch { return null; }
        const document = this.findDocument(entry.path);
        if (document?.isDirty) return null;
        try {
            const disk = await fsp.readFile(entry.path, 'utf8');
            if (this.store.get(entry.path) !== entry || disk !== entry.after) return null;
            if (document && this.documentSnapshot(document) !== disk) return null;
            if (entry.userTouched) this.store.update(entry.path, { userTouched: false, conflict: undefined });
            return disk;
        }
        catch {
            return null;
        }
    }

    async keepHunk(path, hint) {
        const entry = this.store.get(path);
        if (!entry || entry.beforeMissing) return this.staleWarning();
        const current = await this.safeCurrent(entry);
        if (current === null) return this.staleWarning();
        const plan = this.store.keepHunk(path, hint, current);
        if (plan.status !== 'kept') return this.staleWarning();
        if (plan.done) this.settled.set(path, current);
        this.bar?.refresh();
        vscode.window.setStatusBarMessage(vscode.l10n.t('Kept this change in {0}', nodePath.basename(path)), 3000);
    }

    async undoHunk(path, hint) {
        const entry = this.store.get(path);
        if (!entry || entry.beforeMissing) return this.staleWarning();
        const current = await this.safeCurrent(entry);
        if (current === null) return this.staleWarning();
        const plan = this.store.planHunkUndo(path, hint, current);
        if (plan.status !== 'planned') return this.staleWarning();
        let actual;
        try { actual = await this.writeContent(path, plan.text, current); }
        catch (error) { return this.warn(error.message); }
        // Publish what the editor/disk really contains (the store contract),
        // not the planned text: a save participant may have changed it.
        this.store.commitHunkUndo(path, actual);
        this.bar?.refresh();
        vscode.window.setStatusBarMessage(vscode.l10n.t('Undid this change in {0}', nodePath.basename(path)), 3000);
    }

    async decideLine(undo) {
        const editor = vscode.window.activeTextEditor;
        if (!this.enabled() || !editor || editor.document.uri.scheme !== 'file') return;
        const path = editor.document.uri.fsPath;
        const entry = this.store.get(path);
        if (!entry || entry.beforeMissing || entry.kind === 'delete') return;
        const current = await this.safeCurrent(entry);
        if (current === null) return this.staleWarning();
        const line = editor.selection.active.line;
        const changes = precise.reviewDiff(entry.before ?? '', current, true).hunks.filter(hunk => hunk.startLine === line);
        let change = changes[0];
        if (changes.length > 1) {
            const selected = await vscode.window.showQuickPick(
                changes.map((hunk, index) => ({
                    label: `${index + 1}: ${hunk.removedTexts[0] ?? vscode.l10n.t('(insertion)')} \u2192 ${hunk.addedTexts[0] ?? vscode.l10n.t('(deletion)')}`,
                    hunk,
                })),
                { title: vscode.l10n.t('Choose the individual line change') },
            );
            change = selected?.hunk;
        }
        if (!change) {
            return void vscode.window.showInformationMessage(vscode.l10n.t('No pending line change at the cursor. For deleted lines choose their surviving-line anchor.'));
        }
        const hint = precise.changeHint(entry, change, true);
        return this.withPath(path, () => undo ? this.undoHunk(path, hint) : this.keepHunk(path, hint));
    }

    async keep(target, hint) {
        if (!this.enabled()) return;
        const path = this.resolvePath(target);
        if (!path || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))) return;
        const fileHint = hint?.file ? hint : target?.reviewHint;
        if (fileHint) {
            if (!this.store.matchesFileHint(path, fileHint)) return this.staleWarning();
            hint = undefined;
        }
        if (hint) return this.keepHunk(path, hint);
        const entry = this.store.get(path);
        if (!entry) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        let current = null;
        let exists = true;
        try { current = await fsp.readFile(path, 'utf8'); }
        catch (error) {
            if (error.code !== 'ENOENT') return this.warn(error.message);
            exists = false;
        }
        const document = this.findDocument(path);
        // Keep never writes. A deletion review is accepted as long as the file
        // really is gone — a stale editor tab for the removed file must not
        // block it (author review 3.4-4).
        let modelMatches;
        if (entry.kind === 'delete') {
            modelMatches = !exists;
        }
        else {
            modelMatches = !document || (current !== null && (
                document.getText() === current
                || (current.startsWith('\uFEFF') && document.getText() === current.slice(1))));
        }
        if (document?.isDirty || !modelMatches) {
            return this.warn(vscode.l10n.t('Save or resolve editor changes before Keep. The pending review was retained.'));
        }
        // Whole-file Keep never writes. A conflicted (paused) review accepts the
        // current file as-is, so later/overlapping edits must not block it.
        if (!entry.userTouched && entry.kind !== 'delete' && current !== entry.after) return this.staleWarning();
        // The reads above yielded: a remove+record for the same path in that
        // window would have minted a NEW entry — never accept a review the
        // caller did not see.
        if (this.store.get(path) !== entry) return this.staleWarning();
        this.store.keep(path);
        if (!exists) this.settled.delete(path);
        else this.settled.set(path, current);
        vscode.window.setStatusBarMessage(vscode.l10n.t('Kept {0}', nodePath.basename(path)), 3000);
    }

    async undo(target, hint) {
        if (!this.enabled()) return;
        const path = this.resolvePath(target);
        if (!path || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))) return;
        const fileHint = hint?.file ? hint : target?.reviewHint;
        if (fileHint) {
            if (!this.store.matchesFileHint(path, fileHint)) return this.staleWarning();
            hint = undefined;
        }
        if (hint) return this.undoHunk(path, hint);
        const entry = this.store.get(path);
        if (!path || !entry) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        let currentExists = false;
        let currentText = null;
        try {
            currentText = await fsp.readFile(path, 'utf8');
            currentExists = true;
        }
        catch (error) {
            if (error.code !== 'ENOENT') return this.warn(error.message);
            currentExists = false;
        }
        if (this.bomUnsupported(entry, currentText)) {
            return this.warn(vscode.l10n.t('Undo for UTF-8 BOM files is not supported yet. No restoration was applied; use version control.'));
        }
        // A review whose images no longer match the disk goes to the
        // confirmation prompt below (planUndo), never to the stale warning:
        // the hint already proved this is the entry the button targets.
        const document = this.findDocument(path);
        if (document?.isDirty || (document && currentExists && document.getText() !== currentText)) {
            return this.warn(vscode.l10n.t('Save or resolve your editor changes before Undo. No user edits were overwritten.'));
        }
        const expectedAfter = entry.after;
        const expectedBefore = entry.before;
        const plan = this.store.planUndo(path, currentExists, currentText);
        if (!plan) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edit for this file'));
            return;
        }
        if (plan.action === 'drop') { this.store.remove(path); return; }
        if (plan.action === 'blocked') {
            return this.warn(vscode.l10n.t('The pre-edit original was not captured; Undo is unavailable. Use version control.'));
        }
        const action = plan.action === 'confirm' ? plan.fallback : plan.action;
        if (plan.action === 'confirm' || action === 'delete-file') {
            const label = vscode.l10n.t('Confirm Undo');
            const message = action === 'delete-file'
                ? vscode.l10n.t('Undo removes this newly created file (using the recycle bin when supported). Continue?')
                : vscode.l10n.t('The file changed after the captured edit. Restore the original and discard later disk changes?');
            if (await vscode.window.showWarningMessage(message, { modal: true }, label) !== label) return;
        }
        if (this.store.get(path) !== entry || entry.after !== expectedAfter || entry.before !== expectedBefore) {
            return this.staleWarning();
        }
        let latest = null;
        try { latest = await fsp.readFile(path, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') return this.warn(error.message); }
        if (latest !== currentText || document?.isDirty) return this.staleWarning();
        try { await this.applyPlan(entry, action, currentText); }
        catch (error) { return this.warn(error.message); }
    }

    async keepAll() {
        if (!this.enabled()) return;
        const paths = this.entries().map(entry => entry.path);
        if (paths.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edits'));
            return;
        }
        for (const path of paths) await this.withPath(path, () => this.keep(path));
    }

    async undoAll() {
        if (!this.enabled()) return;
        const paths = this.entries().map(entry => entry.path);
        if (paths.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('No pending AI edits'));
            return;
        }
        for (const path of paths) await this.withPath(path, () => this.undo(path));
    }

    // ---- navigation --------------------------------------------------------
    async gotoHunk(path, direction) {
        const entry = path ? this.store.get(path) : null;
        if (!path || !entry) return;
        const text = await this.readCurrent(path);
        const { hunks } = precise.reviewDiff(entry.before ?? '', text);
        if (hunks.length === 0) return;
        const current = this.cursor.get(path) ?? 0;
        const next = (((current + direction) % hunks.length) + hunks.length) % hunks.length;
        this.cursor.set(path, next);
        this.bar?.refresh();
        const target = hunks[next];
        let editor = vscode.window.visibleTextEditors.find(candidate => canonicalPathKey(candidate.document.uri.fsPath) === canonicalPathKey(path));
        if (!editor) editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false });
        const line = Math.max(0, Math.min(target.startLine, Math.max(editor.document.lineCount - 1, 0)));
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /** Sidebar / status-bar entry point: stay in the editor, do not open a tab. */
    async revealFirstHunk(path) {
        if (!path) return;
        const entry = this.store.get(path);
        if (!entry) return;
        // A deleted file has no live editor to jump into: the comparison is
        // the only meaningful "open" action for it.
        if (entry.kind === 'delete') return this.showDiff(path, true);
        this.cursor.set(path, 0);
        return this.gotoHunk(path, 0);
    }

    // ---- hints, tree -------------------------------------------------------
    fileHint(entry) {
        return this.store.fileHint(entry.path);
    }

    entries() {
        if (!this.enabled()) return [];
        return this.store.list().filter(entry =>
            !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.path)));
    }

    describe(entry) {
        if (entry.beforeMissing) return vscode.l10n.t('original not captured');
        const { addedLines, removedLines } = precise.reviewDiff(entry.before ?? '', entry.after ?? '');
        const warning = this.bomUnsupported(entry)
            ? ` \u00b7 ${vscode.l10n.t('BOM: Undo unavailable')}`
            : entry.userTouched
                ? ` \u00b7 ${vscode.l10n.t('overlapping/later edits: resolve first')}`
                : '';
        const provenance = entry.provenance === 'file-tool-v1' ? '' : ` \u00b7 ${vscode.l10n.t('source unverified')}`;
        const kind = entry.kind === 'create'
            ? ` ${vscode.l10n.t('new')}`
            : entry.kind === 'delete'
                ? ` ${vscode.l10n.t('deleted')}`
                : '';
        return `${formatCounts(addedLines, removedLines)}${kind}${warning}${provenance}`;
    }

    // ---- test seam ---------------------------------------------------------
    /**
     * Test-only surface consumed by the isolated extension-host suites (the
     * attribution layer is a later PR, so a host test needs a way to record an
     * already-verified change and to read the same ledger the UI reads).
     */
    testBridge() {
        return {
            ready: this.ready,
            store: this.store,
            enabled: () => this.enabled(),
            documentSnapshot: document => this.documentSnapshot(document),
            onFsEvent: (uri, kind) => this.onFsEvent(uri, kind),
            withPath: (path, operation) => this.withPath(path, operation),
            showDiff: (path, preserveFocus) => this.showDiff(path, preserveFocus),
            hunkHover: (entry, hunk) => this.hunkHover(entry, hunk),
            shutdown: () => this.shutdown(),
            flushState: () => this.flushState(),
            storeFile: () => this.storeFile(),
            trackTerminal: terminal => this.trackTerminal(terminal),
            prepareSession: () => this.prepareSession(),
            gotoHunk: (path, direction) => this.gotoHunk(path, direction),
            revealFirstHunk: path => this.revealFirstHunk(path),
        };
    }
}

/** Directory names the warm scan never enters (hidden dirs, caches, AppData). */
function isDirPrunable(name) {
    return name.startsWith('.') || name === 'node_modules' || name === '__pycache__' || name === 'AppData';
}

/** Sidebar tree: one row per pending file, click = jump to the first block. */
class PendingTreeProvider {
    constructor(owner) {
        this.owner = owner;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        owner.store.onChange(() => this.emitter.fire());
    }

    getTreeItem(entry) {
        const item = new vscode.TreeItem(nodePath.basename(entry.path));
        item.id = entry.path;
        item.description = this.owner.describe(entry);
        item.tooltip = `${entry.path}\n${this.owner.describe(entry)}`;
        item.contextValue = 'dshEdit';
        item.iconPath = new vscode.ThemeIcon(entry.kind === 'create' ? 'new-file' : entry.kind === 'delete' ? 'trash' : 'edit');
        item.command = { command: REVEAL_CMD, title: '', arguments: [entry.path] };
        return item;
    }

    getChildren() {
        return this.owner.entries().map(entry => ({ ...entry, reviewHint: this.owner.fileHint(entry) }));
    }

    dispose() {
        this.emitter.dispose();
    }
}

/**
 * The review bar: the plugin-level twin of Copilot's editor overlay (that
 * floating widget is core-internal and cannot be mounted by an extension).
 * Same shape and semantics: ▲▼ navigation across the edits of the file plus
 * Keep / Undo for the current block, docked as a CodeLens row on the first
 * line. No comparison tab is opened unless the user asks for it.
 */
class ReviewBarProvider {
    constructor(owner) {
        this.owner = owner;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this.emitter.event;
        owner.store.onChange(() => this.emitter.fire());
    }

    refresh() {
        this.emitter.fire();
    }

    provideCodeLenses(document) {
        if (!this.owner.enabled()) return [];
        const entry = this.owner.store.get(document.uri.fsPath);
        if (!entry) return [];
        if (!this.owner.reviewSnapshot(entry, document)) {
            const at = new vscode.Range(0, 0, 0, 0);
            // Say WHY the review is paused: a lost buffer, a deletion, a
            // missing original and a BOM file each need a different safe exit.
            let compareTitle;
            let offerKeep = false;
            if (entry.kind === 'delete') {
                compareTitle = vscode.l10n.t('File deleted \u00b7 Compare original');
                offerKeep = true;
            }
            else if (entry.beforeMissing) {
                compareTitle = vscode.l10n.t('Pre-edit original not captured \u00b7 Compare original');
                offerKeep = true;
            }
            else if (this.owner.bomUnsupported(entry)) {
                compareTitle = vscode.l10n.t('BOM: Undo unavailable \u00b7 Compare original');
                offerKeep = true;
            }
            else if (entry.userTouched) {
                compareTitle = vscode.l10n.t('Review paused: overlapping or later edits \u00b7 Compare original');
                offerKeep = true;
            }
            else {
                compareTitle = vscode.l10n.t('Review synchronizing \u00b7 Compare original');
            }
            const lenses = [new vscode.CodeLens(at, {
                title: compareTitle,
                command: DIFF_CMD,
                arguments: [entry.path],
            })];
            if (offerKeep) {
                // Whole-file Keep never writes: accepting the current file is the
                // safe way out of a review that cannot be edited per block.
                lenses.push(new vscode.CodeLens(at, {
                    title: `$(check) ${vscode.l10n.t('Keep (accept current file)')}`,
                    command: KEEP_CMD,
                    arguments: [entry.path, this.owner.fileHint(entry)],
                }));
            }
            return lenses;
        }
        const { hunks } = precise.reviewDiff(entry.before ?? '', entry.after);
        if (hunks.length === 0) return [];
        const path = entry.path;
        const current = Math.min(this.owner.cursor.get(path) ?? 0, hunks.length - 1);
        this.owner.cursor.set(path, current);
        const at = new vscode.Range(0, 0, 0, 0);
        const lens = (title, command, args, range = at) => new vscode.CodeLens(range, { title, command, arguments: args });
        const result = [
            lens('$(chevron-up)', PREV_CMD, [path]),
            lens('$(chevron-down)', NEXT_CMD, [path]),
            lens(`$(check-all) ${vscode.l10n.t('Keep file')}`, KEEP_CMD, [path, this.owner.fileHint(entry)]),
            lens(`$(undo) ${vscode.l10n.t('Undo file')}`, UNDO_CMD, [path, this.owner.fileHint(entry)]),
            lens(`$(compare) ${vscode.l10n.t('Compare with original')}`, DIFF_CMD, [path]),
        ];
        if (hunks.length > MAX_DECORATED_HUNKS) {
            // Beyond the painted cap the blocks have no marks and no per-block
            // buttons; say so instead of hiding them silently.
            result.push(lens(vscode.l10n.t('Only the first {0} blocks are shown \u00b7 Compare with original', MAX_DECORATED_HUNKS), DIFF_CMD, [path]));
        }
        for (const [index, hunk] of hunks.slice(0, MAX_DECORATED_HUNKS).entries()) {
            const line = Math.max(0, Math.min(hunk.startLine, document.lineCount - 1));
            const range = new vscode.Range(line, 0, line, 0);
            const hint = precise.changeHint(entry, hunk);
            result.push(
                lens(`${index + 1}/${hunks.length} \u00b7 ${formatCounts(hunk.added, hunk.removed)} \u00b7 ${vscode.l10n.t('Keep this change')}`, KEEP_CMD, [path, hint], range),
                lens(vscode.l10n.t('Undo this change'), UNDO_CMD, [path, hint], range),
            );
        }
        return result;
    }

    dispose() {
        this.emitter.dispose();
    }
}

exports.EditReview = EditReview;
