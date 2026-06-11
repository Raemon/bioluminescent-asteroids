// Comma-groups a score for display: 10000 -> "10,000". Deliberately not
//   toLocaleString so every player sees the same grouping regardless of locale.
export const formatScore = (n: number): string =>
  String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Padded variant keeps the HUD's fixed 6-digit arcade width: 10000 -> "010,000".
export const formatScorePadded = (n: number): string =>
  String(n).padStart(6, "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
