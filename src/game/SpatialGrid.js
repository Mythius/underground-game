/**
 * Uniform grid for broad-phase collision and area-of-interest queries.
 * Rebuilt every tick; entities need `x`, `y`, `radius`.
 */
export class SpatialGrid {
  constructor(width, height, cellSize) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.cells = new Map();
  }

  clear() {
    this.cells.clear();
  }

  #cellIndex(col, row) {
    return row * this.cols + col;
  }

  #colOf(x) {
    return Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
  }

  #rowOf(y) {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
  }

  insert(entity) {
    const r = entity.radius ?? 0;
    const c0 = this.#colOf(entity.x - r);
    const c1 = this.#colOf(entity.x + r);
    const r0 = this.#rowOf(entity.y - r);
    const r1 = this.#rowOf(entity.y + r);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const key = this.#cellIndex(col, row);
        let bucket = this.cells.get(key);
        if (!bucket) this.cells.set(key, (bucket = []));
        bucket.push(entity);
      }
    }
  }

  /** All entities whose cells overlap the box around (x, y) with half-size `range`. */
  query(x, y, range, out = new Set()) {
    const c0 = this.#colOf(x - range);
    const c1 = this.#colOf(x + range);
    const r0 = this.#rowOf(y - range);
    const r1 = this.#rowOf(y + range);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const bucket = this.cells.get(this.#cellIndex(col, row));
        if (bucket) for (const e of bucket) out.add(e);
      }
    }
    return out;
  }
}
