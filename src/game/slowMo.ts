// Slow-mo affects the music side of the clock only: asteroid motion,
// beatTime, and bass audio all step at SLOW_MO_FACTOR speed while the
// player, bullets and fire cooldown keep real-time speed. Reads more as
// "bullet time" advantage than a global pause.
export const SLOW_MO_DURATION = 24;
export const SLOW_MO_FACTOR = 0.2;

// Compute the music-clock delta for this frame, given the wall-clock dt
// and the remaining slow-mo timer. Doesn't decrement the timer — caller
// owns its lifetime so slow-mo's lifespan isn't shortened by its own effect.
export const musicDtForFrame = (dt: number, slowMoTimer: number): number =>
  slowMoTimer > 0 ? dt * SLOW_MO_FACTOR : dt;
