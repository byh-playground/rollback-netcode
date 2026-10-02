/** Fixed Simulation dt, separately adjustable real-time scheduling. No import side effects. */
export function createLoop({ session, getInput = () => new Uint8Array(session.inputSize), render = () => {},
  onError = error => { throw error; }, onInputRelease = () => {}, requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) } = {}) {
  if (!session || typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') throw new TypeError('session and frame scheduler');
  const quantum = 1000 / session.profile.tickRate;
  let running = false, handle, last, accumulator = 0;
  const release = () => {
    try { onInputRelease(); session.releaseInput(); }
    catch (error) { stop(); onError(error); }
  };
  const hidden = () => { if (globalThis.document?.hidden) { release(); last = undefined; accumulator = 0; } };
  const stop = () => {
    running = false; cancelFrame(handle);
    globalThis.removeEventListener?.('blur', release);
    globalThis.document?.removeEventListener('visibilitychange', hidden);
  };
  const frame = timestamp => {
    if (!running) return;
    try {
      if (last === undefined) last = timestamp;
      accumulator = Math.min(accumulator + Math.max(0, Math.min(250, timestamp - last)), quantum * session.profile.maxCatchupSteps);
      last = timestamp; session.poll();
      let work = 0;
      while (!session.resimulating && accumulator >= quantum * session.metrics.pace && work < session.profile.maxCatchupSteps) {
        const result = session.advance(getInput()); work++;
        if (result.status !== 'advanced') { accumulator = Math.min(accumulator, quantum); break; }
        accumulator -= quantum * session.metrics.pace;
      }
      // Rendering continues on holds. During a budgeted replay, retain the prior render bridge.
      render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
      handle = requestFrame(frame);
    } catch (error) { stop(); onError(error); }
  };
  const start = () => {
    if (running) return;
    running = true; last = undefined; accumulator = 0;
    globalThis.addEventListener?.('blur', release);
    globalThis.document?.addEventListener('visibilitychange', hidden);
    handle = requestFrame(frame);
  };
  return { start, stop, get running() { return running; } };
}
