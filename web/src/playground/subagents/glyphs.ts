/** A 3×5 dot font for monograms and counts: each glyph is five rows of three cells. */
const FONT: Record<string, string> = {
	A: '010101111101101',
	B: '110101110101110',
	C: '011100100100011',
	D: '110101101101110',
	E: '111100110100111',
	F: '111100110100100',
	G: '011100101101011',
	H: '101101111101101',
	I: '111010010010111',
	J: '001001001101010',
	K: '101101110101101',
	L: '100100100100111',
	M: '101111111101101',
	N: '110101101101101',
	O: '010101101101010',
	P: '110101110100100',
	Q: '010101101110011',
	R: '110101110101101',
	S: '011100010001110',
	T: '111010010010010',
	U: '101101101101111',
	V: '101101101101010',
	W: '101101111111101',
	X: '101101010101101',
	Y: '101101010010010',
	Z: '111001010100111',
	'0': '111101101101111',
	'1': '010110010010111',
	'2': '110001010100111',
	'3': '110001010001110',
	'4': '101101111001001',
	'5': '111100110001110',
	'6': '011100111101111',
	'7': '111001010010010',
	'8': '111101111101111',
	'9': '111101111001110',
	'?': '110001010000010',
	'+': '000010111010000',
}

/** Whether the glyph for `ch` lights cell (x, y), 0 ≤ x < 3, 0 ≤ y < 5. */
export function glyphCell(ch: string, x: number, y: number) {
	const g = FONT[ch.toUpperCase()]
	return !!g && x >= 0 && x < 3 && y >= 0 && y < 5 && g[y * 3 + x] === '1'
}

/** Whether a string of glyphs (3 cells wide, 1 apart) lights cell (x, y). */
export function textCell(text: string, x: number, y: number) {
	if (x < 0) return false
	const i = Math.floor(x / 4)
	return i < text.length && x % 4 < 3 && glyphCell(text[i], x % 4, y)
}

/** Cells wide a string of glyphs takes. */
export const textCols = (text: string) => Math.max(0, text.length * 4 - 1)
