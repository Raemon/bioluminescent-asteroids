// Coarse "is this a touch-first device?" check used to decide whether to
//   render on-screen controls and to swap calibration prompts away from
//   "tap space" wording. The combined media-query catches phones/tablets
//   while ignoring laptops with touchscreens that still have a precise
//   pointer + hover.
export const isTouchDevice = (): boolean => {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;
};
