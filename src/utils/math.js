export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const distSq = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const randRange = (min, max) => min + Math.random() * (max - min);

export const round1 = (v) => Math.round(v * 10) / 10;
