// Run inside the game window when GRIMALKIN_SELFTEST is set. Starts a game,
// exercises both renderers, and reports what happened back to the shell.
(async () => {
    const log = (m) => window.__TAURI_INTERNALS__.invoke('selftest_log', { message: String(m) }).catch(() => {});
    log('script running, GAME=' + typeof window.GAME + ', visibility=' + document.visibilityState);
    const errors = [];
    addEventListener('error', (e) => errors.push(String(e.message)));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // A hidden window (locked screen, minimised) gets no animation frames, so
    // only loading and engine creation can be checked there.
    const visible = document.visibilityState === 'visible';
    const out = { ok: false, visible, errors, userAgent: navigator.userAgent };
    try {
        const G = window.GAME;
        G.startGame();
        const modes = [];
        for (let i = 0; i < 2; i++) {
            await wait(2500);
            const canvas = G.currentMode === 'MODE_RETRO' ? G.retroCanvas : G.neoCanvas;
            let litPixels = -1;                       // -1 = could not sample
            try {
                await Promise.race([new Promise((r) => requestAnimationFrame(r)), wait(1500)]);
                const t = document.createElement('canvas');
                t.width = t.height = 64;
                const x = t.getContext('2d');
                x.drawImage(canvas, 0, 0, 64, 64);
                const d = x.getImageData(0, 0, 64, 64).data;
                litPixels = 0;
                for (let p = 0; p < d.length; p += 4) if (d[p] + d[p + 1] + d[p + 2] > 40) litPixels++;
            } catch (e) { /* sampling is best effort */ }
            log('sampled ' + G.currentMode + ' fps=' + Math.round(G.fps));
            modes.push({
                mode: G.currentMode, fps: Math.round(G.fps), engine: !!G.activeEngine,
                state: G.state.current, time: +G.frame.time.toFixed(1), litPixels,
            });
            G.toggleMode();
        }
        out.modes = modes;
        out.ok = errors.length === 0 && modes[0].mode !== modes[1].mode
            && modes.every((m) => m.engine && (!visible || (m.time > 0 && m.litPixels !== 0)));
        // fps is reported, not judged: software rendering in a build container is slow.
        if (!visible) out.note = 'window hidden: frames not rendered, fps and pixels not checked';
    } catch (e) {
        errors.push(String(e));
    }
    window.__TAURI_INTERNALS__.invoke('selftest_report', { report: JSON.stringify(out) });
})();
