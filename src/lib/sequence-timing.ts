/** Minimum delays from the previous confirmed SMTP send (backend migration 040). */
export const followupTiming = [3, 7, 7, 14, 14].map((days, index) => {
  const previous = index === 0 ? "J0" : `R${index}`;
  return { step: `R${index + 1}`, days, previous, label: `+${days} j après ${previous}` };
});
