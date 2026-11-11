'use strict';
/**
 * CDP observer for the review visual host.
 *
 * The host script (src/review-ui-host-test.js) writes a phase into
 * workspace/ui-result.json and waits for workspace/visual-next.json. For every
 * new phase this observer takes a real screenshot through the Chrome DevTools
 * Protocol, dumps a small DOM snapshot (theme + every visible CodeLens label +
 * the editor line count) next to it, then releases the host.
 *
 * Two phases are click phases rather than screenshot phases: the observer finds
 * the generated CodeLens link and dispatches a real mouse press/release, so the
 * suite exercises the same controls a user clicks.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const json = url => new Promise((resolve, reject) => http.get(url, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
}).on('error', reject));

const SCREENSHOT_PHASES = new Set([
    'inline-dark', 'inline-light', 'inline-contrast',
    'sidebar-dark', 'paused-light', 'compare-dark',
]);
const CLICK_PHASES = new Map([
    ['click-keep-first', 'Keep this change'],
    ['click-undo-second', 'Undo this change'],
]);

async function observeStableUi(base, port) {
    let socket;
    let sequence = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
    for (let attempt = 0; attempt < 150; attempt++) {
        try {
            const targets = await json(`http://127.0.0.1:${port}/json/list`);
            const page = targets.find(target => target.type === 'page' && /workbench/.test(target.url));
            if (page) {
                socket = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
                socket.on('message', raw => {
                    const message = JSON.parse(String(raw));
                    const handler = pending.get(message.id);
                    if (!handler) return;
                    pending.delete(message.id);
                    message.error ? handler.reject(Error(message.error.message)) : handler.resolve(message.result);
                });
                break;
            }
        } catch { /* renderer not up yet */ }
        await sleep(200);
    }
    if (!socket) throw Error('renderer unavailable');
    const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true })
        .then(result => result.result.value);
    const seen = new Set();
    const resultFile = path.join(base, 'workspace', 'ui-result.json');
    const marker = path.join(base, 'workspace', 'visual-next.json');
    try {
        for (let tick = 0; tick < 1200; tick++) {
            let result;
            try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); }
            catch { /* not written yet */ }
            if (result?.status === 'failed') throw Error(result.error);
            if (result?.status === 'passed') return;
            const phase = result?.phase;
            if (!phase || seen.has(phase)) {
                await sleep(150);
                continue;
            }
            if (SCREENSHOT_PHASES.has(phase)) {
                const snapshot = await evaluate(`(()=>{
                    const lenses = [...document.querySelectorAll('.codelens-decoration a')].map(a=>a.textContent).filter(Boolean);
                    const editor = document.querySelector('.monaco-editor');
                    const workbench = document.querySelector('.monaco-workbench');
                    return {
                        theme: workbench ? workbench.className : '',
                        codeLenses: lenses,
                        editorPresent: !!editor,
                        visibleLines: editor ? [...editor.querySelectorAll('.view-line')].filter(e=>{const b=e.getBoundingClientRect();return b.height>0;}).length : 0,
                    };
                })()`);
                fs.mkdirSync(path.join(base, 'screenshots'), { recursive: true });
                fs.writeFileSync(path.join(base, 'screenshots', `${phase}.json`), JSON.stringify(snapshot, null, 2));
                const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                fs.writeFileSync(path.join(base, 'screenshots', `${phase}.png`), Buffer.from(image.data, 'base64'));
                seen.add(phase);
                fs.writeFileSync(marker, '{}');
                continue;
            }
            if (CLICK_PHASES.has(phase)) {
                await sleep(400);
                const label = CLICK_PHASES.get(phase);
                const point = await evaluate(`(()=>{
                    const links = [...document.querySelectorAll('.codelens-decoration a')];
                    const target = links.find(link => link.textContent.includes(${JSON.stringify(label)}));
                    if (!target) return null;
                    const box = target.getBoundingClientRect();
                    return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: target.textContent };
                })()`);
                if (!point) throw Error(`${phase}: CodeLens control "${label}" not found`);
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
                await sleep(600);
                fs.writeFileSync(path.join(base, phase + '.json'), JSON.stringify(point));
                seen.add(phase);
                fs.writeFileSync(marker, '{}');
                continue;
            }
            await sleep(150);
        }
        throw Error('visual host timeout');
    }
    finally {
        socket.close();
    }
}

module.exports = { observeStableUi };
