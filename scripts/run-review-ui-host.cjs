'use strict';
// Isolated visual host for the review display: stages the extension, launches a
// real VS Code with an isolated profile and wires the CDP observer that
// captures one screenshot per phase. Never installs or downloads anything:
// VSCODE_EXECUTABLE must point at an existing Code.exe.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const base = process.env.DSH_REVIEW_ARTIFACT_ROOT;
if (!base) throw Error('Set DSH_REVIEW_ARTIFACT_ROOT to an isolated authorized directory');
const executable = process.env.VSCODE_EXECUTABLE;
if (!executable || !fs.existsSync(executable)) throw Error('Set VSCODE_EXECUTABLE; no download/install');
const port = Number(process.env.DSH_REVIEW_CDP_PORT || 9239);
const stage = path.join(base, 'dev-extension');
const workspace = path.join(base, 'workspace');
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
// A previous run leaves its result/marker behind; the observer must not read a
// stale "passed" before the new host has written anything.
for (const stale of ['ui-result.json', 'visual-next.json']) fs.rmSync(path.join(workspace, stale), { force: true });
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
for (const item of ['out', 'media', 'l10n', 'node_modules', 'package.nls.json', 'package.nls.zh-cn.json']) {
    const source = path.join(repo, item);
    const target = path.join(stage, item);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    // The vscode module maps a require() caller back to an extension by its
    // path prefix. A junction for out/ makes the caller path point outside the
    // extension, and proposed APIs are then rejected as nullExtensionDescription.
    if (item === 'out' || item === 'media' || item === 'l10n') {
        fs.cpSync(source, target, { recursive: true });
    } else if (fs.statSync(source).isDirectory()) {
        fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
        fs.copyFileSync(source, target);
    }
}
fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'dsh-tui-vscode.editReview.enabled': true,
    'dsh-tui-vscode.editReview.exclude': ['**/.vscode/**', '**/*result.json', '**/visual-next.json'],
    'window.title': 'DSH Review UI Test',
    'workbench.colorTheme': 'Default Dark+',
    'telemetry.telemetryLevel': 'off',
}));
const args = [
    workspace,
    '--new-window', '--skip-welcome', '--skip-release-notes',
    '--disable-workspace-trust', '--disable-updates', '--no-sandbox', '--disable-gpu-sandbox',
    `--user-data-dir=${path.join(base, 'user-data')}`,
    `--extensions-dir=${path.join(base, 'extensions')}`,
    '--disable-extension=github.copilot-chat',
    '--disable-extension=vscode.github-authentication',
    '--enable-proposed-api', 'baobaolaodie.dsh-tui-vscode',
    '--enable-proposed-api', 'nullExtensionDescription',
    `--extensionDevelopmentPath=${stage}`,
    `--extensionTestsPath=${path.join(repo, 'out/review-ui-host-test.js')}`,
    `--remote-debugging-port=${port}`,
];
const env = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[key]) env[key] = process.env[key];
if (process.env.DSH_REVIEW_VISUAL_HANDSHAKE) env.DSH_REVIEW_VISUAL_HANDSHAKE = '1';
const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const fd = fs.openSync(path.join(base, 'host.log'), 'a');
for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => { fs.writeSync(fd, data); process.stdout.write(data); });
}
fs.writeFileSync(path.join(base, 'process.json'), JSON.stringify({ pid: child.pid, args, port }));
fs.writeFileSync(path.join(base, 'run-meta.json'), JSON.stringify({
    head: execGit(['rev-parse', 'HEAD']),
    status: execGit(['status', '--porcelain']),
    builtAt: fs.statSync(path.join(repo, 'out', 'extension.js')).mtime.toISOString(),
    node: process.version,
    executable,
}, null, 2));
function execGit(argv) {
    try {
        return require('node:child_process').execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim();
    } catch { return ''; }
}
let visualError;
if (env.DSH_REVIEW_VISUAL_HANDSHAKE) {
    require('./stable-review-ui-observer.cjs').observeStableUi(base, port)
        .catch(error => {
            visualError = error;
            console.error(error);
            fs.writeFileSync(path.join(base, 'visual-error.txt'), error.stack || String(error));
        });
}
const timer = setTimeout(() => {
    console.error('Isolated UI host exceeded 180 seconds; terminating its process tree');
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
}, 180000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
    clearTimeout(timer);
    fs.closeSync(fd);
    let result;
    try {
        result = JSON.parse(fs.readFileSync(path.join(workspace, 'ui-result.json'), 'utf8'));
    } catch { }
    console.log(JSON.stringify({ code, signal, result }));
    process.exitCode = code === 0 && result?.status === 'passed' && !visualError ? 0 : 1;
});
