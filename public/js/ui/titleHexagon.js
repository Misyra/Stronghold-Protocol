// Title diagram geometry: scale the triangle first, then clip each corner. Shrinking a pre-clipped polygon would
// shrink its short edges too, hiding the clipped apex on partial tiles. Both the gray and teal layers use this path.
const CENTER = [230, 177];

/** Clockwise from the top, independently of config ordering. @type {Array<[string, number[][]]>} */
export const TITLE_HEX_SECTORS = [
	['comment_4', [CENTER, [165, 65], [295, 65]]],
	['comment_5', [CENTER, [295, 65], [360, 177]]],
	['comment_6', [CENTER, [360, 177], [295, 289]]],
	['comment_1', [CENTER, [295, 289], [165, 289]]],
	['comment_2', [CENTER, [165, 289], [100, 177]]],
	['comment_3', [CENTER, [100, 177], [165, 65]]],
];

/**
 * Six points with cuts of 5% of the original edge length, even when the tile is partial. For very small tiles,
 * cap each cut at a quarter of the remaining edge so the six-sided shape stays valid. Zero draws no teal tile.
 * @param {number[][]} vertices
 * @param {number} count
 * @returns {string|null}
 */
export function titleSectorPoints(vertices, count = 20) {
	const scale = Math.min(1, Math.max(0, count) / 20);
	if (!(scale > 0)) return null;
	const cut = Math.min(.05 / scale, .25);
	const scaled = vertices.map(([x, y]) => [CENTER[0] + (x - CENTER[0]) * scale, CENTER[1] + (y - CENTER[1]) * scale]);
	return scaled.flatMap(([x, y], i) => [scaled[(i + 2) % 3], scaled[(i + 1) % 3]].map(([nx, ny]) =>
		`${Number((x + (nx - x) * cut).toFixed(4))},${Number((y + (ny - y) * cut).toFixed(4))}`)).join(' ');
}
