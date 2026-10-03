/** Fixed Simulation dt, separately adjustable real-time scheduling. No import side effects. */
export function createLoop({ session, getInput = () => new Uint8Array(session.inputSize), render = () => {},
  beforeFrame = () => {}, canAdvance = () => true, onAdvance = () => {},
  onError = error => { throw error; }, onInputRelease = () => {}, requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) } = {}) {
  if (!session || typeof session.poll !== 'function' || typeof session.advance !== 'function') throw new TypeError('session capability');
  for (const callback of [getInput, render, beforeFrame, canAdvance, onAdvance, onError, onInputRelease]) {
    if (typeof callback !== 'function') throw new TypeError('loop callback');
  }
  const quantum = 1000 / session.profile.tickRate;
  let running = false, handle, last, accumulator = 0;
  const resetTiming = () => { last = undefined; accumulator = 0; };
  const release = () => {
    try { onInputRelease(); session.releaseInput(); }
    catch (error) { stop(); onError(error); }
  };
  const hidden = () => { if (globalThis.document?.hidden) { release(); resetTiming(); } };
  const stop = () => {
    running = false; if (handle !== undefined) cancelFrame?.(handle); handle = undefined;
    globalThis.removeEventListener?.('blur', release);
    globalThis.document?.removeEventListener('visibilitychange', hidden);
  };
  const pulse = timestamp => {
    try {
      if (!Number.isFinite(timestamp)) throw new TypeError('frame timestamp');
      beforeFrame(timestamp);
      if (last === undefined) last = timestamp;
      accumulator = Math.min(accumulator + Math.max(0, Math.min(250, timestamp - last)), quantum * session.profile.maxCatchupSteps);
      last = timestamp; session.poll();
      let work = 0;
      while (!session.closed && !session.resimulating && accumulator >= quantum * session.metrics.pace && work < session.profile.maxCatchupSteps) {
        if (!canAdvance()) { accumulator = Math.min(accumulator, quantum); break; }
        const pace = session.metrics.pace;
        const result = session.advance(getInput()); work++;
        if (result.status === 'advanced') accumulator = Math.max(0, accumulator - quantum * pace);
        else accumulator = Math.min(accumulator, quantum);
        onAdvance(result);
        if (result.status !== 'advanced') { accumulator = Math.min(accumulator, quantum); break; }
      }
      // Rendering continues when the session is waiting for input or connection recovery.
      render({ session, alpha: Math.min(1, accumulator / quantum), resimulating: session.resimulating });
    } catch (error) { stop(); onError(error); }
  };
  const frame = timestamp => {
    if (!running) return;
    pulse(timestamp);
    if (running) handle = requestFrame(frame);
  };
  const start = () => {
    if (running) return;
    if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') throw new TypeError('frame scheduler');
    running = true; resetTiming();
    globalThis.addEventListener?.('blur', release);
    globalThis.document?.addEventListener('visibilitychange', hidden);
    handle = requestFrame(frame);
  };
  return { start, stop, pulse, resetTiming, get running() { return running; } };
}
